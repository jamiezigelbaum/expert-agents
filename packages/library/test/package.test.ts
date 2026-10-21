import { describe, expect, test } from "bun:test";

describe("@expert-agents/library package", () => {
  test("loads as an isolated workspace package", async () => {
    const library = await import("../src/index.ts");

    const functions = [
      "LibraryValidationError", "ManifestUpdateError", "ReconciliationPlannerError",
      "allowlistedExtractionEnv", "applyManifestUpdate", "assertMasterManifestHash",
      "canonicalJson", "canonicalObjectRelativePath", "computeMasterManifestHash",
      "contentIdFromBytes", "extensionForMediaType", "extractorEnvironment",
      "finalizeMasterManifest", "firstDiagnosticLine", "isolatedExtractorEnvironment", "libraryObjectUri",
      "llmParserEligibleUris", "normalizeExtractedText", "parseLibraryObject",
      "parseMasterManifest", "parseScopeManifest", "planReconciliation",
      "ragIngestionConfig", "readCorpusMappingLedger", "readSourceRegistryCandidates",
      "resolveRagParserModel", "serializeLibraryObject", "serializeMasterManifest",
      "serializeReconciliationPlan", "serializeScopeManifest", "sha256",
      "sourceLocatorCredential", "supportsLlmParser", "validateLibraryLocationConfig",
      "validateLibraryObject", "validateMasterManifest", "validateMaterializationLedger",
      "validateScopeManifest", "applyRetrievalPreferences", "parseRetrievalPreferenceProfile",
      "validatedVertexOperationName",
      "EbookConversionError", "convertEpubToMarkdown", "decodeXmlEntities", "plainTextToMarkdown",
      "resolveArchivePath", "xhtmlToMarkdown",
      "PdfSplitError", "pdfPageLimitSetting", "pdfPartStem", "pdfTextLayer", "planPdfParts", "qpdfPageCount", "splitPdf", "stripPdfPartSuffix",
      "bookId", "offsetUnits", "pageDerivativePrefix", "pageNeedsOcr", "parseUnitSlug", "partOf", "renderUnitMarkdown",
      "sectionText", "slugify", "splitPdfText", "unitBody", "unitFrontmatter", "unitName", "unitNumber", "unitSlug",
      "deepLane", "describeFigures", "escalatePage", "figurePagesFromImageList", "hasFigureCaption", "looksLikeRefusal", "ocrEscalationReason", "ocrPage",
      "parseFigureReply", "readPage", "stripGrounding", "visionCall",
      "derivativeManifest", "emptyParseUsage", "isEpub", "isPdf", "parseObject", "pool", "sha256Hex", "upsertCatalog", "writeBook", "writeParsedBook",
      "formatTimecode", "isMediaFile", "splitFrontmatter", "timeRange", "timedSections", "transcribeMedia", "extractWebMainText",
    ] as const;
    const numbers = [
      "EXTRACTION_MAX_OUTPUT_BYTES", "EXTRACTION_TIMEOUT_MS", "LIBRARY_SCHEMA_VERSION",
      "MATERIALIZATION_LEDGER_SCHEMA_VERSION", "RAG_CHUNK_OVERLAP", "RAG_CHUNK_TOKENS",
      "RECONCILIATION_PLAN_SCHEMA_VERSION", "SCOPE_SCHEMA_VERSION", "LLM_PARSER_MAX_PDF_PAGES",
      "OCR_MIN_CHARS", "PAGE_UNITS_SCHEMA_VERSION", "SECTION_TARGET_WORDS", "DENSE_PAGE_JPEG_BYTES", "MEDIA_SECTION_TARGET_WORDS",
    ] as const;
    const strings = [
      "AGENT_REPO_GITIGNORE", "DEFAULT_RAG_PARSER_MODEL", "EXTRACTION_METHOD",
      "RAG_PARSER_DEFAULT_VALUE", "SUMMARIZE_BINARY", "SUMMARIZE_INSTALL_COMMAND", "PDF_SPLIT_PAGES_ENV", "DEFAULT_QPDF_BIN",
      "OCR_PROFILE", "DEEP_PROFILE", "DEEPSEEK_OCR_PROMPT", "LANE_CACHE", "TRANSCRIPTION_PROFILE",
    ] as const;

    expect(Object.keys(library).sort()).toEqual([...functions, ...numbers, ...strings,
      "EXTRACTION_ARGUMENTS", "EXTRACTION_ENV_ALLOWLIST", "MEDIA_EXTENSIONS"].sort());
    expect(library.MEDIA_EXTENSIONS.has(".mp3")).toBe(true);
    for (const name of functions) expect(typeof library[name]).toBe("function");
    for (const name of numbers) expect(typeof library[name]).toBe("number");
    for (const name of strings) expect(typeof library[name]).toBe("string");
    expect(library.EXTRACTION_ARGUMENTS).toEqual(expect.arrayContaining(["--extract", "--format"]));
    expect(library.EXTRACTION_ENV_ALLOWLIST).toBeArray();
    expect(library.EXTRACTION_ENV_ALLOWLIST.every((entry) => typeof entry === "string")).toBe(true);
  });
});
