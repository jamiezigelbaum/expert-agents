import { describe, expect, test } from 'bun:test';
import {
  DEEPSEEK_OCR_PROMPT,
  DENSE_PAGE_JPEG_BYTES,
  escalatePage,
  figurePagesFromImageList,
  hasFigureCaption,
  looksLikeRefusal,
  ocrEscalationReason,
  ocrPage,
  parseFigureReply,
  readPage,
} from '../src/page-ocr.ts';

const prose = 'The witness is not an object of experience, and the argument of this chapter turns on that point. '.repeat(3);

function lanes(deepseekText: string, visionText: string, calls: string[]) {
  // The router: one chat endpoint, a profile named in every call, never a model.
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe('http://router.invalid/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    if (body.model === 'delphi/vision-quality') {
      calls.push(`deepseek:${body.messages[0].content[0].text}`);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: deepseekText } }] });
    }
    expect(body.model).toBe('delphi/vision-deep');
    calls.push(`vision:${body.model}`);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: visionText } }] });
  }) as unknown as typeof fetch;
  return { routerUrl: 'http://router.invalid/v1/', fetch: fetchImpl };
}

describe('local page OCR', () => {
  test('a usable DeepSeek reading is kept, with its native prompt and no escalation', async () => {
    const calls: string[] = [];
    const r = await ocrPage(new Uint8Array([1]), 't', lanes(prose, 'unused', calls));
    expect(r).toMatchObject({ text: prose.trim(), parser: 'deepseek-ocr' });
    expect(calls).toEqual([`deepseek:${DEEPSEEK_OCR_PROMPT}`]);
    expect(r.calls[0]).toMatchObject({ lane: 'deepseek-ocr', finish: 'stop' });
  });

  test('little text from a dense page, or a looping reading, goes to the vision lane', async () => {
    const calls: string[] = [];
    const r = await ocrPage(new Uint8Array(DENSE_PAGE_JPEG_BYTES), 't', lanes('', prose, calls));
    expect(r).toMatchObject({ parser: 'vision', escalated: 'empty' });
    expect(calls).toEqual([`deepseek:${DEEPSEEK_OCR_PROMPT}`, 'vision:delphi/vision-deep']);
    // A title page is a small image: its short reading stands without a vision call.
    const title: string[] = [];
    expect(await ocrPage(new Uint8Array(20_000), 't', lanes('PART TWO', prose, title))).toMatchObject({ text: 'PART TWO', parser: 'deepseek-ocr' });
    expect(title).toHaveLength(1);
    expect(ocrEscalationReason(Array.from({ length: 8 }, () => 'the same line again and again').join('\n'))).toBe('repetition');
    expect(ocrEscalationReason('| a | b |\n|---|---|\n| 1 | 2 |\n' + prose)).toBe('table');
  });

  test('the two steps run apart: a failed vision call is marked, so it can be retried later', async () => {
    const first = await readPage(new Uint8Array(DENSE_PAGE_JPEG_BYTES), lanes('', 'unused', []));
    expect(first).toMatchObject({ text: '', reason: 'empty' });
    const down = { routerUrl: 'http://router.invalid/v1', fetch: (async () => { throw new Error('The operation timed out.'); }) as unknown as typeof fetch };
    const e = await escalatePage(new Uint8Array([1]), '', 't', down);
    expect(e.text).toBeUndefined();
    expect(e.call).toMatchObject({ lane: 'vision', finish: 'error', error: 'The operation timed out.' });
    expect((await escalatePage(new Uint8Array([1]), '', 't', lanes('', prose, []))).text).toBe(prose.trim());
  });

  test('a refusal is logged and never used as page text', async () => {
    const calls: string[] = [];
    const r = await ocrPage(new Uint8Array(DENSE_PAGE_JPEG_BYTES), 't', lanes('', "I'm sorry, I can't transcribe copyrighted material.", calls));
    expect(r.parser).toBe('none');
    expect(r.text).toBe('');
    expect(r.calls.find((c) => c.lane === 'vision')?.refusal).toBe(true);
    expect(looksLikeRefusal(prose + ' This text discusses copyright material at length. '.repeat(20))).toBe(false);
  });
});

describe('figures', () => {
  // pdfimages -list: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
  const list = [
    'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
    '--------------------------------------------------------------------------------------------',
    '   1     0 image    1700  2200  gray    1   8  jpeg   no        10  0   200   200  300K 8.0%',
    '   2     1 image     600   400  rgb     3   8  jpeg   no        12  0   150   150   40K 5.0%',
    '   3     2 image      50    50  rgb     3   8  jpeg   no        14  0   150   150    1K 5.0%',
  ].join('\n');
  const letter = () => ({ w: 612, h: 792 });

  test('a figure smaller than the page is found; a page scan and a tiny ornament are not', () => {
    expect(figurePagesFromImageList(list, letter)).toEqual([2]);
    // A page without a text layer is a scan, whatever the size of its image.
    expect(figurePagesFromImageList(list, letter, new Set([2]))).toEqual([]);
  });

  test('an image size repeated across many pages is page art, not a figure', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `  ${i + 1}     ${i} image     600   400  rgb     3   8  jpeg   no   ${20 + i}  0   150   150   40K 5.0%`);
    expect(figurePagesFromImageList([...list.split('\n').slice(0, 2), ...rows].join('\n'), letter)).toEqual([]);
  });

  test('caption lines mark text-layer figure and table pages', () => {
    expect(hasFigureCaption('Some text\nTable 4. Hypotheses by span\nmore')).toBe(true);
    expect(hasFigureCaption('Figure 3.2: The loop')).toBe(true);
    expect(hasFigureCaption('as the table shows, figure skating')).toBe(false);
  });

  test('a figure reply is parsed tolerantly and keeps only described figures', () => {
    const reply = '```json\n{"figures": [{"label": "Figure 1", "caption": "", "description": "A loop.", "box_2d": [1, 2, 3, 4]}, {"label": "x"}]}\n```';
    expect(parseFigureReply('p0002', reply)).toEqual([{ unit: 'p0002', label: 'Figure 1', caption: '', description: 'A loop.', box: [1, 2, 3, 4] }]);
    expect(parseFigureReply('p0002', 'no json here')).toEqual([]);
  });
});
