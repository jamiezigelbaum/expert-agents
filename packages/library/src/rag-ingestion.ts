// Vertex AI RAG Engine ingestion config, defined once so that every import
// path sends the same thing. The two paths had silently drifted: the
// materializer sent no parsing or transformation config at all (taking whatever
// the API defaulted to) while the worker sent an unverified `layoutParser: {}`
// with no processor plus a different chunk size.
//
// Request shape verified 2026-07-29 against the live Vertex AI v1 discovery
// document (https://aiplatform.googleapis.com/$discovery/rest?version=v1),
// schemas GoogleCloudAiplatformV1ImportRagFilesConfig,
// ...RagFileParsingConfigLlmParser and
// ...RagFileChunkingConfigFixedLengthChunking:
//
//   importRagFilesConfig.ragFileParsingConfig.llmParser.modelName
//   importRagFilesConfig.ragFileTransformationConfig
//     .ragFileChunkingConfig.fixedLengthChunking.{chunkSize,chunkOverlap}
//
// Note that the LLM parser guide's REST sample still shows a top-level
// `rag_file_chunking_config`; that field no longer exists in v1, where chunking
// only reaches the API through `ragFileTransformationConfig`.
// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/llm-parser

// The chunk size and overlap are always stated explicitly. Relying on the
// API default is not safe: the REST default and the Python SDK sample disagree
// on overlap (256 vs 200), so an unstated request is a request whose chunking
// depends on which client wrote it. 1024 also matches the reranker's
// 1024-token scoring window, so a whole chunk is scored rather than half.
export const RAG_CHUNK_TOKENS = 1024;
export const RAG_CHUNK_OVERLAP = 256;

// The LLM parser reads documents with a Gemini model instead of the default
// text extractor, which is what makes books with tables, figures and multi
// column layouts parse usefully. Flash is the cost/accuracy default; the guide
// lists Gemini 2.5 Pro, Flash and Flash-Lite as the supported parser models.
export const DEFAULT_RAG_PARSER_MODEL = "gemini-2.5-flash";

// The one configured value that turns the parser off and lets Google apply its
// own default parser to everything.
export const RAG_PARSER_DEFAULT_VALUE = "default";

// File extensions for the media types the LLM parser documents support:
// application/pdf, image/png, image/jpeg, image/webp, image/heic, image/heif.
// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/llm-parser
const LLM_PARSER_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "webp", "heic", "heif"]);

export interface RagIngestionConfigOptions {
  project: string;
  location: string;
  // The configured parser model, already resolved by resolveRagParserModel.
  // Undefined means send no parsing config, so Google uses its default parser.
  parserModel?: string | undefined;
  // Whether every file this request will import is a type the LLM parser
  // documents support. See llmParserEligibleUris.
  llmParserEligible: boolean;
  chunkTokens?: number;
  chunkOverlap?: number;
}

// Resolves the operator-facing parser setting. Empty or unset selects the LLM
// parser with the default model, the literal "default" disables it, and any
// other value is used as the model.
export function resolveRagParserModel(configured: string | undefined): string | undefined {
  const value = configured?.trim() ?? "";
  if (value === RAG_PARSER_DEFAULT_VALUE) return undefined;
  return value.length === 0 ? DEFAULT_RAG_PARSER_MODEL : value;
}

// Whether a GCS URI or path names a file type the LLM parser supports.
export function supportsLlmParser(uriOrPath: string): boolean {
  const name = uriOrPath.split("?")[0]!.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && LLM_PARSER_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// The parser applies to a whole import request, and Google documents neither
// which file types the LLM parser tolerates alongside the ones it supports nor
// what it does with the rest — the default parser's own type list (HTML, JSON,
// Markdown, DOCX, PPTX, text) is published separately, with only the remark
// that "Additional file types are supported by an Llm Parser".
// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/supported-documents
// Rather than guess at undocumented behaviour on the live ingestion path, the
// parser is sent only when every file in the request is a documented LLM parser
// type; a mixed or non-PDF request keeps Google's default parser, which does
// handle those types. Both call sites know their own file set.
export function llmParserEligibleUris(uris: readonly string[]): boolean {
  return uris.length > 0 && uris.every((uri) => supportsLlmParser(uri));
}

// The parsing and transformation fields to merge into an importRagFilesConfig.
export function ragIngestionConfig(options: RagIngestionConfigOptions): Record<string, unknown> {
  const parserModel = options.llmParserEligible ? options.parserModel : undefined;
  return {
    ...(parserModel === undefined ? {} : {
      ragFileParsingConfig: {
        llmParser: { modelName: parserModelResourceName(options.project, options.location, parserModel) },
      },
    }),
    ragFileTransformationConfig: {
      ragFileChunkingConfig: {
        fixedLengthChunking: {
          chunkSize: options.chunkTokens ?? RAG_CHUNK_TOKENS,
          chunkOverlap: options.chunkOverlap ?? RAG_CHUNK_OVERLAP,
        },
      },
    },
  };
}

// The API wants a publisher model resource name; a bare model id is the
// convenient thing to configure, so expand it unless one was given in full.
function parserModelResourceName(project: string, location: string, model: string): string {
  return model.startsWith("projects/")
    ? model
    : `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}
