import { describe, expect, test } from "bun:test";
import {
  GcsCasConflictError,
  InMemoryGcsAdapter,
  InMemoryVertexAdapter,
} from "../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("in-memory GCS adapter", () => {
  test("enforces generation zero create semantics and compare-and-set updates", async () => {
    const gcs = new InMemoryGcsAdapter();

    const firstGeneration = await gcs.writeIfGeneration("manifest/master.json", encoder.encode("one"), 0);
    expect(firstGeneration).toBe("1");
    await expect(gcs.writeIfGeneration("manifest/master.json", encoder.encode("stale"), 0))
      .rejects.toBeInstanceOf(GcsCasConflictError);

    const secondGeneration = await gcs.writeIfGeneration(
      "manifest/master.json",
      encoder.encode("two"),
      firstGeneration,
    );
    expect(secondGeneration).toBe("2");
    await expect(gcs.writeIfGeneration("manifest/master.json", encoder.encode("stale"), firstGeneration))
      .rejects.toBeInstanceOf(GcsCasConflictError);
    expect(decoder.decode((await gcs.read("manifest/master.json"))!.bytes)).toBe("two");
  });

  test("returns defensive byte copies", async () => {
    const bytes = encoder.encode("canonical");
    const gcs = new InMemoryGcsAdapter([{ path: "objects/a", bytes }]);
    bytes[0] = 0;

    const read = await gcs.read("objects/a");
    read!.bytes[0] = 0;

    expect(decoder.decode((await gcs.read("objects/a"))!.bytes)).toBe("canonical");
  });
});

describe("in-memory Vertex adapter", () => {
  test("ensures corpora idempotently and lists imported files", async () => {
    const vertex = new InMemoryVertexAdapter();

    const corpus = await vertex.ensureCorpus("neutral-agent-library");
    expect(await vertex.ensureCorpus("neutral-agent-library")).toBe(corpus);
    const ragFileId = await vertex.importFile(corpus, "gs://shared/library/objects/a");

    expect(await vertex.listFiles(corpus)).toEqual([
      { ragFileId, gcsUri: "gs://shared/library/objects/a" },
    ]);
  });
});
