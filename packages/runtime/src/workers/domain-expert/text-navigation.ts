// Pure deterministic navigation of long source text (owner request 2026-10-06).
//
// A book, or a reference section of one, does not fit one model response. A
// consumer asks `open` for the heading outline, then pages through a section
// with `read` and searches it with `find`, addressing everything by UTF-16
// offset. Offsets never split a surrogate pair: a caller boundary inside one is
// rejected, and a page end that would split one is moved down. This module
// performs no filesystem or network I/O, and every failure carries a fixed
// content-free message, so a navigation error is safe to log or return verbatim.

export type NavigateAction = 'open' | 'find' | 'read';

export interface NavigateRequest {
  /** `open`, `find` or `read`; validated at runtime. */
  action: string;
  /** UTF-16 start offset (`read`, `find`) or heading index (`open`). */
  offset?: number;
  /** UTF-16 end offset, exclusive (`read` only). */
  end?: number;
  /** Zero-based heading index reported by `open` (`read` only). */
  section?: number;
  /** Literal, case-sensitive search text (`find` only). */
  query?: string;
  /** Page size in UTF-16 characters or headings, depending on the action. */
  limit?: number;
}

export type TextRange = { start: number; end: number; total: number; unit: 'utf16' };
export type TextSection = { index: number; title: string; level: number; start: number; end: number };
export type TextMatch = { start: number; end: number; excerpt: string };

// A type alias, not an interface: the implicit index signature makes a result
// assignable to consumers that pass it through `Record<string, unknown>`.
export type TextNavigationResult = {
  action: NavigateAction;
  complete: boolean;
  next_offset: number | null;
  text?: string;
  range?: TextRange;
  requested_range?: { start: number; end: number };
  matches?: TextMatch[];
  sections?: TextSection[];
  total_sections?: number;
  total_chars?: number;
  offset_unit?: 'utf16';
};

export const READ_DEFAULT_LIMIT = 12000;
export const READ_MIN_LIMIT = 2;
export const READ_MAX_LIMIT = 24000;
export const OPEN_DEFAULT_LIMIT = 100;
export const OPEN_MAX_LIMIT = 200;
export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 100;
export const QUERY_MAX_CHARS = 200;
export const EXCERPT_MAX_CHARS = 300;
/** Longest outline (`open`) page, in headings, whatever limit was requested. */
export const OUTLINE_MAX_HEADINGS = 200;

const CODE_MESSAGES = {
  invalid_text: 'text must be a string',
  invalid_action: 'action must be open, find or read',
  invalid_offset: 'offset is not an integer UTF-16 boundary within the allowed range',
  invalid_end: 'end is not an integer UTF-16 boundary within the allowed range',
  invalid_limit: 'limit is outside the allowed range',
  invalid_query: 'query must be a literal string of 1 to 200 characters',
  invalid_section: 'section is not a heading index reported by open',
  outline_too_large: 'outline exceeds the heading limit; use find and explicit text ranges',
} as const;

export type TextNavigationErrorCode = keyof typeof CODE_MESSAGES;

export class TextNavigationError extends Error {
  readonly code: TextNavigationErrorCode;

  constructor(code: TextNavigationErrorCode) {
    super(CODE_MESSAGES[code]);
    this.name = 'TextNavigationError';
    this.code = code;
  }
}

const PLAIN_HEADINGS = new Set(['references', 'bibliography', 'works cited', 'notes', 'index']);

/**
 * Navigates `text` for one `request`. See the action helpers for the shape each
 * action returns; invalid input throws {@link TextNavigationError} and never
 * echoes caller text or query content in its message.
 */
export function navigateText(text: string, request: NavigateRequest): TextNavigationResult {
  if (typeof text !== 'string') throw fail('invalid_text');
  if (!request || typeof request !== 'object') throw fail('invalid_action');
  switch (request.action) {
    case 'open':
      return openAction(text, request);
    case 'find':
      return findAction(text, request);
    case 'read':
      return readAction(text, request);
    default:
      throw fail('invalid_action');
  }
}

