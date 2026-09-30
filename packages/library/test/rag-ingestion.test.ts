import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RAG_PARSER_MODEL,
  llmParserEligibleUris,
  ragIngestionConfig,
  resolveRagParserModel,
  supportsLlmParser,
} from "../src/rag-ingestion.ts";

describe("RAG parser configuration", () => {
  test("an unset or empty setting selects the default LLM parser model", () => {
    expect(resolveRagParserModel(undefined)).toBe(DEFAULT_RAG_PARSER_MODEL);
    expect(resolveRagParserModel("")).toBe(DEFAULT_RAG_PARSER_MODEL);
    expect(resolveRagParserModel("  ")).toBe(DEFAULT_RAG_PARSER_MODEL);
  });

  test("the literal default disables parsing and any other value is the model", () => {
    expect(resolveRagParserModel("default")).toBeUndefined();
    expect(resolveRagParserModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  test("only the file types Google documents for the LLM parser are eligible", () => {
    for (const name of ["book.pdf", "scan.PNG", "page.jpeg", "page.jpg", "x.webp", "x.heic", "x.heif"]) {
      expect(supportsLlmParser(`gs://bucket/objects/${name}`)).toBe(true);
    }
    for (const name of ["notes.md", "page.html", "rows.jsonl", "paper.docx", "extensionless"]) {
      expect(supportsLlmParser(`gs://bucket/objects/${name}`)).toBe(false);
    }
  });

  test("a request is eligible only when every file in it is, and an empty request never is", () => {
    expect(llmParserEligibleUris(["gs://b/a.pdf", "gs://b/c.png"])).toBe(true);
    expect(llmParserEligibleUris(["gs://b/a.pdf", "gs://b/c.md"])).toBe(false);
    expect(llmParserEligibleUris([])).toBe(false);
  });

  test("the model expands to a publisher resource name unless one was configured", () => {
    const base = { project: "neutral-project", location: "europe-west1", llmParserEligible: true };

    expect(ragIngestionConfig({ ...base, parserModel: "gemini-2.5-flash" }).ragFileParsingConfig).toEqual({
      llmParser: {
        modelName: "projects/neutral-project/locations/europe-west1/publishers/google/models/gemini-2.5-flash",
      },
    });
    const configured = "projects/other/locations/us-central1/publishers/google/models/gemini-2.5-pro";
    expect(ragIngestionConfig({ ...base, parserModel: configured }).ragFileParsingConfig).toEqual({
      llmParser: { modelName: configured },
    });
  });

  test("chunking is always stated explicitly, parser or not", () => {
    const chunking = {
      ragFileChunkingConfig: { fixedLengthChunking: { chunkSize: 1024, chunkOverlap: 256 } },
    };
    const ineligible = ragIngestionConfig({
      project: "neutral-project",
      location: "europe-west1",
      parserModel: "gemini-2.5-flash",
      llmParserEligible: false,
    });

    expect(ineligible).not.toHaveProperty("ragFileParsingConfig");
    expect(ineligible.ragFileTransformationConfig).toEqual(chunking);
    expect(ragIngestionConfig({
      project: "neutral-project",
      location: "europe-west1",
      llmParserEligible: true,
    }).ragFileTransformationConfig).toEqual(chunking);
  });
});
