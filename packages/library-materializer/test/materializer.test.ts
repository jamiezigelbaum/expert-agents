import { describe, expect, test } from "bun:test";
import {
  contentIdFromBytes,
} from "@expert-agents/library";
import {
  InMemoryGcsAdapter,
  InMemoryVertexAdapter,
  materializeScope,
  parseMaterializerLedger,
} from "../src/index.ts";
import { candidate, scopeText } from "./materializer-fixtures.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = encoder.encode("neutral canonical bytes");
const objectId = contentIdFromBytes(bytes);

describe("materializeScope", () => {
  test("appends a canonical object and materializes the selected scope", async () => {
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();
    const receipt = await materializeScope({
      config: { bucket: "neutral-library-bucket", prefix: "shared/library" },
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("candidate.txt", bytes)],
      gcs,
      vertex,
      execute: true,
    });

    expect(receipt.candidates.addedObjectIds).toEqual([objectId]);
    expect(receipt.materialization.importedObjectIds).toEqual([objectId]);
    expect(receipt.materialization.alreadyMaterializedObjectIds).toEqual([]);
    expect(receipt.materialization.retractions).toEqual([]);
    const ledgerWrite = gcs.writes.find((write) => write.path === "ledgers/neutral-agent.json");
    expect(parseMaterializerLedger(decoder.decode(ledgerWrite!.bytes)).entries).toEqual([
      {
        objectId,
        ragFileId: "fake-rag-file-1",
        targetCorpusDisplayName: "neutral-agent-library",
        corpusResourceName: "fake/corpora/1",
        importedAtRevision: 1,
      },
    ]);
  });
});
