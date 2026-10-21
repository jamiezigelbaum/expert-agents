import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, validateLibraryLocationConfig, type LibraryLocationConfig } from '@expert-agents/library';
import { validateAgentRoutingConfig, type AgentRoutingConfig, type AgentRoutingEntry } from './agent-routing.ts';
import { OperationError } from './operation-error.ts';
import { writeExclusiveDurably } from './durable-file.ts';

export const REGISTRATION_LIBRARY_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_REGISTRATION_LIBRARY_JSON';
/**
 * Set, a registered domain's page library is an assembled tree on local disk, one subdirectory
 * per domain. Unset (the default), it lives in the page library database under the domain id.
 */
export const PAGE_LIBRARY_ROOT_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_ROOT';

export function pageLibraryRootFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[PAGE_LIBRARY_ROOT_ENV]?.trim();
  if (!raw) return undefined;
  if (!raw.startsWith('/') || raw.split('/').includes('..')) throw new OperationError('invalid_page_library_root', `${PAGE_LIBRARY_ROOT_ENV} must be an absolute path.`);
  return raw.replace(/\/+$/, '') || '/';
}

export function registrationLibraryFromEnv(env: Record<string, string | undefined> = process.env): LibraryLocationConfig | undefined {
  const raw = env[REGISTRATION_LIBRARY_ENV];
  if (!raw?.trim()) return undefined;
  try { return validateLibraryLocationConfig(JSON.parse(raw)); }
  catch { throw new OperationError('invalid_registration_library', 'The registration library configuration is invalid.'); }
}

/** Only an operator-configured library subtree can become a new runtime route. */
export class AgentRegistrationStore {
  private readonly directory: string;
  constructor(dataDir: string, private readonly base: AgentRoutingConfig, private readonly allowed?: LibraryLocationConfig,
    private readonly pageLibraryRoot?: string) {
    this.directory = join(dataDir, 'agent-registrations');
  }

