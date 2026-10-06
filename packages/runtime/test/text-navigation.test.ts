import { describe, expect, test } from 'bun:test';
import {
  EXCERPT_MAX_CHARS,
  OUTLINE_MAX_HEADINGS,
  navigateText,
  scanSections,
  TextNavigationError,
  type TextNavigationErrorCode,
  type TextNavigationResult,
  type TextRange,
} from '../src/workers/domain-expert/text-navigation.ts';

test('outline titles and heading counts are bounded, and search rejects lone surrogates', () => {
  expect(navigateText('# ' + 'a'.repeat(10000), { action: 'open' }).sections![0]!.title.length).toBe(300);
  expect(() => navigateText('# x\n'.repeat(50002), { action: 'open' })).toThrow('outline exceeds');
  expect(() => navigateText('test', { action: 'find', query: '\uD800' })).toThrow('query must');
});

function errorCode(run: () => unknown): TextNavigationErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof TextNavigationError) return error.code;
    throw error;
  }
  throw new Error('expected TextNavigationError');
}

type ReadResult = TextNavigationResult & { text: string; range: TextRange; requested_range: { start: number; end: number } };

function requireRead(result: TextNavigationResult): ReadResult {
  if (result.text === undefined || result.range === undefined || result.requested_range === undefined) {
    throw new Error('expected a read result');
  }
  return { ...result, text: result.text, range: result.range, requested_range: result.requested_range };
}

function buildBook(chapters: number, wordsPerChapter: number): string {
  const parts = ['# The Long Book', '', 'A preface paragraph that stands alone.', ''];
  for (let chapter = 1; chapter <= chapters; chapter++) {
    parts.push(`## Chapter ${chapter}`, '', 'lorem ipsum dolor sit amet '.repeat(wordsPerChapter).trim(), '');
  }
  parts.push('References', '', 'reference entry text. '.repeat(200).trim(), '');
  return parts.join('\n');
}

function pageWholeRead(text: string, limit: number): string {
  const pages: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const result = requireRead(navigateText(text, { action: 'read', offset, end: text.length, limit }));
    pages.push(result.text);
    if (result.complete) return pages.join('');
    expect(result.next_offset).toBe(result.range.end);
    offset = result.next_offset!;
  }
  throw new Error('read pagination did not terminate');
}

