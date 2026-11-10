// Notion API client and Notion-to-markdown rendering for page-library ingest.
import type { DomainExpertNotionConfig } from './worker-config.ts';
import {
  normalizePositiveInteger, asRecord, safeObjectName, asOptionalRecord, sleepMs, retryAfterMs, yamlValue,
  indentMarkdown, escapeHtml,
} from './worker-util.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';

const NOTION_BASE_URL = 'https://api.notion.com/v1';
const NOTION_DEFAULT_VERSION = '2022-06-28';
export const NOTION_DEFAULT_MAX_OBJECTS = 200;
const NOTION_DEFAULT_DEPTH = 6;
const NOTION_MAX_RETRIES = 3;

interface NotionObjectMetadata {
  objectId: string;
  objectType: 'page' | 'database';
  title: string;
  childBlockCount?: number;
  rowPageCount?: number;
  skippedObjectCount: number;
  warnings: string[];
}

interface NotionMarkdownDerivative {
  objectId: string;
  objectType: 'page';
  title: string;
  fileName: string;
  bytes: Uint8Array;
  sourceUrl?: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
}

interface NotionDatabasePageList {
  databaseId: string;
  databaseTitle: string;
  pages: Array<{ objectId: string; title: string }>;
  skipped: number;
  warnings: string[];
}

export class NotionRuntimeClient {
  private config: DomainExpertNotionConfig;

  constructor(config: DomainExpertNotionConfig) {
    this.config = config;
  }

  configured(): boolean {
    return Boolean(this.config.token?.trim());
  }

  notionVersion(): string {
    return this.config.notionVersion?.trim() || NOTION_DEFAULT_VERSION;
  }

  maxObjects(): number {
    return normalizePositiveInteger(this.config.maxObjects, NOTION_DEFAULT_MAX_OBJECTS);
  }

  async probe(): Promise<void> {
    await this.notionJson('/users/me');
  }

