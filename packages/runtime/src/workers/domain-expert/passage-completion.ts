// Sentence completion for retrieved passages (owner request 2026-09-23).
//
// Vertex RAG chunks by token count (RAG_CHUNK_TOKENS), so a retrieved chunk
// can stop or start in the middle of a sentence. A public expert quoted
// "...There is no condition of physical" because the chunk ended there. When a passage
// is cut mid-sentence and the worker can read the chunk's source text, the
// passage is extended from that text to the sentence's end (and back to its
// start), within a small bound. Anything uncertain leaves the passage exactly
// as retrieved: completion must never fail or distort an answer.
//
// The chunk is not a verbatim substring of its source. Vertex's parser drops
// Markdown link targets, pandoc anchors, heading marks and NUL bytes (seen on
// a live corpus). The chunk is therefore located by its first and last
// few words, matched with gaps that tolerate exactly that removed markup.

/** Extra characters a passage may gain at each end. */
export const PASSAGE_COMPLETION_MAX_CHARS = 600;
/**
 * A completed passage never exceeds this many UTF-8 bytes, so a consumer's
 * per-passage cap (a public provider keeps 6,000 bytes) cannot cut the sentence the
 * completion just finished. A passage already at or above it is left alone.
 */
export const PASSAGE_COMPLETION_MAX_BYTES = 6000;

const ANCHOR_MIN_CHARS = 40;
const ANCHOR_MAX_TOKENS = 12;
const ANCHOR_MAX_TOKEN_CHARS = 80;
const MAX_ANCHOR_MATCHES = 50;
// Raw source read beyond the chunk: room for the markup the parser removed.
const RAW_WINDOW_CHARS = PASSAGE_COMPLETION_MAX_CHARS * 4;

// Letter runs and digit runs are separate words: a footnote marker the parser
// joined to its word ("argued[3](#n18)" became "argued3") still anchors.
const TOKEN = /[\p{L}\p{M}]+|\p{N}+/gu;
// Between two matched words the source may carry whitespace, punctuation and
// the markup Vertex drops from the chunk: `](#target)`, `[]{#anchor}`, `{#id}`.
const GAP = String.raw`(?:[^\p{L}\p{N}\p{M}]|\]\([^)\n]{0,200}\)|\[\]\{[^}\n]{0,200}\}|\{#[^}\n]{0,200}\})*?`;

const TERMINATORS = '.!?…。！？';
const CLOSERS = String.raw`"'”’»)\]*_`;
const ENDS_SENTENCE = new RegExp(`[${TERMINATORS}][${CLOSERS}]*$`, 'u');
// A sentence end inside running text: a terminator (plus closing quotes or
// brackets) followed by whitespace or the end, a full-width terminator on its
// own, or a paragraph break.
const SENTENCE_BOUNDARY = new RegExp(
  String.raw`[.!?…][${CLOSERS}]*(?=\s|$)|[。！？][${CLOSERS}]*|\n[ \t]*\n`,
  'gu',
);
// Short words a period does not end a sentence after.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'rev', 'vs', 'cf', 'eg', 'ie', 'etc', 'viz',
  'p', 'pp', 'ch', 'chap', 'vol', 'vols', 'no', 'nos', 'ed', 'eds', 'trans', 'fig', 'op', 'cit', 'ibid',
]);

export interface PassageCompletion {
  text: string;
  /** True when the passage was extended at either end. */
  completed: boolean;
}

/**
 * Extends `passage` to whole sentences from `source`, the full text of the
 * document it was chunked from. Returns the passage unchanged when it already
 * starts and ends on sentence boundaries, when it cannot be located in the
 * source unambiguously, or when the nearest boundary is out of bounds.
 */