function openAction(text: string, request: NavigateRequest): TextNavigationResult {
  const sections = scanSections(text);
  const total = sections.length;
  // `open` paginates by heading index: `offset` selects the first heading.
  const start = boundedInteger(request.offset, 0, 0, total, 'invalid_offset');
  const limit = boundedInteger(request.limit, OPEN_DEFAULT_LIMIT, 1, OPEN_MAX_LIMIT, 'invalid_limit');
  const pageEnd = Math.min(total, start + limit);
  const complete = pageEnd >= total;
  return {
    action: 'open',
    total_chars: text.length,
    offset_unit: 'utf16',
    total_sections: total,
    sections: sections.slice(start, pageEnd).slice(0, OUTLINE_MAX_HEADINGS),
    requested_range: { start, end: pageEnd },
    complete,
    next_offset: complete ? null : pageEnd,
  };
}

function readAction(text: string, request: NavigateRequest): TextNavigationResult {
  const sections = request.section === undefined ? [] : scanSections(text);
  let minOffset = 0;
  let maxOffset = text.length;
  if (request.section !== undefined) {
    const index = request.section;
    if (!Number.isInteger(index) || index < 0 || index >= sections.length) throw fail('invalid_section');
    const section = sections[index]!;
    // A chosen section bounds the read: `offset` may continue inside it.
    minOffset = section.start;
    maxOffset = section.end;
  }
  const offset = request.offset === undefined
    ? minOffset
    : boundary(text, request.offset, minOffset, maxOffset, 'invalid_offset');
  const end = request.end === undefined
    ? maxOffset
    : boundary(text, request.end, offset, maxOffset, 'invalid_end');
  const limit = boundedInteger(request.limit, READ_DEFAULT_LIMIT, READ_MIN_LIMIT, READ_MAX_LIMIT, 'invalid_limit');
  const pageEnd = floorToBoundary(text, Math.min(end, offset + limit));
  // `complete` means this page reaches the requested end, not the whole source.
  const complete = pageEnd === end;
  return {
    action: 'read',
    text: text.slice(offset, pageEnd),
    range: { start: offset, end: pageEnd, total: text.length, unit: 'utf16' },
    requested_range: { start: offset, end },
    complete,
    next_offset: complete ? null : pageEnd,
  };
}

function findAction(text: string, request: NavigateRequest): TextNavigationResult {
  const query = request.query;
  if (typeof query !== 'string' || query.length < 1 || query.length > QUERY_MAX_CHARS) throw fail('invalid_query');
  if (/[\uD800-\uDFFF]/u.test(query)) throw fail('invalid_query');
  const offset = request.offset === undefined
    ? 0
    : boundary(text, request.offset, 0, text.length, 'invalid_offset');
  const limit = boundedInteger(request.limit, FIND_DEFAULT_LIMIT, 1, FIND_MAX_LIMIT, 'invalid_limit');
  const matches: TextMatch[] = [];
  let cursor = offset;
  let complete = true;
  // Literal scan, never a regex: the query is data, not a pattern.
  for (;;) {
    const found = text.indexOf(query, cursor);
    if (found === -1) break;
    if (matches.length >= limit) {
      // One more match exists past this page: the suffix is not fully returned.
      complete = false;
      break;
    }
    matches.push({ start: found, end: found + query.length, excerpt: excerptAround(text, found, query.length) });
    cursor = found + query.length;
  }
  return {
    action: 'find',
    matches,
    requested_range: { start: offset, end: text.length },
    complete,
    next_offset: complete ? null : matches[matches.length - 1]!.end,
  };
}

interface HeadingMark {
  start: number;
  title: string;
  level: number;
}

/**
 * Scans Markdown headings in document order without a full parser. ATX and
 * setext headings and plain `References`-style section titles are recognized;
 * lines inside fenced code blocks are not. Duplicate titles stay separate
 * paragraphs, so a table-of-contents entry never stands in for the section it
 * names. A section runs to the next heading of the same or a higher level, or
 * to the end of the text.
 */
