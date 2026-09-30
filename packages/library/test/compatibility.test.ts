import { describe, expect, test } from "bun:test";
import { readCorpusMappingLedger, readSourceRegistryCandidates } from "../src/index.ts";

describe("legacy state compatibility readers", () => {
  test("reads registry candidates while counting malformed, empty, and unhashed lines", () => {
    const hash = `sha256:${"d".repeat(64)}`;
    const registryText = [
      JSON.stringify({
        domain_id: "example-domain",
        locator: "https://example.invalid/source-a",
        source_type: "document",
        target_corpus: "example-agent-library",
        trust_tier: "reviewed",
        copyright_posture: "licensed",
        ingest_status: "registered",
      }),
      "{malformed-json",
      JSON.stringify({
        domainId: "second-domain",
        sourceLocator: "https://example.invalid/source-b",
        sourceKind: "web-page",
        trustTier: "primary",
        copyrightStatus: "public-domain",
        ingestStatus: "ingested",
        contentHash: hash,
      }),
      "",
      JSON.stringify({ domain_id: "missing-fields", locator: "https://example.invalid/incomplete" }),
    ].join("\n");

    const result = readSourceRegistryCandidates(registryText);
    expect(result.counts).toEqual({
      totalLines: 5,
      parsedLines: 2,
      malformedLines: 2,
      emptyLines: 1,
      requiresHashing: 1,
    });
    expect(result.candidates[0]).toMatchObject({
      lineNumber: 1,
      domainId: "example-domain",
      sourceKind: "document",
      targetCorpusDisplayName: "example-agent-library",
      trustTier: "reviewed",
      copyrightPosture: "licensed",
      ingestStatus: "registered",
      contentHash: null,
      requires_hashing: true,
    });
    expect(result.candidates[1]).toMatchObject({
      lineNumber: 3,
      domainId: "second-domain",
      contentHash: hash,
      requires_hashing: false,
    });
  });

  test("reads sorted corpus display-name mappings and counts malformed entries", () => {
    const result = readCorpusMappingLedger(JSON.stringify({
      "zeta-corpus": "projects/example/locations/eu/corpora/zeta",
      "alpha-corpus": "projects/example/locations/eu/corpora/alpha",
      "invalid-corpus": 42,
      "": "projects/example/locations/eu/corpora/empty",
    }));
    expect(result.entries).toEqual([
      { displayName: "alpha-corpus", resourceName: "projects/example/locations/eu/corpora/alpha" },
      { displayName: "zeta-corpus", resourceName: "projects/example/locations/eu/corpora/zeta" },
    ]);
    expect(result.counts).toEqual({ totalEntries: 4, parsedEntries: 2, malformedEntries: 2 });
    expect(result.documentMalformed).toBe(false);
  });

  test("reports a malformed corpus mapping document without throwing", () => {
    expect(readCorpusMappingLedger("{not-json")).toEqual({
      entries: [],
      counts: { totalEntries: 0, parsedEntries: 0, malformedEntries: 1 },
      documentMalformed: true,
    });
  });
});
