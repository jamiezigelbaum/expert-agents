import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleApiError,
  InMemoryGcsAdapter,
  type VertexAdapter,
  type VertexFile,
} from "../packages/library-materializer/src/index.ts";
import {
  assertImportPartitionReceiptContainsNoSecrets,
  parsePartitionForImportArguments,
  runPartitionForImportCli,
  type ImportPartitionDiscoveryReceipt,
} from "../scripts/partition-for-import.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("import partition discovery CLI", () => {
  test("rejects any scratch corpus name without the scratch- prefix", () => {
    expect(() => parsePartitionForImportArguments(baseArguments("production-library"))).toThrow(
      "--scratch-corpus must start with scratch-",
    );
    expect(parsePartitionForImportArguments(baseArguments("scratch-import-probes")).probePrefix).toBe(
      "shared/library-probe",
    );
  });

  test("uploads probes under the isolated probe prefix and writes deterministic parts", async () => {
    const fixture = await createFixture();
    const gcs = new InMemoryGcsAdapter();
    const vertex = new RejectFirstImportVertex();

    const result = await runPartitionForImportCli(fixture.argv, { gcs, vertex, env: {} });
    const receipt = JSON.parse(new TextDecoder().decode(result.receiptBytes)) as ImportPartitionDiscoveryReceipt;

    expect(gcs.writes).toHaveLength(3);
    expect(gcs.writes.every((write) => write.path.startsWith("scratch-probe/"))).toBe(true);
    expect(receipt.probeObjectPaths).toHaveLength(3);
    expect(receipt.probeObjectPaths.every((path) =>
      path.startsWith("gs://neutral-library-bucket/shared/library-probe/scratch-probe/")
      && !path.startsWith("gs://neutral-library-bucket/shared/library/scratch-probe/"))).toBe(true);
    expect(result.partPaths.map((path) => path.split("/").at(-1))).toEqual([
      "source.part01.md",
      "source.part02.md",
    ]);
    expect(receipt.partCount).toBe(2);
    expect(receipt.probeAttempts).toMatchObject({ total: 3, accepted: 2, rejected: 1 });

    const reconstructed = Buffer.concat(await Promise.all(result.partPaths.map((path) => readFile(path))));
    expect(reconstructed.equals(Buffer.from(fixture.source))).toBe(true);
  });

  test("produces byte-identical receipts for identical inputs and oracle verdicts", async () => {
    const firstFixture = await createFixture();
    const secondFixture = await createFixture();

    const first = await runPartitionForImportCli(firstFixture.argv, {
      gcs: new InMemoryGcsAdapter(),
      vertex: new RejectFirstImportVertex(),
      env: {},
    });
    const second = await runPartitionForImportCli(secondFixture.argv, {
      gcs: new InMemoryGcsAdapter(),
      vertex: new RejectFirstImportVertex(),
      env: {},
    });

    expect(new TextDecoder().decode(first.receiptBytes)).toBe(new TextDecoder().decode(second.receiptBytes));
  });

  test("fails closed when serialized receipt bytes contain credential material", () => {
    const sentinel = "credential-sentinel-never-write";
    expect(() => assertImportPartitionReceiptContainsNoSecrets(
      new TextEncoder().encode(`{"leak":"${sentinel}"}\n`),
      [sentinel],
    )).toThrow("Refusing to write import partition receipt");
    expect(() => assertImportPartitionReceiptContainsNoSecrets(
      new TextEncoder().encode("{}\n"),
      [sentinel],
    )).not.toThrow();
  });

  test("maps typed Vertex import rejections to oracle false", async () => {
    const fixture = await createFixture();
    const vertex = new RejectFirstImportVertex();

    const result = await runPartitionForImportCli(fixture.argv, {
      gcs: new InMemoryGcsAdapter(),
      vertex,
      env: {},
    });

    expect(result.partPaths).toHaveLength(2);
    expect(vertex.importCalls).toBe(3);
  });

  test("propagates systemic Vertex errors instead of treating them as rejections", async () => {
    const fixture = await createFixture();
    const vertex: VertexAdapter = {
      ensureCorpus: async () => "fake/scratch-corpus",
      importFile: async () => {
        throw new GoogleApiError("Vertex RAG file import", 401);
      },
      listFiles: async (): Promise<VertexFile[]> => [],
    };

    await expect(runPartitionForImportCli(fixture.argv, {
      gcs: new InMemoryGcsAdapter(),
      vertex,
      env: {},
    })).rejects.toThrow("Vertex RAG file import failed with HTTP 401");
  });
});

class RejectFirstImportVertex implements VertexAdapter {
  importCalls = 0;

  async ensureCorpus(): Promise<string> {
    return "fake/scratch-corpus";
  }

  async importFile(): Promise<string> {
    this.importCalls += 1;
    if (this.importCalls === 1) {
      throw new GoogleApiError("Vertex RAG file import rejected: fake", 422);
    }
    return `fake/rag-files/${this.importCalls}`;
  }

  async listFiles(): Promise<VertexFile[]> {
    return [];
  }
}

async function createFixture(): Promise<{ argv: string[]; source: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "expert-agents-partition-test-"));
  temporaryDirectories.push(root);
  const source = new TextEncoder().encode(`${"a".repeat(2_500)}\n\n${"b".repeat(2_700)}`);
  const filePath = join(root, "source.txt");
  await writeFile(filePath, source);
  return {
    source,
    argv: [
      "--bucket", "neutral-library-bucket",
      "--prefix", "shared/library",
      "--file", filePath,
      "--scratch-corpus", "scratch-import-probes",
      "--out", join(root, "parts"),
      "--receipt", join(root, "receipts", "partition.json"),
    ],
  };
}

function baseArguments(scratchCorpus: string): string[] {
  return [
    "--bucket", "neutral-library-bucket",
    "--prefix", "shared/library",
    "--file", "/operator/source.md",
    "--scratch-corpus", scratchCorpus,
    "--out", "/operator/parts",
    "--receipt", "/operator/receipt.json",
  ];
}