export function completePassageSentences(passage: string, source: string): PassageCompletion {
  const unchanged = { text: passage, completed: false };
  const body = passage.trim();
  if (!body || !source || utf8Length(passage) >= PASSAGE_COMPLETION_MAX_BYTES) return unchanged;
  const location = locatePassage(body, source);
  if (!location) return unchanged;

  let text = body;
  let completed = false;
  if (location.end !== undefined && !ENDS_SENTENCE.test(cleanSourceText(body).trimEnd())) {
    const tail = forwardCompletion(source, location.end, text.replace(/\s+$/u, ''));
    if (tail && utf8Length(text.replace(/\s+$/u, '') + tail) <= PASSAGE_COMPLETION_MAX_BYTES) {
      text = text.replace(/\s+$/u, '') + tail;
      completed = true;
    }
  }
  if (location.start !== undefined) {
    const head = backwardCompletion(source, location.start, text);
    if (head && utf8Length(head + text) <= PASSAGE_COMPLETION_MAX_BYTES) {
      text = head + text;
      completed = true;
    }
  }
  return completed ? { text, completed } : unchanged;
}

interface PassageLocation {
  /** Raw source offset where the passage's text begins. */
  start?: number;
  /** Raw source offset just past the passage's text. */
  end?: number;
}

function locatePassage(body: string, source: string): PassageLocation | undefined {
  const tokens = [...body.matchAll(TOKEN)];
  if (tokens.length === 0) return undefined;
  const headAnchor = anchorPattern(tokens, 'head');
  const tailAnchor = anchorPattern(tokens, 'tail');
  const heads = findAll(source, headAnchor).map((match) => match.index);
  const tails = findAll(source, tailAnchor).map((match) => match.index + match[0].length);
  if (heads.length === 0 && tails.length === 0) return undefined;

  const firstToken = tokens[0]!;
  const lastToken = tokens[tokens.length - 1]!;
  const leading = body.slice(0, firstToken.index);
  const trailing = body.slice(lastToken.index + lastToken[0].length);

  // Chunks overlap and books repeat phrases, so an anchor alone is trusted
  // only when it is unique. With both anchors, the pair whose span best
  // matches the passage's length wins, which also rejects a stray repeat.
  let start: number | undefined;
  let end: number | undefined;
  if (heads.length > 0 && tails.length > 0) {
    const limit = body.length * 3 + RAW_WINDOW_CHARS;
    let best: { start: number; end: number; score: number } | undefined;
    for (const head of heads) {
      for (const tail of tails) {
        const span = tail - head;
        if (span <= 0 || span > limit) continue;
        const score = Math.abs(span - body.length);
        if (!best || score < best.score) best = { start: head, end: tail, score };
      }
    }
    if (best) ({ start, end } = best);
  }
  if (start === undefined && end === undefined) {
    if (heads.length === 1 && tails.length === 0) start = heads[0];
    else if (tails.length === 1 && heads.length === 0) end = tails[0];
    else return undefined;
  }
  return {
    ...(start !== undefined ? { start: skipLeadingPunctuation(source, start, leading) } : {}),
    ...(end !== undefined ? { end: skipTrailingPunctuation(source, end, trailing) } : {}),
  };
}

// The first or last words of the passage, at least ANCHOR_MIN_CHARS of letters,
// as a pattern that tolerates whitespace and stripped markup between them. The
// outermost word may be cut (a chunk can end mid-word), so it is matched as a
// prefix or suffix of the source's word.
function anchorPattern(tokens: RegExpMatchArray[], side: 'head' | 'tail'): RegExp {
  const ordered = side === 'head' ? tokens : [...tokens].reverse();
  const words: string[] = [];
  let chars = 0;
  for (const token of ordered) {
    let word = token[0];
    if (word.length > ANCHOR_MAX_TOKEN_CHARS) {
      // One long run (CJK text has no spaces): its outer end is enough.
      word = side === 'head' ? word.slice(0, ANCHOR_MAX_TOKEN_CHARS) : word.slice(-ANCHOR_MAX_TOKEN_CHARS);
      words.push(word);
      break;
    }
    words.push(word);
    chars += word.length;
    if (chars >= ANCHOR_MIN_CHARS || words.length >= ANCHOR_MAX_TOKENS) break;
  }
  if (side === 'tail') words.reverse();
  return new RegExp(words.map(escapeRegExp).join(GAP), 'gu');
}

