import { describe, expect, test } from "bun:test";
import {
  ImportPartitionFloorError,
  discoverImportPartition,
  type ImportPartitionResult,
} from "../src/index.ts";

const encoder = new TextEncoder();

describe("import partition discovery", () => {
  test("returns the whole input when the oracle accepts it", async () => {
    const source = encoder.encode("whole input\n\nis accepted");
    const attempts: Uint8Array[] = [];

    const result = await discoverImportPartition(source, async (piece) => {
      attempts.push(piece);
      return true;
    });

    expect(attempts).toHaveLength(1);
    expect(result.parts.map(partRange)).toEqual([[0, source.byteLength]]);
    expect(result.attemptTree).toEqual({
      startOffset: 0,
      endOffset: source.byteLength,
      byteSize: source.byteLength,
      outcome: "accepted",
    });
    expectConcatenatesTo(result, source);
  });

  test("splits once at the paragraph boundary nearest the midpoint", async () => {
    const source = encoder.encode(`${"a".repeat(2_500)}\n\n${"b".repeat(2_700)}`);
    let calls = 0;

    const result = await discoverImportPartition(source, async () => ++calls > 1);

    expect(calls).toBe(3);
    expect(result.parts.map(partRange)).toEqual([
      [0, 2_502],
      [2_502, source.byteLength],
    ]);
    expect(result.attemptTree.outcome).toBe("rejected");
    expect(result.attemptTree.children?.map((attempt) => attempt.outcome)).toEqual([
      "accepted",
      "accepted",
    ]);
    expectConcatenatesTo(result, source);
  });

  test("recurses in order through an observed fail-fail-heal pattern", async () => {
    const sections = ["a", "b", "c", "d"].map((letter) => letter.repeat(2_500));
    const source = encoder.encode(sections.join("\n\n"));
    const attemptedInitialBytes: number[] = [];

    const result = await discoverImportPartition(source, async (piece) => {
      attemptedInitialBytes.push(piece[0]!);
      return piece.byteLength < 5_000 || piece[0] === "c".charCodeAt(0);
    });

    expect(attemptedInitialBytes).toEqual([
      "a".charCodeAt(0),
      "a".charCodeAt(0),
      "a".charCodeAt(0),
      "b".charCodeAt(0),
      "c".charCodeAt(0),
    ]);
    expect(result.parts.map(partRange)).toEqual([
      [0, 2_502],
      [2_502, 5_004],
      [5_004, source.byteLength],
    ]);
    expect(result.attemptTree.children?.[0].outcome).toBe("rejected");
    expect(result.attemptTree.children?.[0].children?.map((attempt) => attempt.outcome)).toEqual([
      "accepted",
      "accepted",
    ]);
    expectConcatenatesTo(result, source);
  });

  test("throws a typed content-free error with offsets when a sub-floor piece rejects", async () => {
    const source = encoder.encode(`${"a".repeat(2_500)}\n\n${"b".repeat(1_500)}`);

    try {
      await discoverImportPartition(
        source,
        async (piece) => piece.byteLength < source.byteLength && piece[0] === "a".charCodeAt(0),
      );
      throw new Error("expected partition discovery to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ImportPartitionFloorError);
      const floorError = error as ImportPartitionFloorError;
      expect(floorError.code).toBe("import_partition_floor_rejected");
      expect([floorError.startOffset, floorError.endOffset]).toEqual([2_502, source.byteLength]);
      expect(floorError.message).not.toContain("b".repeat(20));
    }
  });

  test("chooses deterministic split points for identical oracle verdicts", async () => {
    const source = encoder.encode(`${"a".repeat(2_398)}\n\n${"b".repeat(98)}\n\n${"c".repeat(2_398)}`);
    const oracle = async (piece: Uint8Array) => piece.byteLength < source.byteLength;

    const first = await discoverImportPartition(source, oracle);
    const second = await discoverImportPartition(source, oracle);

    expect(first.parts.map(partRange)).toEqual(second.parts.map(partRange));
    expect(first.attemptTree).toEqual(second.attemptTree);
    expect(first.parts[0]!.endOffset).toBe(2_400);
    expectConcatenatesTo(first, source);
    expectConcatenatesTo(second, source);
  });

  test("falls back from paragraphs to newlines and then the byte midpoint", async () => {
    const newlineSource = encoder.encode(`${"a".repeat(2_499)}\n${"b".repeat(2_500)}`);
    const midpointSource = encoder.encode("x".repeat(5_001));
    const acceptChildren = (sourceLength: number) => async (piece: Uint8Array) => piece.byteLength < sourceLength;

    const newline = await discoverImportPartition(newlineSource, acceptChildren(newlineSource.byteLength));
    const midpoint = await discoverImportPartition(midpointSource, acceptChildren(midpointSource.byteLength));

    expect(newline.parts.map(partRange)).toEqual([[0, 2_500], [2_500, 5_000]]);
    expect(midpoint.parts.map(partRange)).toEqual([[0, 2_500], [2_500, 5_001]]);
    expectConcatenatesTo(newline, newlineSource);
    expectConcatenatesTo(midpoint, midpointSource);
  });

  test("never creates a separator-only or degenerate side when a content boundary exists", async () => {
    // Models the observed live case: real content, then a fence-wall run with
    // a paragraph break near the end that would leave a lone-newline side.
    const source = encoder.encode(
      `${"real content here. ".repeat(300)}\n\n${"words ".repeat(200)}${":".repeat(600)}\n\n\n`,
    );
    const oracle = async (piece: Uint8Array) => piece.byteLength < source.byteLength;

    const result = await discoverImportPartition(source, oracle);

    for (const part of result.parts) {
      expect(part.endOffset - part.startOffset).toBeGreaterThan(1);
      const text = new TextDecoder().decode(part.bytes);
      expect(text.replace(/[\s\-:=*_#>`]/g, "").length).toBeGreaterThan(0);
    }
    expectConcatenatesTo(result, source);
  });

  test("balances split sides when nearer boundaries would be lopsided", async () => {
    const source = encoder.encode(`${"a".repeat(4_000)}\n\n${"b".repeat(80)}\n\n${"c".repeat(20)}`);
    const oracle = async (piece: Uint8Array) => piece.byteLength < source.byteLength;

    const result = await discoverImportPartition(source, oracle);

    const minSide = Math.min(...result.parts.map((part) => part.endOffset - part.startOffset));
    expect(minSide).toBeGreaterThanOrEqual(Math.min(1_024, Math.floor(source.byteLength / 4)));
    expectConcatenatesTo(result, source);
  });
});

function partRange(part: { startOffset: number; endOffset: number }): [number, number] {
  return [part.startOffset, part.endOffset];
}

function expectConcatenatesTo(result: ImportPartitionResult, source: Uint8Array): void {
  const concatenated = new Uint8Array(result.parts.reduce((total, part) => total + part.bytes.byteLength, 0));
  let offset = 0;
  for (const part of result.parts) {
    concatenated.set(part.bytes, offset);
    offset += part.bytes.byteLength;
  }
  expect(Array.from(concatenated)).toEqual(Array.from(source));
}