export function scanSections(text: string): TextSection[] {
  const marks = scanHeadings(text);
  return marks.map((mark, index) => {
    let end = text.length;
    for (let next = index + 1; next < marks.length; next++) {
      if (marks[next]!.level <= mark.level) {
        end = marks[next]!.start;
        break;
      }
    }
    return { index, title: mark.title.slice(0, floorToBoundary(mark.title, Math.min(mark.title.length, 300))), level: mark.level, start: mark.start, end };
  });
}

function scanHeadings(text: string): HeadingMark[] {
  const headings: HeadingMark[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;
  let previousPlain: { start: number; text: string } | null = null;
  let position = 0;
  while (position <= text.length) {
    if (headings.length > 50_000) throw fail('outline_too_large');
    const newline = text.indexOf('\n', position);
    const rawLine = newline === -1 ? text.slice(position) : text.slice(position, newline);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lineStart = position;
    position = newline === -1 ? text.length + 1 : newline + 1;

    if (inFence) {
      if (isFenceClose(line, fenceChar, fenceLength)) inFence = false;
      previousPlain = null;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && (fence[1]![0] === '~' || !fence[2]!.includes('`'))) {
      inFence = true;
      fenceChar = fence[1]![0]!;
      fenceLength = fence[1]!.length;
      previousPlain = null;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && previousPlain) {
      headings.push({
        start: previousPlain.start,
        title: previousPlain.text.trim(),
        level: setext[1]![0] === '=' ? 1 : 2,
      });
      previousPlain = null;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (atx) {
      const title = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      headings.push({ start: lineStart, title, level: atx[1]!.length });
      previousPlain = null;
      continue;
    }
    const plain = line.trim();
    if (plain === '') {
      previousPlain = null;
      continue;
    }
    if (PLAIN_HEADINGS.has(plain.toLowerCase())) {
      headings.push({ start: lineStart, title: plain, level: 1 });
      previousPlain = null;
      continue;
    }
    previousPlain = { start: lineStart, text: line };
  }
  return headings;
}

function isFenceClose(line: string, fenceChar: string, fenceLength: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fenceLength) return false;
  for (const char of trimmed) if (char !== fenceChar) return false;
  return true;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: TextNavigationErrorCode,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw fail(code);
  return value;
}

function boundary(
  text: string,
  value: number,
  min: number,
  max: number,
  code: 'invalid_offset' | 'invalid_end',
): number {
  if (!Number.isInteger(value) || value < min || value > max || splitsPair(text, value)) throw fail(code);
  return value;
}

/** Moves an exclusive end down so it never lands inside a surrogate pair. */
function floorToBoundary(text: string, index: number): number {
  return splitsPair(text, index) ? index - 1 : index;
}

/** Moves an inclusive start up so it never lands inside a surrogate pair. */
function ceilToBoundary(text: string, index: number): number {
  return splitsPair(text, index) ? index + 1 : index;
}

function splitsPair(text: string, index: number): boolean {
  return index > 0 && index < text.length
    && isLowSurrogate(text.charCodeAt(index))
    && isHighSurrogate(text.charCodeAt(index - 1));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function excerptAround(text: string, matchStart: number, matchLength: number): string {
  // Enough leading context to read the match; the window still holds a
  // maximum-length query because the lead is EXCERPT_MAX_CHARS - QUERY_MAX_CHARS.
  const lead = EXCERPT_MAX_CHARS - QUERY_MAX_CHARS;
  const start = ceilToBoundary(text, Math.max(0, matchStart - lead));
  const end = floorToBoundary(text, Math.min(text.length, start + EXCERPT_MAX_CHARS));
  return text.slice(start, end);
}

function fail(code: TextNavigationErrorCode): TextNavigationError {
  return new TextNavigationError(code);
}