  async inspectObject(id: string, preferredType?: 'page' | 'database'): Promise<NotionObjectMetadata> {
    const objectId = normalizeNotionObjectId(id);
    if (preferredType === 'database') return this.inspectDatabase(objectId);
    if (preferredType === 'page') return this.inspectPage(objectId);
    try {
      return await this.inspectPage(objectId);
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && error.status === 404) return this.inspectDatabase(objectId);
      throw error;
    }
  }

  async fetchPageMarkdown(input: {
    id: string;
    sourceUrl?: string;
    retrievedAt: string;
    filePrefix?: string;
    /** Between top-level blocks; a blank line makes each block its own paragraph. */
    blockSeparator?: string;
  }): Promise<NotionMarkdownDerivative> {
    const objectId = normalizeNotionObjectId(input.id);
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const title = notionTitleFromObject(page) || 'Untitled Notion page';
    const warnings: string[] = [];
    const blocks = await this.fetchBlocksMarkdown(objectId, 0, warnings, { remaining: this.maxObjects() });
    const parent = notionParentIds(page);
    const markdown = notionMarkdownDocument({
      objectId,
      objectType: 'page',
      retrievedAt: input.retrievedAt,
      title,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
      body: blocks.join(input.blockSeparator ?? '\n').trim(),
    });
    return {
      objectId,
      objectType: 'page',
      title,
      fileName: `${input.filePrefix ? `${safeObjectName(input.filePrefix)}/` : ''}${safeObjectName(title)}-${objectId.slice(0, 8)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
    };
  }

  async listDatabasePages(databaseIdValue: string): Promise<NotionDatabasePageList> {
    const databaseId = normalizeNotionObjectId(databaseIdValue);
    const database = asRecord(await this.notionJson(`/databases/${databaseId}`), 'notion database');
    const databaseTitle = notionTitleFromObject(database) || 'Untitled Notion database';
    const pages: Array<{ objectId: string; title: string }> = [];
    const warnings: string[] = [];
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const result of results) {
        if (pages.length >= this.maxObjects()) {
          skipped += 1;
          continue;
        }
        const row = asOptionalRecord(result);
        const id = typeof row?.id === 'string' ? normalizeNotionObjectId(row.id) : undefined;
        if (!id || !row) continue;
        pages.push({ objectId: id, title: notionTitleFromObject(row) || 'Untitled Notion page' });
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
      if (pages.length >= this.maxObjects() && cursor) {
        warnings.push('notion_database_row_count_capped');
        break;
      }
    } while (cursor);
    if (skipped > 0) warnings.push('notion_database_row_count_capped');
    return { databaseId, databaseTitle, pages, skipped, warnings: [...new Set(warnings)] };
  }

  private async inspectPage(objectId: string): Promise<NotionObjectMetadata> {
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const count = await this.countChildBlocks(objectId);
    return {
      objectId,
      objectType: 'page',
      title: notionTitleFromObject(page) || 'Untitled Notion page',
      childBlockCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async inspectDatabase(objectId: string): Promise<NotionObjectMetadata> {
    const database = asRecord(await this.notionJson(`/databases/${objectId}`), 'notion database');
    const count = await this.countDatabaseRows(objectId);
    return {
      objectId,
      objectType: 'database',
      title: notionTitleFromObject(database) || 'Untitled Notion database',
      rowPageCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async countChildBlocks(blockId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_page_block_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async countDatabaseRows(databaseId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_database_row_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async fetchBlocksMarkdown(
    blockId: string,
    depth: number,
    warnings: string[],
    budget: { remaining: number },
  ): Promise<string[]> {
    if (depth >= NOTION_DEFAULT_DEPTH) {
      warnings.push('notion_block_depth_cap_reached');
      return [];
    }
    const rendered: string[] = [];
    let cursor: string | undefined;
    do {
      if (budget.remaining <= 0) {
        warnings.push('notion_page_block_count_capped');
        break;
      }
      const pageSize = Math.min(100, budget.remaining);
      const path = `/blocks/${blockId}/children?page_size=${pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const value of results) {
        if (budget.remaining <= 0) {
          warnings.push('notion_page_block_count_capped');
          break;
        }
        const block = asOptionalRecord(value);
        if (!block) continue;
        budget.remaining -= 1;
        const childMarkdown = block.has_children === true && block.type !== 'child_page'
          ? await this.fetchBlocksMarkdown(String(block.id ?? ''), depth + 1, warnings, budget)
          : [];
        rendered.push(renderNotionBlock(block, childMarkdown, warnings));
      }
      if (budget.remaining <= 0) {
        warnings.push('notion_page_block_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return rendered.filter((entry) => entry.trim().length > 0);
  }

  private async notionJson(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    const token = this.config.token?.trim();
    if (!token) {
      throw new DomainExpertWorkerError(
        503,
        'notion_not_configured',
        'Notion ingest requires EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN.',
      );
    }
    const response = await (this.config.fetchImpl ?? fetch)(`${NOTION_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': this.notionVersion(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 429 && attempt < NOTION_MAX_RETRIES) {
      await sleepMs(retryAfterMs(response.headers.get('retry-after')));
      return this.notionJson(path, init, attempt + 1);
    }
    if (!response.ok) {
      throw new DomainExpertWorkerError(
        response.status,
        'notion_api_error',
        `Notion API request failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  }
}

export function notionObjectIdFromUrlOrId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#/]|$)/);
  if (match?.[1]) return normalizeNotionObjectId(match[1]);
  return normalizeNotionObjectId(trimmed);
}

function normalizeNotionObjectId(value: string): string {
  const compact = value.trim().replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new DomainExpertWorkerError(400, 'invalid_notion_object_id', 'Notion object ids must be 32 hexadecimal characters, with or without dashes.');
  }
  return compact;
}

export function isNotionImportUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(\.|^)notion\.(so|site)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function notionTitleFromObject(record: Record<string, unknown>): string | undefined {
  const directTitle = richTextPlainText(record.title);
  if (directTitle) return directTitle;
  const properties = asOptionalRecord(record.properties);
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    const property = asOptionalRecord(value);
    if (!property) continue;
    if (property.type === 'title') {
      const title = richTextPlainText(property.title);
      if (title) return title;
    }
  }
  return undefined;
}

