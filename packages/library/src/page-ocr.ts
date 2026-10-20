// Local page OCR for the page library: nothing on this path can refuse a page.
//
//   1. the PDF text layer (pdftotext, in the caller);
//   2. DeepSeek-OCR through Ollama, with its native "Free OCR." prompt;
//   3. a vision-language lane (an OpenAI-compatible chat endpoint, e.g.
//      Delphi's `delphi/vision-deep`) for pages DeepSeek reads badly: empty,
//      looping, garbled or table pages.
//
// Figure descriptions use the same vision lane. Every call records its finish
// reason, and a reply that reads as a refusal is logged and never used as text.

import { OCR_MIN_CHARS, type FigureRecord } from './page-units.ts';

export const DEEPSEEK_OCR_MODEL = 'deepseek-ocr:latest';
// "Convert the document to markdown." returns empty or grounding-only output
// on many scan pages; the native prompt reads them.
export const DEEPSEEK_OCR_PROMPT = '<image>\nFree OCR.';
export const VISION_LANE_MODEL = 'delphi/vision-deep';

export interface OcrLanes {
  /** Ollama base URL serving DeepSeek-OCR, e.g. http://127.0.0.1:11434 */
  ollamaUrl: string;
  /** OpenAI-compatible base URL (…/v1) serving the vision lane; escalation is off without it. */
  visionUrl?: string;
  visionModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface LaneCall { lane: 'deepseek-ocr' | 'vision'; finish: string; chars: number; ms: number; refusal?: boolean; error?: string }

export interface OcrResult {
  text: string;
  parser: 'deepseek-ocr' | 'vision' | 'none';
  /** Why the page went to the vision lane, if it did. */
  escalated?: string;
  calls: LaneCall[];
}

const REFUSAL = /\b(I('m| am)? (sorry|unable)|I can(not|'t) (help|assist|transcribe|provide|reproduce)|copyright(ed)? (material|content|text))\b/i;

/** A reply that declines instead of transcribing. Checked only on short replies: a page of text that mentions copyright is not a refusal. */
export function looksLikeRefusal(text: string): boolean {
  return text.length < 600 && REFUSAL.test(text);
}

// A 150 dpi page JPEG at least this large carries a lot of ink: little text from it is a failed read,
// while a title, part or blank page is a small image and its short reading stands.
export const DENSE_PAGE_JPEG_BYTES = 150_000;

/** Why a DeepSeek-OCR reading should go to the vision lane, or undefined when it is usable. */
export function ocrEscalationReason(text: string, imageBytes = Number.POSITIVE_INFINITY): string | undefined {
  const body = text.replace(/\s+/g, ' ').trim();
  if (body.replace(/\s/g, '').length < OCR_MIN_CHARS) return imageBytes >= DENSE_PAGE_JPEG_BYTES ? 'empty' : undefined;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 8);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (lines.length >= 6 && Math.max(...counts.values()) >= Math.max(4, lines.length * 0.3)) return 'repetition';
  if (/<table\b|^\s*\|.*\|\s*$/m.test(text)) return 'table';
  const letters = (body.match(/\p{L}/gu) ?? []).length;
  if (letters / body.length < 0.55) return 'garbled';
  return undefined;
}

export function stripGrounding(text: string): string {
  return text.replace(/<\|ref\|>.*?<\|\/ref\|><\|det\|>.*?<\|\/det\|>/gs, '').replace(/<\|\/?(ref|det|grounding)\|>/g, '').trim();
}

