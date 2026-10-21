// Audio and video for the page library: a local transcript cut into time-ranged
// sections that cite timestamps instead of pages.
//
// The media is downmixed to 16 kHz mono with ffmpeg, then transcribed by the
// transcription profile (`delphi/transcription`, Whisper) of the same local
// model router the OCR lanes use. Nothing on this path is a cloud model or can
// refuse. Segments are grouped into paragraphs that open with their start time
// (`[00:12:31]`), and paragraphs into sections of about 600 words (a few minutes
// of speech), so a citation points at a short stretch of the recording.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { OcrLanes } from './page-ocr.ts';
import { unitName, type PageUnit } from './page-units.ts';

const run = promisify(execFile);

/** The router profile for speech to text. */
export const TRANSCRIPTION_PROFILE = 'delphi/transcription';

/** Media the page library transcribes, by file extension. */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.mp4', '.m4v', '.mov', '.webm', '.mkv',
]);

/** Target section size for a transcript, in words: a few minutes of speech. */
export const MEDIA_SECTION_TARGET_WORDS = 600;
/** A paragraph (one timestamp marker) spans at most this many seconds. */
const PARAGRAPH_SECONDS = 60;

export function isMediaFile(file: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(file).toLowerCase());
}

export interface TranscriptSegment { start: number; end: number; text: string }
export interface Transcript { duration: number; segments: TranscriptSegment[]; ms: number }

/** `3725.4` → `01:02:05`. */
export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export function timeRange(start: number, end: number): string {
  return `${formatTimecode(start)}–${formatTimecode(end)}`;
}

/** Downmix to 16 kHz mono FLAC: a fraction of a video's bytes, and what Whisper reads anyway. */
async function downmix(file: string, dir: string): Promise<string> {
  const out = join(dir, 'audio.flac');
  try {
    await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', out], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') throw new Error('ffmpeg_not_installed: ffmpeg is required to read audio and video');
    throw new Error(`media_unreadable: ffmpeg could not read the audio track (${String((error as { stderr?: unknown }).stderr ?? '').trim().slice(0, 120)})`);
  }
  return out;
}

/** Transcribe one media file through the router's transcription profile. */
export async function transcribeMedia(file: string, lanes: OcrLanes): Promise<Transcript> {
  const dir = await mkdtemp(join(tmpdir(), 'page-media-'));
  const t = Date.now();
  try {
    const audio = await downmix(file, dir);
    const form = new FormData();
    form.set('model', TRANSCRIPTION_PROFILE);
    form.set('response_format', 'verbose_json');
    form.set('temperature', '0');
    form.set('file', new Blob([new Uint8Array(await readFile(audio))], { type: 'audio/flac' }), 'audio.flac');
    const f = lanes.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${lanes.routerUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST', body: form,
        signal: AbortSignal.timeout(lanes.timeoutMs ?? 4 * 3_600_000),
        // The router queues one transcription at a time; Bun's 300 s idle timeout would cut a queued call off.
        timeout: false,
      } as RequestInit);
    } catch (error) {
      throw new Error(`transcription_lane_unavailable: ${(error as Error).message.slice(0, 120)}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(`transcription_lane_failed: ${TRANSCRIPTION_PROFILE} answered ${res.status} ${detail}`.trim());
    }
    const body = await res.json() as { duration?: unknown; segments?: unknown; text?: unknown };
    const segments = (Array.isArray(body.segments) ? body.segments : [])
      .map((s: { start?: unknown; end?: unknown; text?: unknown }) => ({ start: Number(s.start), end: Number(s.end), text: typeof s.text === 'string' ? s.text.trim() : '' }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
    if (!segments.length) throw new Error('transcription_empty: the transcription lane returned no speech segments');
    const duration = Number(body.duration);
    return { duration: Number.isFinite(duration) ? duration : segments.at(-1)!.end, segments, ms: Date.now() - t };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Cut a transcript into time-ranged sections. Paragraphs open with their start
 * time and span up to a minute; sections close at a paragraph boundary once
 * they reach `target` words. Each section's heading is its time range.
 */
export function timedSections(segments: readonly TranscriptSegment[], target = MEDIA_SECTION_TARGET_WORDS): PageUnit[] {
  const paragraphs: Array<{ start: number; end: number; text: string }> = [];
  for (const s of segments) {
    const last = paragraphs.at(-1);
    if (last && s.start - last.start < PARAGRAPH_SECONDS) { last.text += ` ${s.text}`; last.end = s.end; }
    else paragraphs.push({ start: s.start, end: s.end, text: s.text });
  }
  const units: PageUnit[] = [];
  let cur: typeof paragraphs = [];
  let words = 0;
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0]!.start, end = cur.at(-1)!.end;
    units.push({
      unit: unitName('s', units.length + 1), heading: timeRange(start, end), start, end, parser: 'transcription',
      text: cur.map((p) => `[${formatTimecode(p.start)}] ${p.text.replace(/\s+/g, ' ').trim()}`).join('\n\n'),
    });
    cur = [];
    words = 0;
  };
  for (const p of paragraphs) {
    cur.push(p);
    words += p.text.split(/\s+/).length;
    if (words >= target) flush();
  }
  flush();
  return units;
}
