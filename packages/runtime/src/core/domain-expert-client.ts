import type { ExpertAgentsConfig } from './config.ts';
import { fetchWithTimeout, isAbortError } from './http-timeout.ts';
import { OperationError } from './operation-error.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';

export type DomainExpertTool =
  | 'domain_agent'
  | 'domain_ask'
  | 'domain_read'
  | 'domain_source'
  | 'rag_corpus'
  | 'domain_doc'
  | 'annas_archive_search'
  | 'annas_archive_import';

export type DomainExpertFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DomainExpertTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

const WORKER_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  library_read_disclosure_restricted: 'Direct reading is unavailable on a disclosure-bounded deployment. Use domain_ask.',
  library_read_not_configured: 'Direct reading requires an operator-configured library scope manifest.',
  library_read_scope_mismatch: 'The library scope does not match the configured corpus.',
  library_read_busy: 'Direct reading is busy. Retry shortly.',
  library_read_unavailable: 'The source or library state could not be read or validated.',
  library_source_not_available: 'The source is not available in this library scope.',
  library_source_too_large: 'The source exceeds the direct-reading size limit.',
  library_source_format_unsupported: 'The source needs a text, Markdown, HTML, or PDF representation before direct reading.',
  library_source_integrity_failed: 'The stored source does not match its library identity.',
  library_source_text_unavailable: 'The source has no readable text. Scanned PDFs require a separately prepared OCR text representation.',
  library_text_too_large: 'The text exceeds the direct-reading size limit.',
  library_text_revision_required: 'Use the text_revision from open when selecting or continuing a text range.',
  library_text_revision_changed: 'The text representation changed. Open the source again before continuing.',
  library_pdf_reader_unavailable: 'PDF reading requires Poppler pdftotext on the worker host.',
  library_pdf_extraction_failed: 'PDF text extraction failed or exceeded its size or time limit.',
  invalid_params: 'The domain expert request parameters are invalid.',
  domain_expert_not_configured: 'The domain expert worker is not configured.',
  annas_archive_not_configured: 'The library acquisition provider is not configured.',
  gcp_project_not_configured: 'A valid Google Cloud project must be configured for the Vertex library.',
  agent_not_configured: 'The requested agent has no configured library route.',
  agent_registration_disabled: 'Agent registration is disabled by the worker deployment.',
  agent_registration_library_denied: 'The requested library is outside the deployment registration boundary.',
  agent_registration_conflict: 'The requested agent or corpus name is already in use.',
  invalid_agent_registration: 'The agent registration settings are invalid.',
  rag_corpus_creation_failed: 'Corpus creation failed and requires operator reconciliation.',
  rag_corpus_ambiguous: 'Multiple corpora have the configured display name.',
  google_generation_empty: 'Google returned no usable text generation.',
  google_generation_incomplete: 'Google did not return a complete text generation.',
});

export class DomainExpertClient {
  private config: ExpertAgentsConfig;
  private transport: DomainExpertTransport;

  constructor(
    config: ExpertAgentsConfig,
    transport: DomainExpertTransport = createDomainExpertTransport(config),
  ) {
    this.config = config;
    this.transport = transport;
  }

  async run(tool: DomainExpertTool, params: Record<string, unknown>): Promise<unknown> {
    if (!this.config.domainExpert.enabled) {
      throw new OperationError(
        'domain_expert_not_configured',
        'Domain expert worker is disabled.',
        'Configure the bounded domain expert worker before live Google/Gemini/Docs/Anna actions.',
      );
    }
    // Live model traffic sometimes omits domain_id. This runtime is
    // tenant-neutral, so its own default domain is unrouted and the omission
    // fails closed with an error naming the wrong remedy. Which expert a
    // deployment serves by default is a deployment fact, so the client fills
    // it in — an id the caller actually set is never touched.
    //
    // This is deployment-level parity with the integration this plugin
    // replaces. Per-agent binding is the better long-term shape: the default
    // belongs to the agent (binding.json), not to whichever gateway config the
    // plugin happens to load.
    const defaultDomainId = this.config.domainExpert.defaultDomainId;
    const requestParams = defaultDomainId && !hasDomainId(params)
      ? { ...params, domain_id: defaultDomainId }
      : params;
    const response = await this.transport.requestJson(`${this.config.domainExpert.baseUrl}/domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, params: requestParams }),
    });
    assertDomainExpertPolicy(response);
    return response;
  }
}

export function createDomainExpertTransport(config: ExpertAgentsConfig): DomainExpertTransport {
  return new DirectHttpDomainExpertTransport(
    fetch,
    workerAuthTokenFromConfig(config),
    config.domainExpert.requestTimeoutSeconds * 1000,
  );
}

export class DirectHttpDomainExpertTransport implements DomainExpertTransport {
  private fetchImpl: DomainExpertFetch;
  private authToken: string | undefined;
  private timeoutMs: number;

  constructor(fetchImpl: DomainExpertFetch = fetch, authToken?: string, timeoutMs = 0) {
    this.fetchImpl = fetchImpl;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, url, withWorkerAuthHeader(init, this.authToken), this.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new OperationError(
          'domain_expert_unreachable',
          `Domain expert worker timed out after ${this.timeoutMs}ms.`,
          'The domain expert worker did not answer within the configured request budget; check worker health before retrying.',
        );
      }
      throw new OperationError(
        'domain_expert_unreachable',
        'Domain expert worker is unreachable.',
        'Check that the Expert Agents domain expert worker is running.',
      );
    }

    if (!response.ok) {
      const code = await safeWorkerErrorCode(response, this.timeoutMs);
      throw new OperationError(
        code ?? (response.status === 403 ? 'domain_expert_policy_violation' : 'domain_expert_error'),
        code ? WORKER_ERROR_MESSAGES[code]! : `Domain expert worker returned HTTP ${response.status}.`,
        'Check the Expert Agents domain expert worker configuration and bounded diagnostic logs.',
      );
    }

    return response.json();
  }
}

/**
 * A blank or absent domain_id is an omission, not a choice. Any other value the
 * caller supplied is left alone so the worker can reject it by name rather than
 * having it silently rewritten to the deployment default.
 */
function hasDomainId(params: Record<string, unknown>): boolean {
  const domainId = params.domain_id;
  if (typeof domainId === 'string') return domainId.trim().length > 0;
  return domainId !== undefined && domainId !== null;
}

function assertDomainExpertPolicy(value: unknown): void {
  const record = asRecord(value);
  const policy = asRecord(record.policy);
  // Only the independent worker's contract is accepted. A stale endpoint must
  // fail visibly instead of silently returning to the retired implementation.
  const controlPlaneOnly = policy.expert_agents_control_plane_only === true;
  if (!controlPlaneOnly || policy.raw_runtime_secrets_exposed !== false) {
    throw new OperationError('domain_expert_error', 'Domain expert response did not include the bounded policy contract.');
  }
}

async function safeWorkerErrorCode(response: Response, timeoutMs: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('bounded worker error timeout')), Math.min(timeoutMs > 0 ? timeoutMs : 5000, 5000));
    });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) return undefined;
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    const code: unknown = parsed?.error?.code;
    // Provider messages and remediation may contain source text, credentials,
    // or private paths even when their error code is recognized. Only fixed
    // local messages cross this boundary.
    return typeof code === 'string' && Object.hasOwn(WORKER_ERROR_MESSAGES, code) ? code : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('domain_expert_error', 'Domain expert response was not an object.');
  }
  return value as Record<string, unknown>;
}