  routes(): AgentRoutingConfig {
    if (!this.allowed) return this.base;
    const registered: Record<string, AgentRoutingEntry> = {};
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.base; throw error; }
    try {
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const domain = file.slice(0, -5);
        const value = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
        const route = this.validate(domain, value);
        // Deployments can withdraw registration authority or replace it with
        // explicit environment routing; persisted data cannot override either.
        if (!this.base[domain] && this.withinLibrary(route[domain]!.library!)) registered[domain] = route[domain]!;
      }
      return Object.freeze({ ...registered, ...this.base });
    } catch { throw new OperationError('agent_registration_store_invalid', 'The persisted agent registration store could not be validated.'); }
  }

  register(domain: string, value: unknown, dryRun: boolean): { routes: AgentRoutingConfig; existing: boolean } {
    if (!this.allowed) throw new OperationError('agent_registration_disabled', 'Agent registration requires an operator-configured registration library.');
    const candidate = this.validate(domain, value);
    const route = candidate[domain]!;
    if (!this.withinLibrary(route.library!)) throw new OperationError('agent_registration_library_denied', 'The requested library is outside the configured registration library.');
    if (this.base[domain]) throw new OperationError('agent_registration_conflict', 'The domain is already configured by the deployment.');
    const routes = this.routes();
    if (route.targetCorpusDisplayName && Object.entries(routes).some(([id, other]) => id !== domain && other.targetCorpusDisplayName === route.targetCorpusDisplayName)) {
      throw new OperationError('agent_registration_conflict', 'The corpus name is already assigned to another agent.');
    }
    if (route.pageLibrary && Object.entries(routes).some(([id, other]) => id !== domain
      && ((other.pageLibrary?.sourceId === route.pageLibrary!.sourceId && other.pageLibrary.database === undefined) || (route.pageLibrary!.root !== undefined && other.pageLibrary?.root === route.pageLibrary!.root)))) {
      throw new OperationError('agent_registration_conflict', 'The page library is already assigned to another agent.');
    }
    const existing = routes[domain];
    if (existing && canonicalJson(existing) !== canonicalJson(route)) throw new OperationError('agent_registration_conflict', 'The domain is registered with different settings.');
    if (!dryRun && !existing && route.targetCorpusDisplayName) {
      const reservations = join(this.directory, 'corpus-reservations');
      const nameHash = createHash('sha256').update(route.targetCorpusDisplayName).digest('hex');
      const reservationPath = join(reservations, `${nameHash}.json`);
      // Keep reservation identity compatible with records written before the
      // computed client-receipt default. It is not an owner-selected setting.
      const reservationRoute = { ...candidate[domain]! };
      delete reservationRoute.ingestion;
      const reservation = canonicalJson({ domain_id: domain, route: reservationRoute });
      try {
        // A separate reservation also fences different domains registering
        // the same corpus concurrently in different worker processes.
        writeExclusiveDurably(reservationPath, reservation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (readFileSync(reservationPath, 'utf8') !== reservation) throw new OperationError('agent_registration_conflict', 'The corpus name has already been reserved for another registration.');
      }
    }
    if (!dryRun && !existing) {
      try {
        // Exclusive creation prevents a second worker from overwriting a
        // concurrent registration. A partial write fails closed on reload.
        writeExclusiveDurably(join(this.directory, `${domain}.json`), canonicalJson(value));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const concurrent = this.routes();
        if (canonicalJson(concurrent[domain] ?? null) !== canonicalJson(candidate[domain])) throw new OperationError('agent_registration_conflict', 'The domain was registered concurrently with different settings.');
        return { routes: concurrent, existing: true };
      }
    }
    return { routes: Object.freeze({ ...routes, ...candidate }), existing: Boolean(existing) };
  }

  private validate(domain: string, value: unknown): AgentRoutingConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['displayName', 'library', 'targetCorpusDisplayName', 'pageLibrary'].includes(key))) {
      throw new OperationError('invalid_agent_registration', 'Agent registration contains unsupported settings.');
    }
    const record = value as Record<string, unknown>;
    if (record.library === undefined) throw new OperationError('invalid_agent_registration', 'A registration names the library subtree that holds its originals.');
    // A registrant chooses only to have a page library; where it lives and
    // its source id are the operator's, derived from the domain id, so a
    // registration can never point the worker at another path or source.
    let pageLibrary: { root?: string; sourceId: string } | undefined;
    if (record.pageLibrary !== undefined) {
      const requested = record.pageLibrary;
      if (!requested || typeof requested !== 'object' || Array.isArray(requested)
        || Object.keys(requested).some(key => key !== 'sourceId')
        || ((requested as Record<string, unknown>).sourceId !== undefined && (requested as Record<string, unknown>).sourceId !== domain)) {
        throw new OperationError('invalid_agent_registration', 'A registration page library is {} or {"sourceId": <domain>}.');
      }
      pageLibrary = { ...(this.pageLibraryRoot ? { root: `${this.pageLibraryRoot}/${domain}` } : {}), sourceId: domain };
    }
    // Runtime corpus lookup also accepts numeric ids and resource names. A
    // factory registration must name a new display-name identity, never one
    // of those alternative lookup spellings for an existing corpus.
    const target = record.targetCorpusDisplayName;
    if (target === undefined && !pageLibrary) {
      throw new OperationError('invalid_agent_registration', 'A registration needs a page library or a corpus name.');
    }
    if (target !== undefined && (typeof target !== 'string' || target.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(target))) {
      throw new OperationError('invalid_agent_registration', 'A registration corpus name must be a lowercase name beginning with a letter and containing only letters, digits, and single hyphens.');
    }
    // Applied equally to new requests and old persisted registrations, while
    // the strict input shape above prevents callers from choosing sink policy.
    try { return validateAgentRoutingConfig({ [domain]: { ...record, ...(pageLibrary ? { pageLibrary } : {}), ingestion: { importResultSink: 'client' } } }); }
    catch { throw new OperationError('invalid_agent_registration', 'Agent registration settings are invalid.'); }
  }

  private withinLibrary(library: LibraryLocationConfig): boolean {
    return Boolean(this.allowed && library.bucket === this.allowed.bucket &&
      (library.prefix === this.allowed.prefix || library.prefix.startsWith(`${this.allowed.prefix}/`)));
  }
}
