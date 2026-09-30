import { describe, expect, test } from "bun:test";
import {
  parseMaterializerLedger,
  plannerLedger,
  serializeMaterializerLedger,
} from "../src/index.ts";

const objectId = `sha256:${"a".repeat(64)}` as const;

describe("materializer ledger corpus key", () => {
  test("tolerates legacy entries while preserving corpus-keyed entries", () => {
    const legacy = {
      schemaVersion: 1 as const,
      revision: 1,
      entries: [{
        objectId,
        ragFileId: "ragFiles/legacy-a",
        corpusResourceName: "corpora/legacy",
        importedAtRevision: 1,
      }],
    };
    expect(parseMaterializerLedger(serializeMaterializerLedger(legacy))).toEqual(legacy);

    const corpusKeyed = {
      schemaVersion: 1 as const,
      revision: 2,
      entries: [{
        objectId,
        ragFileId: "ragFiles/current-a",
        targetCorpusDisplayName: "neutral-library",
        corpusResourceName: "corpora/current",
        importedAtRevision: 2,
      }],
    };
    expect(plannerLedger(corpusKeyed).entries).toEqual([{
      objectId,
      ragFileId: "ragFiles/current-a",
      targetCorpusDisplayName: "neutral-library",
    }]);
  });
});