function findAll(source: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    matches.push(match);
    if (matches.length > MAX_ANCHOR_MATCHES) return [];
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return matches;
}

// The passage's own punctuation after its last word ("physical," or "end.)")
// is already in the passage; step over it in the source so it is not repeated.
function skipTrailingPunctuation(source: string, end: number, trailing: string): number {
  let position = end;
  for (const char of trailing.replace(/\s+/gu, '')) {
    const found = source.indexOf(char, position);
    if (found === -1 || found - position > 40) break;
    position = found + char.length;
  }
  return position;
}

function skipLeadingPunctuation(source: string, start: number, leading: string): number {
  let position = start;
  for (const char of [...leading.replace(/\s+/gu, '')].reverse()) {
    const found = source.lastIndexOf(char, position - 1);
    if (found === -1 || position - found > 40) break;
    position = found;
  }
  return position;
}

function forwardCompletion(source: string, end: number, body: string): string | undefined {
  // The passage can end inside a link or span whose opening it carried
  // ("argued[3" of "argued[3](#n18)"): drop the orphaned closing half.
  const continuation = cleanSourceText(source.slice(end, end + RAW_WINDOW_CHARS)
    .replace(/^\](?:\([^)\n]{0,200}\)|\{[^}\n]{0,300}\})/u, ''));
  // The chunk stopped at a paragraph break or the end of the document: a
  // heading or a closing line without punctuation is already whole.
  if (!continuation.trim() || /^[ \t]*\n[ \t]*\n/u.test(continuation)) return undefined;
  // Boundaries are judged with the passage's last words in view, so "as Mr"
  // followed by ". Smith" is not taken for a sentence end.
  const joined = body + continuation;
  const boundary = firstSentenceBoundary(joined, body.length);
  if (boundary === undefined || boundary - body.length > PASSAGE_COMPLETION_MAX_CHARS) return undefined;
  const tail = joined.slice(body.length, boundary).replace(/\s+$/u, '');
  return /[\p{L}\p{N}]/u.test(tail) || new RegExp(`^[${TERMINATORS}${CLOSERS}]+$`, 'u').test(tail) ? tail : undefined;
}

function backwardCompletion(source: string, start: number, body: string): string | undefined {
  const windowStart = Math.max(0, start - RAW_WINDOW_CHARS);
  const preceding = cleanSourceText(source.slice(windowStart, start)).replace(/\[$/u, '');
  // The document's own start is a sentence start.
  if (windowStart === 0 && !preceding.trim()) return undefined;
  // The last sentence boundary before the passage, judged with the passage's
  // own first word in view ("true?) are to be" is not a boundary).
  const joined = preceding + cleanSourceText(body);
  let boundary: number | undefined;
  SENTENCE_BOUNDARY.lastIndex = 0;
  for (let match = SENTENCE_BOUNDARY.exec(joined); match && match.index < preceding.length; match = SENTENCE_BOUNDARY.exec(joined)) {
    if (isSentenceEnd(joined, match)) boundary = match.index + match[0].length;
  }
  if (boundary === undefined) {
    // No boundary in the window: only the document's own start qualifies.
    if (windowStart !== 0) return undefined;
    boundary = 0;
  }
  const head = preceding.slice(boundary).replace(/^\s+/u, '');
  // Nothing but whitespace between that boundary and the passage: the passage
  // already starts a sentence.
  if (!/[\p{L}\p{N}]/u.test(head) || head.length > PASSAGE_COMPLETION_MAX_CHARS) return undefined;
  return head;
}

function firstSentenceBoundary(text: string, from: number): number | undefined {
  SENTENCE_BOUNDARY.lastIndex = from;
  for (let match = SENTENCE_BOUNDARY.exec(text); match; match = SENTENCE_BOUNDARY.exec(text)) {
    if (match[0].startsWith('\n')) return match.index;
    if (isSentenceEnd(text, match)) return match.index + match[0].length;
  }
  return undefined;
}

// A paragraph break always ends a sentence. A terminator does unless it closes
// an abbreviation or the next word starts lowercase ("e.g. the", "true?) are").
function isSentenceEnd(text: string, match: RegExpExecArray): boolean {
  if (match[0].startsWith('\n')) return true;
  if (match[0].startsWith('.') && isAbbreviationBefore(text, match.index)) return false;
  const next = /^\s*(\S)/u.exec(text.slice(match.index + match[0].length, match.index + match[0].length + 40));
  return !next || !/\p{Ll}/u.test(next[1]!);
}

// "Mr.", "e.g.", "pp." and single initials ("J. Krishnamurti") do not end a sentence.
function isAbbreviationBefore(text: string, dot: number): boolean {
  const word = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, dot - 12), dot))?.[1];
  if (!word) return false;
  const bare = word.replace(/\./gu, '').toLowerCase();
  if (ABBREVIATIONS.has(bare)) return true;
  return /^\p{Lu}$/u.test(word) || /^(?:\p{L}\.)+\p{L}$/u.test(word);
}

