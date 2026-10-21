import { describe, expect, test } from 'bun:test';
import { formatTimecode, isMediaFile, splitFrontmatter, timedSections } from '../src/index.ts';

describe('transcript sections', () => {
  test('cut at paragraph boundaries into time-ranged sections with timestamp markers', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ start: i * 20, end: i * 20 + 19, text: Array.from({ length: 100 }, () => 'word').join(' ') }));
    const units = timedSections(segments, 500);
    expect(units.map((u) => u.heading)).toEqual(['00:00:00–00:01:59', '00:02:00–00:03:19']);
    expect(units[0]).toMatchObject({ unit: 's0001', start: 0, end: 119, parser: 'transcription' });
    // Paragraphs open with their start time and span under a minute.
    expect(units[0]!.text.split('\n\n').map((p) => p.slice(0, 10))).toEqual(['[00:00:00]', '[00:01:00]']);
  });

  test('timecodes and media detection', () => {
    expect(formatTimecode(3725.9)).toBe('01:02:05');
    expect(isMediaFile('/x/talk.MP4')).toBe(true);
    expect(isMediaFile('/x/book.pdf')).toBe(false);
  });
});

describe('text front matter', () => {
  test('is metadata, not text', () => {
    const { meta, body } = splitFrontmatter('---\nsource_url: "https://example.org/a"\ntitle: "A: B"\nwarnings: ["x"]\n---\n\n# A\n\nBody.');
    expect(meta).toEqual({ source_url: 'https://example.org/a', title: 'A: B' });
    expect(body.trim()).toBe('# A\n\nBody.');
    expect(splitFrontmatter('No front matter.\n---\n')).toEqual({ meta: {}, body: 'No front matter.\n---\n' });
  });
});