async function deepseek(img: Uint8Array, lanes: OcrLanes): Promise<{ text: string; call: LaneCall }> {
  const t = Date.now();
  const f = lanes.fetch ?? fetch;
  const res = await f(`${lanes.ollamaUrl.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DEEPSEEK_OCR_MODEL, prompt: DEEPSEEK_OCR_PROMPT, images: [Buffer.from(img).toString('base64')], stream: false, options: { num_predict: 4096, temperature: 0 } }),
    signal: AbortSignal.timeout(lanes.timeoutMs ?? 600_000),
  });
  if (!res.ok) throw new Error(`DeepSeek-OCR answered ${res.status}`);
  const r = await res.json() as { response?: string; done_reason?: string };
  const text = stripGrounding(r.response ?? '');
  return { text, call: { lane: 'deepseek-ocr', finish: r.done_reason ?? 'unknown', chars: text.length, ms: Date.now() - t, ...(looksLikeRefusal(text) ? { refusal: true } : {}) } };
}

/** One chat call to the vision lane. `tag` makes each prompt unique (the lane caches prompt prefixes). */
export async function visionCall(img: Uint8Array, prompt: string, tag: string, lanes: OcrLanes): Promise<{ text: string; call: LaneCall }> {
  if (!lanes.visionUrl) throw new Error('no vision lane configured');
  const t = Date.now();
  const f = lanes.fetch ?? fetch;
  const res = await f(`${lanes.visionUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: lanes.visionModel ?? VISION_LANE_MODEL, temperature: 0, max_tokens: 6000,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `[${tag}] ${prompt}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(img).toString('base64')}` } },
      ] }],
    }),
    signal: AbortSignal.timeout(lanes.timeoutMs ?? 3_600_000),
    // The lane queues requests (one at a time, and while memory is short); Bun's own
    // 300 s idle timeout would cut a queued call off before the signal above.
    timeout: false,
  } as RequestInit);
  if (!res.ok) throw new Error(`vision lane answered ${res.status}`);
  const r = await res.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
  const choice = r.choices?.[0];
  const text = (choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { text, call: { lane: 'vision', finish: choice?.finish_reason ?? 'unknown', chars: text.length, ms: Date.now() - t, ...(looksLikeRefusal(text) ? { refusal: true } : {}) } };
}

const TRANSCRIBE_PROMPT = 'Transcribe this book page faithfully as Markdown in reading order: headings, running text, footnotes; '
  + 'tables as Markdown tables; equations as LaTeX. Do not summarise or comment. Output only the transcription.';

/** Step one: DeepSeek-OCR's reading of a page, and why it should go to the vision lane, if it should. */
export async function readPage(img: Uint8Array, lanes: OcrLanes): Promise<{ text: string; reason?: string; calls: LaneCall[] }> {
  const t = Date.now();
  try {
    const d = await deepseek(img, lanes);
    if (d.call.refusal) return { text: '', reason: 'refusal', calls: [d.call] };
    const reason = ocrEscalationReason(d.text, img.length);
    return { text: d.text, ...(reason ? { reason } : {}), calls: [d.call] };
  } catch (error) {
    return { text: '', reason: 'deepseek_failed', calls: [{ lane: 'deepseek-ocr', finish: 'error', chars: 0, ms: Date.now() - t, error: (error as Error).message.slice(0, 120) }] };
  }
}

/**
 * Step two: the vision lane's transcription of a page DeepSeek read badly. `text` is set only when
 * it should replace DeepSeek's reading; a call that failed has finish 'error' and can be retried.
 */
export async function escalatePage(img: Uint8Array, first: string, tag: string, lanes: OcrLanes): Promise<{ text?: string; call: LaneCall }> {
  const t = Date.now();
  try {
    const v = await visionCall(img, TRANSCRIBE_PROMPT, tag, lanes);
    // The vision reading wins unless DeepSeek read more (a table page it did read keeps the fuller one).
    const wins = !v.call.refusal && v.text.trim() !== '' && v.text.length >= first.length * 0.8;
    return { ...(wins ? { text: v.text } : {}), call: v.call };
  } catch (error) {
    return { call: { lane: 'vision', finish: 'error', chars: 0, ms: Date.now() - t, error: (error as Error).message.slice(0, 120) } };
  }
}

/** OCR one rendered page (JPEG): DeepSeek-OCR first, the vision lane when DeepSeek's reading is unusable. */
export async function ocrPage(img: Uint8Array, tag: string, lanes: OcrLanes): Promise<OcrResult> {
  const r = await readPage(img, lanes);
  if (!r.reason) return { text: r.text, parser: r.text ? 'deepseek-ocr' : 'none', calls: r.calls };
  if (lanes.visionUrl) {
    const v = await escalatePage(img, r.text, tag, lanes);
    r.calls.push(v.call);
    if (v.text !== undefined) return { text: v.text, parser: 'vision', escalated: r.reason, calls: r.calls };
  }
  // A short or imperfect reading still beats none; the caller lists near-empty units.
  return { text: r.text, parser: r.text.trim() ? 'deepseek-ocr' : 'none', escalated: r.reason, calls: r.calls };
}