// Markup removed from the source text a completion quotes, so the added
// words read as prose: what Vertex's parser drops (link targets, anchors,
// heading marks, NULs) and the pandoc residue of converted ebooks (spans with
// attributes, fenced-div lines, bare attribute blocks). A fenced-div line
// becomes a blank line, which is the paragraph break it stands for.
export function cleanSourceText(text: string): string {
  return text
    .replace(/\u0000/gu, '')
    .replace(/^[ \t]*:::.*$/gmu, '')
    .replace(/\[([^\]]{0,300})\]\{[^}\n]{0,300}\}/gu, '$1')
    .replace(/\[([^\]\n]{0,300})\]\([^)\n]{0,200}\)/gu, '$1')
    .replace(/\]?\{(?:#|\.|style=)[^}\n]{0,300}\}\[?/gu, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Source texts read for completion, bounded by total characters and evicted
 * least-recently-used. Failures are remembered briefly, and a bucket that
 * refuses a read (a deployment granted only the manifest) is skipped as a
 * whole, so an unreadable library costs one request per TTL, not one per
 * passage.
 */
export class SourceTextCache {
  private texts = new Map<string, string>();
  private chars = 0;
  private misses = new Map<string, number>();
  private deniedBuckets = new Map<string, number>();

  constructor(
    private readonly maxChars: number,
    private readonly missTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(uri: string): string | undefined {
    const text = this.texts.get(uri);
    if (text === undefined) return undefined;
    this.texts.delete(uri);
    this.texts.set(uri, text);
    return text;
  }

  set(uri: string, text: string): void {
    if (text.length > this.maxChars) return;
    const existing = this.texts.get(uri);
    if (existing !== undefined) {
      this.texts.delete(uri);
      this.chars -= existing.length;
    }
    this.texts.set(uri, text);
    this.chars += text.length;
    for (const [key, value] of this.texts) {
      if (this.chars <= this.maxChars) break;
      this.texts.delete(key);
      this.chars -= value.length;
    }
    this.misses.delete(uri);
  }

  recentlyMissed(uri: string, bucket: string): boolean {
    const now = this.now();
    const denied = this.deniedBuckets.get(bucket);
    if (denied !== undefined && denied > now) return true;
    const missed = this.misses.get(uri);
    return missed !== undefined && missed > now;
  }

  miss(uri: string): void {
    this.misses.set(uri, this.now() + this.missTtlMs);
  }

  deny(bucket: string): void {
    this.deniedBuckets.set(bucket, this.now() + this.missTtlMs);
  }
}

/** A gs:// URI of a text object the worker can read as completion source. */
export function completionSourceObject(uri: unknown): { bucket: string; objectName: string } | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('gs://')) return undefined;
  const rest = uri.slice('gs://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  const objectName = rest.slice(slash + 1).split('#')[0]!;
  // Only text the chunk was parsed from verbatim; a PDF's chunk came through
  // the layout parser and has no text object to extend from.
  if (!/\.(?:md|markdown|txt)$/iu.test(objectName)) return undefined;
  return { bucket: rest.slice(0, slash), objectName };
}