function notionParentIds(record: Record<string, unknown>): { parentPageId?: string; parentDatabaseId?: string } {
  const parent = asOptionalRecord(record.parent);
  if (!parent) return {};
  const pageId = typeof parent.page_id === 'string' ? normalizeNotionObjectId(parent.page_id) : undefined;
  const databaseId = typeof parent.database_id === 'string' ? normalizeNotionObjectId(parent.database_id) : undefined;
  return {
    ...(pageId ? { parentPageId: pageId } : {}),
    ...(databaseId ? { parentDatabaseId: databaseId } : {}),
  };
}

function notionMarkdownDocument(input: {
  sourceUrl?: string;
  objectId: string;
  objectType: 'page';
  retrievedAt: string;
  title: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
  body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    kind: 'notion',
    title: input.title,
    notion_object_id: input.objectId,
    notion_object_type: input.objectType,
    retrieved_at: input.retrievedAt,
    ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
    ...(input.parentPageId ? { parent_page_id: input.parentPageId } : {}),
    ...(input.parentDatabaseId ? { parent_database_id: input.parentDatabaseId } : {}),
    ...(input.warnings.length ? { warnings: [...new Set(input.warnings)] } : {}),
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}\n---\n\n# ${input.title}\n\n${input.body || '_No readable Notion blocks returned._'}\n`;
}

function renderNotionBlock(block: Record<string, unknown>, childMarkdown: string[], warnings: string[]): string {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  const payload = asOptionalRecord(block[type]) ?? {};
  const text = richTextPlainText(payload.rich_text) ?? '';
  const children = childMarkdown.length ? `\n${indentMarkdown(childMarkdown.join('\n'), type === 'quote' ? '> ' : '  ')}` : '';
  switch (type) {
    case 'paragraph':
      return `${text}${children}`.trim();
    case 'heading_1':
      return `# ${text}`.trim();
    case 'heading_2':
      return `## ${text}`.trim();
    case 'heading_3':
      return `### ${text}`.trim();
    case 'bulleted_list_item':
      return `- ${text}${children}`.trim();
    case 'numbered_list_item':
      return `1. ${text}${children}`.trim();
    case 'to_do':
      return `- [${payload.checked === true ? 'x' : ' '}] ${text}${children}`.trim();
    case 'toggle':
      return `<details><summary>${escapeHtml(text || 'Toggle')}</summary>\n\n${childMarkdown.join('\n')}\n\n</details>`;
    case 'quote':
      return `> ${text}${children}`.trim();
    case 'callout':
      return `> ${text}${children}`.trim();
    case 'code': {
      const language = typeof payload.language === 'string' ? payload.language : '';
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case 'divider':
      return '---';
    case 'table':
      return childMarkdown.join('\n');
    case 'table_row':
      return renderNotionTableRow(payload);
    case 'child_page': {
      const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Child page';
      warnings.push('notion_child_page_not_inlined');
      return `## ${title}\n\n_Notion child page boundary; import this page separately if needed._`;
    }
    case 'bookmark':
    case 'link_preview': {
      const url = typeof payload.url === 'string' ? payload.url : '';
      return url ? `[${text || url}](${url})` : text;
    }
    case 'file':
    case 'pdf':
    case 'image':
    case 'video':
    case 'audio': {
      const url = notionFileUrl(payload);
      warnings.push(`notion_media_not_downloaded:${type}`);
      return url ? `[${text || type}](${url})` : `[${text || type}](notion-media-url-expired)`;
    }
    default:
      warnings.push(`notion_block_unsupported:${type}`);
      return text || `_Unsupported Notion block: ${type}_`;
  }
}

function renderNotionTableRow(payload: Record<string, unknown>): string {
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  return `| ${cells.map((cell) => richTextPlainText(cell) ?? '').join(' | ')} |`;
}

function notionFileUrl(payload: Record<string, unknown>): string | undefined {
  const file = asOptionalRecord(payload.file);
  const external = asOptionalRecord(payload.external);
  return typeof file?.url === 'string' ? file.url : (typeof external?.url === 'string' ? external.url : undefined);
}

function richTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((entry) => asOptionalRecord(entry)?.plain_text)
    .filter((entry): entry is string => typeof entry === 'string')
    .join('')
    .trim();
  return text || undefined;
}