describe('read', () => {
  const TEXT = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa.';

  test('defaults to the whole text and reports a complete page', () => {
    const result = requireRead(navigateText(TEXT, { action: 'read' }));
    expect(result.text).toBe(TEXT);
    expect(result.range).toEqual({ start: 0, end: TEXT.length, total: TEXT.length, unit: 'utf16' });
    expect(result.requested_range).toEqual({ start: 0, end: TEXT.length });
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('an empty text yields a complete empty read', () => {
    const result = requireRead(navigateText('', { action: 'read' }));
    expect(result.text).toBe('');
    expect(result.range).toEqual({ start: 0, end: 0, total: 0, unit: 'utf16' });
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('a page that reaches the requested end is complete even when the source continues', () => {
    const result = requireRead(navigateText(TEXT, { action: 'read', end: 5, limit: 24000 }));
    expect(result.text).toBe('Alpha');
    expect(result.requested_range).toEqual({ start: 0, end: 5 });
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('an offset equal to end is a complete empty read', () => {
    const result = requireRead(navigateText(TEXT, { action: 'read', offset: 4, end: 4 }));
    expect(result.text).toBe('');
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('paging by limit reconstructs the whole book exactly', () => {
    const book = buildBook(6, 200);
    expect(book.length).toBeGreaterThan(24000);
    expect(pageWholeRead(book, 24000)).toBe(book);
  });

  test('a tiny limit still reconstructs the text and never stalls', () => {
    const text = 'one two three four five six seven eight nine ten';
    expect(pageWholeRead(text, 2)).toBe(text);
  });

  test('rejects read limits outside 2..24000', () => {
    expect(errorCode(() => navigateText(TEXT, { action: 'read', limit: 1 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText(TEXT, { action: 'read', limit: 24001 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText(TEXT, { action: 'read', limit: 2.5 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText(TEXT, { action: 'read', limit: 0 }))).toBe('invalid_limit');
  });
});

describe('utf-16 boundaries', () => {
  const EMOJI = 'a\u{1F600}b';
  const MIXED = 'x a\u{1F600}b😀 y 😀z tail';

  test('rejects a caller offset or end inside a surrogate pair', () => {
    expect(errorCode(() => navigateText(EMOJI, { action: 'read', offset: 2 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText(EMOJI, { action: 'read', end: 2 }))).toBe('invalid_end');
    expect(errorCode(() => navigateText(EMOJI, { action: 'find', query: 'a', offset: 2 }))).toBe('invalid_offset');
  });

  test('reads whole pairs at pair boundaries', () => {
    const result = requireRead(navigateText(EMOJI, { action: 'read', offset: 1, end: 3 }));
    expect(result.text).toBe('\u{1F600}');
    expect(result.complete).toBe(true);
  });

  test('moves a page end down instead of splitting a pair, and reconstructs', () => {
    const first = requireRead(navigateText(EMOJI, { action: 'read', limit: 2 }));
    expect(first.range.end).toBe(1);
    expect(first.text).toBe('a');
    expect(first.complete).toBe(false);
    expect(first.next_offset).toBe(1);
    expect(pageWholeRead(EMOJI, 2)).toBe(EMOJI);
    expect(pageWholeRead(MIXED, 2)).toBe(MIXED);
  });
});

describe('open', () => {
  const DOC = [
    '# Book Title',
    '',
    'Intro paragraph.',
    '',
    '## Chapter One',
    '',
    'Body one.',
    '',
    '### Section 1.1',
    '',
    'Deeper body.',
    '',
    '## Chapter Two',
    '',
    'Body two.',
    '',
    'References',
    '',
    'Reference list entry.',
  ].join('\n');

  test('scans ATX headings and closes a section at the next same-or-higher level', () => {
    const result = navigateText(DOC, { action: 'open' });
    expect(result.total_chars).toBe(DOC.length);
    expect(result.offset_unit).toBe('utf16');
    expect(result.total_sections).toBe(5);
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
    const sections = result.sections!;
    expect(sections.map(section => section.index)).toEqual([0, 1, 2, 3, 4]);
    expect(sections.map(section => section.title))
      .toEqual(['Book Title', 'Chapter One', 'Section 1.1', 'Chapter Two', 'References']);
    expect(sections.map(section => section.level)).toEqual([1, 2, 3, 2, 1]);
    expect(sections[0]!.start).toBe(DOC.indexOf('# Book Title'));
    expect(sections[0]!.end).toBe(DOC.indexOf('References'));
    expect(sections[1]!.end).toBe(DOC.indexOf('## Chapter Two'));
    expect(sections[2]!.end).toBe(DOC.indexOf('## Chapter Two'));
    expect(sections[3]!.end).toBe(DOC.indexOf('References'));
    expect(sections[4]!.end).toBe(DOC.length);
  });

  test('recognizes setext headings and plain standalone section titles', () => {
    const setext = 'Document Title\n==============\n\nSection Name\n------------\n\nbody text\n';
    const result = navigateText(setext, { action: 'open' });
    expect(result.sections!.map(section => [section.title, section.level]))
      .toEqual([['Document Title', 1], ['Section Name', 2]]);
    const plain = 'Notes\n\nsome notes\n\nnotes\n\nmore\n\nWorks Cited\n\nentries\n';
    expect(navigateText(plain, { action: 'open' }).sections!.map(section => section.title))
      .toEqual(['Notes', 'notes', 'Works Cited']);
  });

  test('ignores headings inside fenced code blocks', () => {
    const doc = '# Title\n\n```\n# Not A Heading\n## Also Not\n```\n\n~~~\n# Still Not\n~~~\n\n## Real Heading\n\nbody\n';
    expect(navigateText(doc, { action: 'open' }).sections!.map(section => section.title))
      .toEqual(['Title', 'Real Heading']);
  });

  test('keeps duplicate headings separate so a contents entry never stands in for the section', () => {
    const doc = 'References\n\nA contents line that names the section.\n\nReferences\n\nThe real reference list.\n';
    const result = navigateText(doc, { action: 'open' });
    expect(result.total_sections).toBe(2);
    const [first, second] = result.sections!;
    expect(first!.start).toBe(0);
    expect(second!.start).toBe(doc.indexOf('References', 1));
    expect(first!.end).toBe(second!.start);
    expect(first!.end).not.toBe(doc.length);
  });

  test('paginates the outline by heading index', () => {
    const doc = Array.from({ length: 250 }, (_, index) => `## Heading ${index}`).join('\n');
    const first = navigateText(doc, { action: 'open' });
    expect(first.total_sections).toBe(250);
    expect(first.sections!.length).toBe(100);
    expect(first.complete).toBe(false);
    expect(first.next_offset).toBe(100);
    const second = navigateText(doc, { action: 'open', offset: first.next_offset! });
    expect(second.sections![0]!.index).toBe(100);
    expect(second.next_offset).toBe(200);
    const last = navigateText(doc, { action: 'open', offset: 200 });
    expect(last.sections!.length).toBe(50);
    expect(last.sections![49]!.index).toBe(249);
    expect(last.complete).toBe(true);
    expect(last.next_offset).toBeNull();
    const capped = navigateText(doc, { action: 'open', limit: 200 });
    expect(capped.sections!.length).toBe(OUTLINE_MAX_HEADINGS);
    expect(errorCode(() => navigateText(doc, { action: 'open', limit: 201 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText(doc, { action: 'open', limit: 0 }))).toBe('invalid_limit');
    expect(navigateText(doc, { action: 'open', offset: 250 }).sections).toEqual([]);
    expect(errorCode(() => navigateText(doc, { action: 'open', offset: 251 }))).toBe('invalid_offset');
  });

  test('an empty text has no sections', () => {
    const result = navigateText('', { action: 'open' });
    expect(result.total_sections).toBe(0);
    expect(result.sections).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });
});

describe('read section', () => {
  const DOC = '# Book Title\n\nIntro.\n\n## Chapter One\n\nBody one.\n\n### Section 1.1\n\nDeep.\n\n## Chapter Two\n\nBody two.\n\nReferences\n\nEntries.\n';

  test('reads exactly the chosen section, exclusive of its end', () => {
    const sections = scanSections(DOC);
    const section = sections[1]!;
    const result = requireRead(navigateText(DOC, { action: 'read', section: 1 }));
    expect(result.text).toBe(DOC.slice(section.start, section.end));
    expect(result.text.startsWith('## Chapter One')).toBe(true);
    expect(result.text.includes('Chapter Two')).toBe(false);
    expect(result.range!.total).toBe(DOC.length);
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('complete on a chosen section never claims the whole source', () => {
    const result = requireRead(navigateText(DOC, { action: 'read', section: 0 }));
    expect(result.complete).toBe(true);
    expect(result.text.length).toBeLessThan(DOC.length);
    expect(result.range!.total).toBe(DOC.length);
  });

  test('an offset may continue within the section bounds', () => {
    const section = scanSections(DOC)[1]!;
    const result = requireRead(navigateText(DOC, { action: 'read', section: 1, offset: section.start + 2 }));
    expect(result.text).toBe(DOC.slice(section.start + 2, section.end));
    expect(result.requested_range).toEqual({ start: section.start + 2, end: section.end });
  });

  test('paging a section reconstructs it exactly', () => {
    const section = scanSections(DOC)[0]!;
    const expected = DOC.slice(section.start, section.end);
    const pages: string[] = [];
    let offset = section.start;
    for (let guard = 0; guard < 1000; guard++) {
      const result = requireRead(navigateText(DOC, { action: 'read', section: 0, offset, limit: 8 }));
      pages.push(result.text);
      if (result.complete) break;
      offset = result.next_offset!;
    }
    expect(pages.join('')).toBe(expected);
  });

  test('rejects a section index or range outside the chosen section', () => {
    const section = scanSections(DOC)[1]!;
    expect(errorCode(() => navigateText(DOC, { action: 'read', section: 99 }))).toBe('invalid_section');
    expect(errorCode(() => navigateText(DOC, { action: 'read', section: 1, offset: 0 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText(DOC, { action: 'read', section: 1, end: DOC.length }))).toBe('invalid_end');
    expect(errorCode(() => navigateText(DOC, { action: 'read', section: -1 }))).toBe('invalid_section');
    expect(errorCode(() => navigateText(DOC, { action: 'read', section: 1.5 }))).toBe('invalid_section');
    expect(section.start).toBeGreaterThan(0);
  });
});

describe('find', () => {
  test('is literal and case-sensitive', () => {
    const result = navigateText('Cat cat CAT', { action: 'find', query: 'cat' });
    expect(result.matches!.map(match => match.start)).toEqual([4]);
    expect(navigateText('a.c abc', { action: 'find', query: 'a.c' }).matches!.map(match => match.start)).toEqual([0]);
    expect(navigateText('x.*y', { action: 'find', query: '.*' }).matches!.map(match => match.start)).toEqual([1]);
  });

  test('reports no matches as a complete empty scan', () => {
    const result = navigateText('nothing here', { action: 'find', query: 'absent' });
    expect(result.matches).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.next_offset).toBeNull();
  });

  test('paginates deterministically and covers the full suffix', () => {
    const haystack = `cat ${'dog cat bird '.repeat(30)}cat tail`;
    const all: number[] = [];
    for (let index = haystack.indexOf('cat'); index !== -1; index = haystack.indexOf('cat', index + 3)) all.push(index);
    const found: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const page = navigateText(haystack, { action: 'find', query: 'cat', offset, limit: 4 });
      for (const match of page.matches!) {
        expect(match.end).toBe(match.start + 3);
        expect(match.excerpt).toContain('cat');
        found.push(match.start);
      }
      if (page.complete) {
        expect(page.next_offset).toBeNull();
        break;
      }
      expect(page.next_offset).toBe(page.matches!.at(-1)!.end);
      offset = page.next_offset!;
    }
    expect(found).toEqual(all);
    expect(found.length).toBeGreaterThan(4);
  });

  test('bounds the excerpt and keeps the match inside it', () => {
    const haystack = `${'padding '.repeat(200)}needle${' trailer'.repeat(200)}`;
    const result = navigateText(haystack, { action: 'find', query: 'needle' });
    const match = result.matches![0]!;
    expect(match.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(match.excerpt).toContain('needle');
  });

  test('validates query, offset and limit', () => {
    expect(errorCode(() => navigateText('abc', { action: 'find' }))).toBe('invalid_query');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: '' }))).toBe('invalid_query');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a'.repeat(201) }))).toBe('invalid_query');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 7 as unknown as string }))).toBe('invalid_query');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a', offset: -1 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a', offset: 4 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a', limit: 0 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a', limit: 101 }))).toBe('invalid_limit');
    expect(errorCode(() => navigateText('abc', { action: 'find', query: 'a', limit: 2.5 }))).toBe('invalid_limit');
  });

  test('finds a surrogate pair literally', () => {
    const result = navigateText('x\u{1F600}y\u{1F600}z', { action: 'find', query: '\u{1F600}' });
    expect(result.matches!.map(match => [match.start, match.end])).toEqual([[1, 3], [4, 6]]);
  });
});

describe('validation and safe errors', () => {
  test('validates the text, request and action', () => {
    expect(errorCode(() => navigateText(123 as unknown as string, { action: 'read' }))).toBe('invalid_text');
    expect(errorCode(() => navigateText('abc', { action: 'delete' }))).toBe('invalid_action');
    expect(errorCode(() => navigateText('abc', undefined as unknown as { action: string }))).toBe('invalid_action');
    expect(errorCode(() => navigateText('abc', {} as { action: string }))).toBe('invalid_action');
  });

  test('validates offsets and ends strictly', () => {
    expect(errorCode(() => navigateText('abc', { action: 'read', offset: -1 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText('abc', { action: 'read', offset: 4 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText('abc', { action: 'read', offset: 1.5 }))).toBe('invalid_offset');
    expect(errorCode(() => navigateText('abc', { action: 'read', offset: 2, end: 1 }))).toBe('invalid_end');
    expect(errorCode(() => navigateText('abc', { action: 'read', end: 4 }))).toBe('invalid_end');
    expect(errorCode(() => navigateText('abc', { action: 'read', end: 1.5 }))).toBe('invalid_end');
  });

  test('error messages are fixed and never echo caller text or query', () => {
    const secretText = 'SECRETSENTINEL body text';
    const secretQuery = 'QUERYSENTINEL'.repeat(20);
    try {
      navigateText(secretText, { action: 'find', query: secretQuery });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TextNavigationError);
      const failure = error as TextNavigationError;
      expect(failure.code).toBe('invalid_query');
      expect(failure.message).not.toContain('QUERYSENTINEL');
      expect(failure.message).not.toContain('SECRETSENTINEL');
      expect(failure.message.length).toBeGreaterThan(0);
    }
    try {
      navigateText(secretText, { action: 'find', query: 'SENTINELQ', offset: -3 });
      throw new Error('expected a throw');
    } catch (error) {
      const failure = error as TextNavigationError;
      expect(failure.code).toBe('invalid_offset');
      expect(failure.message).not.toContain('SENTINELQ');
    }
  });
});