const FIGURE_PROMPT = [
  'This is one page of a book. List the figures on it: diagrams, charts, tables, maps, photographs, illustrations.',
  'Ignore decorative ornaments, logos and running heads. Return JSON only:',
  '{"figures": [{"label": "<printed label such as Figure 3.2, or empty>", "caption": "<printed caption, or empty>",',
  ' "box_2d": [ymin, xmin, ymax, xmax] (0-1000, tight around the figure),',
  ' "description": "<2-5 sentences: what it shows, its labels, axes or parts and how they relate, and the point it makes>"}]}',
  'Return {"figures": []} when the page has none.',
].join('\n');

export function parseFigureReply(unit: string, text: string): FigureRecord[] {
  const json = /\{[\s\S]*\}/.exec(text.replace(/```(json)?/g, ''))?.[0];
  if (!json) return [];
  let v: { figures?: Array<{ label?: unknown; caption?: unknown; description?: unknown; box_2d?: unknown }> };
  try { v = JSON.parse(json); } catch { return []; }
  const out: FigureRecord[] = [];
  for (const f of Array.isArray(v.figures) ? v.figures : []) {
    const description = typeof f.description === 'string' ? f.description.trim() : '';
    if (!description) continue;
    const box = Array.isArray(f.box_2d) && f.box_2d.length === 4 && f.box_2d.every((x) => typeof x === 'number')
      ? f.box_2d as [number, number, number, number] : undefined;
    out.push({ unit, label: typeof f.label === 'string' ? f.label.trim() : '', caption: typeof f.caption === 'string' ? f.caption.trim() : '', description, ...(box ? { box } : {}) });
  }
  return out;
}

/** Describe the figures on one rendered page with the vision lane. */
export async function describeFigures(img: Uint8Array, unit: string, tag: string, lanes: OcrLanes): Promise<{ figures: FigureRecord[]; call: LaneCall }> {
  const v = await visionCall(img, FIGURE_PROMPT, tag, lanes);
  return { figures: v.call.refusal ? [] : parseFigureReply(unit, v.text), call: v.call };
}

/**
 * Pages holding an embedded image that is not a whole-page scan, from
 * `pdfimages -list` output. Judged per page: a scanned book's full-page images
 * are skipped, and a figure on a text-layer page is still found.
 */
export function figurePagesFromImageList(
  list: string,
  pageSize: (page: number) => { w: number; h: number } | undefined,
  scanPages: ReadonlySet<number> = new Set(),
): number[] {
  const pages = new Set<number>();
  const images: Array<{ page: number; w: number; h: number; xppi: number; yppi: number }> = [];
  for (const line of list.split('\n').slice(2)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 14 || !/^\d+$/.test(c[0]!) || c[2] !== 'image') continue;
    images.push({ page: Number(c[0]), w: Number(c[3]), h: Number(c[4]), xppi: Number(c[12]), yppi: Number(c[13]) });
  }
  // An image size repeated across many pages is page art, a running ornament or a scan, not a figure.
  const bySize = new Map<string, Set<number>>();
  for (const i of images) bySize.set(`${i.w}x${i.h}`, (bySize.get(`${i.w}x${i.h}`) ?? new Set()).add(i.page));
  for (const { page, w, h, xppi, yppi } of images) {
    // A page without a text layer is a scan: its figures are reached by viewing the page.
    if (scanPages.has(page) || w < 120 || h < 120) continue;
    if ((bySize.get(`${w}x${h}`)?.size ?? 0) >= 8) continue;
    const size = pageSize(page);
    // Printed size of the image, in points, against the page.
    // A page scan (with its margins) covers most of the page; a figure does not.
    if (size && xppi > 0 && yppi > 0) {
      const share = (w / xppi * 72) * (h / yppi * 72) / (size.w * size.h);
      if (share > 0.6 || share < 0.02) continue;
    }
    pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** A text-layer page carrying a figure or table caption line: its figure may be vector art or a set table. */
export function hasFigureCaption(text: string): boolean {
  return /^\s*(Figure|Fig\.|Table|Chart|Diagram|Plate)\s+[0-9IVX]+[A-Za-z]?(\.\d+)?\b/m.test(text);
}
