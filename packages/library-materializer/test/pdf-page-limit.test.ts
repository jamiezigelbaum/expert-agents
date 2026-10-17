import { describe, expect, test } from "bun:test";
import { contentIdFromBytes, LLM_PARSER_MAX_PDF_PAGES } from "@expert-agents/library";
import { InMemoryGcsAdapter, InMemoryVertexAdapter, materializeScope } from "../src/index.ts";
import { candidateMetadata, scopeText } from "./materializer-fixtures.ts";

// The materializer imports each object whole. While imports use the LLM parser, a PDF longer
// than it takes per file (docs/vertex-rag-limits.md) is rejected before import instead of
// failing inside Vertex.
describe("PDF page limit", () => {
  const encoder = new TextEncoder();
  const longPdf = encoder.encode("%PDF-1.7 neutral long fixture");
  const shortPdf = encoder.encode("%PDF-1.7 neutral short fixture");
  const pages = new Map([[contentIdFromBytes(longPdf), LLM_PARSER_MAX_PDF_PAGES + 1], [contentIdFromBytes(shortPdf), LLM_PARSER_MAX_PDF_PAGES]]);
  const pdf = (path: string, value: Uint8Array) => ({ path, bytes: async () => value, metadata: { ...candidateMetadata(path), mediaType: "application/pdf" } });

  async function run(pdfPageLimit?: Parameters<typeof materializeScope>[0]["pdfPageLimit"]) {
    const vertex = new InMemoryVertexAdapter();
    const receipt = await materializeScope({
      config: { bucket: "neutral-library-bucket", prefix: "shared/library" },
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([...pages.keys()].sort()),
      candidates: [pdf("long.pdf", longPdf), pdf("short.pdf", shortPdf)],
      gcs: new InMemoryGcsAdapter(),
      vertex,
      execute: true,
      ...(pdfPageLimit ? { pdfPageLimit } : {}),
    });
    return { receipt, vertex };
  }

  test("a PDF over the limit is rejected before import and the rest still import", async () => {
    const counted: number[] = [];
    const { receipt, vertex } = await run({
      maxPages: LLM_PARSER_MAX_PDF_PAGES,
      countPages: async (bytes) => { const count = pages.get(contentIdFromBytes(bytes)); counted.push(count!); return count; },
    });
    expect(counted.sort()).toEqual([LLM_PARSER_MAX_PDF_PAGES, LLM_PARSER_MAX_PDF_PAGES + 1]);
    expect(receipt.materialization.importedObjectIds).toEqual([contentIdFromBytes(shortPdf)]);
    expect(receipt.materialization.rejectedImports).toHaveLength(1);
    expect(receipt.materialization.rejectedImports[0]!.objectId).toBe(contentIdFromBytes(longPdf));
    expect(receipt.materialization.rejectedImports[0]!.reason).toStartWith(`pdf_exceeds_parser_page_limit: measured ${LLM_PARSER_MAX_PDF_PAGES + 1} pages`);
    expect(vertex.importCalls).toHaveLength(1);
    expect(vertex.importCalls[0]!.gcsUri).toContain(contentIdFromBytes(shortPdf).slice("sha256:".length));
  });

  test("without a page limit (the default parser) both PDFs import", async () => {
    const { receipt } = await run();
    expect(receipt.materialization.importedObjectIds).toHaveLength(2);
    expect(receipt.materialization.rejectedImports).toEqual([]);
  });
});
