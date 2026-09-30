import { describe, expect, test } from 'bun:test';
import {
  cleanSourceText,
  completePassageSentences,
  completionSourceObject,
  PASSAGE_COMPLETION_MAX_BYTES,
  SourceTextCache,
} from '../src/workers/domain-expert/passage-completion.ts';

// 2026-09-23: a public expert quoted "...There is no condition of physical" from a
// library passage that broke off mid-sentence. The source paragraph is the
// shape of the live one (Alice Bailey, Discipleship in the New Age I): one long
// paragraph, a parenthetical question inside a sentence, and the live chunk
// began at "are to be subjected", mid-sentence.
const PARAGRAPH = [
  'Many tried disciples and aspirants (should I have said "tired," brother of mine, for I surmise that both words are true?) are to be subjected to experiments which will involve the application of the ancient rules in a modern way.',
  'Disciples in the olden days were the product of more peaceful times.',
  'For disciples, such as those I am now going to attempt to teach, there is no retiring from the world.',
  'There is no condition of physical peace and of quiet wherein the soul may be invoked and in which work may be achieved in the calm of silence.',
  'The work has to go forward in clamour.',
].join(' ');
const SOURCE = `# Chapter One\n\nAn opening paragraph that stands alone.\n\n${PARAGRAPH}\n\nThe next paragraph begins here and ends here.\n`;

describe('completePassageSentences', () => {
  test('extends a passage cut mid-sentence to the end of that sentence', () => {
    const passage = 'Disciples in the olden days were the product of more peaceful times. For disciples, such as those I am now going to attempt to teach, there is no retiring from the world. There is no condition of physical';
    const result = completePassageSentences(passage, SOURCE);
    expect(result.completed).toBe(true);
    expect(result.text).toBe(`${passage} peace and of quiet wherein the soul may be invoked and in which work may be achieved in the calm of silence.`);
  });

  test('a chunk cut mid-word finishes the word without repeating it', () => {
    const passage = 'For disciples, such as those I am now going to attempt to teach, there is no retiring from the world. There is no condition of phys';
    const result = completePassageSentences(passage, SOURCE);
    expect(result.text.endsWith('There is no condition of physical peace and of quiet wherein the soul may be invoked and in which work may be achieved in the calm of silence.')).toBe(true);
  });

  test("the passage's own trailing punctuation is not repeated", () => {
    const source = 'We begin somewhere else entirely. The teacher said, quietly and at length, that the work continues. Then more.';
    const passage = 'We begin somewhere else entirely. The teacher said,';
    expect(completePassageSentences(passage, source).text)
      .toBe('We begin somewhere else entirely. The teacher said, quietly and at length, that the work continues.');
  });

  test('extends a leading partial sentence back to its start, across a parenthetical question', () => {
    const passage = 'are to be subjected to experiments which will involve the application of the ancient rules in a modern way. Disciples in the olden days were the product of more peaceful times.';
    const result = completePassageSentences(passage, SOURCE);
    expect(result.completed).toBe(true);
    expect(result.text).toBe(`Many tried disciples and aspirants (should I have said "tired," brother of mine, for I surmise that both words are true?) ${passage}`);
  });

  test('a passage already made of whole sentences is returned unchanged', () => {
    const passage = 'Disciples in the olden days were the product of more peaceful times. For disciples, such as those I am now going to attempt to teach, there is no retiring from the world.';
    expect(completePassageSentences(passage, SOURCE)).toEqual({ text: passage, completed: false });
  });

  test('a passage ending at a paragraph break (a heading) is whole', () => {
    const source = 'Intro sentence here, long enough to anchor on.\n\nChapter Two The Long Road Home Of The Soul\n\nBody text follows. More.';
    const passage = 'Intro sentence here, long enough to anchor on.\n\nChapter Two The Long Road Home Of The Soul';
    expect(completePassageSentences(passage, source).completed).toBe(false);
  });

  test('tolerates the markup Vertex drops from the chunk: link targets, anchors and heading marks', () => {
    const source = 'The idea of moving from appearance to reality[](#note-12) seems to make no sense []{#page_27}here, as Nagel argued[3](#ch1.xhtml_n0018) in his essay on bats and minds. After that a new sentence.';
    const passage = 'The idea of moving from appearance to reality seems to make no sense here, as Nagel argued3';
    const result = completePassageSentences(passage, source);
    expect(result.completed).toBe(true);
    expect(result.text).toBe(`${passage} in his essay on bats and minds.`);
  });

  test('stops at the sentence end, not at an abbreviation or before a lowercase word', () => {
    const source = 'Opening words that anchor this passage in the text: as Mr. Smith noted, e.g. in the lectures, the self is not the body. Next sentence.';
    const passage = 'Opening words that anchor this passage in the text: as Mr';
    expect(completePassageSentences(passage, source).text)
      .toBe('Opening words that anchor this passage in the text: as Mr. Smith noted, e.g. in the lectures, the self is not the body.');
  });

  test('handles diacritics and full-width terminators', () => {
    const iast = 'The practice of satipaṭṭhāna is taught as the direct path. Its four foundations are kāya, vedanā, citta and dhammā, each contemplated in turn. Then more.';
    expect(completePassageSentences('The practice of satipaṭṭhāna is taught as the direct path. Its four foundations are kāya, vedanā', iast).text)
      .toBe('The practice of satipaṭṭhāna is taught as the direct path. Its four foundations are kāya, vedanā, citta and dhammā, each contemplated in turn.');
    const cjk = '前文在此。道可道，非常道。名可名，非常名。無名天地之始，有名萬物之母。後文。';
    expect(completePassageSentences('道可道，非常道。名可名，非常名。無名天地之始，有名', cjk).text)
      .toBe('道可道，非常道。名可名，非常名。無名天地之始，有名萬物之母。');
  });

  test('a sentence end farther away than the bound leaves the passage unchanged', () => {
    const source = `Anchor words for this passage begin right here and ${'on and '.repeat(200)}finally end.`;
    const passage = 'Anchor words for this passage begin right here and on and on';
    expect(completePassageSentences(passage, source)).toEqual({ text: passage, completed: false });
  });

  test('a passage that cannot be located, or only ambiguously, is unchanged', () => {
    const passage = 'Words that appear nowhere in the source text at all, not even once, so it';
    expect(completePassageSentences(passage, SOURCE).completed).toBe(false);
    const repeated = 'a refrain that repeats in the book word for word, then one ending. ';
    const source = `${repeated.repeat(3)}Close.`;
    expect(completePassageSentences('Unfound opening words here then a refrain that repeats in the book word for word, then one', source).completed).toBe(false);
  });

  test('never grows a passage past the byte cap', () => {
    const filler = 'x'.repeat(PASSAGE_COMPLETION_MAX_BYTES - 40);
    const source = `${filler} and then the sentence keeps going for a good while longer than forty bytes before it ends.`;
    const passage = `${filler} and then the sentence`;
    expect(completePassageSentences(passage, source).completed).toBe(false);
  });

  test('empty inputs are returned as they came', () => {
    expect(completePassageSentences('', SOURCE)).toEqual({ text: '', completed: false });
    expect(completePassageSentences('some text', '')).toEqual({ text: 'some text', completed: false });
  });
});

describe('cleanSourceText', () => {
  test('removes parser-dropped markup and pandoc residue, keeping the words', () => {
    expect(cleanSourceText('a[3](#n1) b []{#p2}c {#id} [word]{.italic}\n::: calibre4\n## Head\u0000'))
      .toBe('a3 b c  word\n\nHead');
  });
});

describe('completionSourceObject', () => {
  test('accepts gs:// text objects only', () => {
    expect(completionSourceObject('gs://lib/v2/objects/sha256/ab/abc.md')).toEqual({ bucket: 'lib', objectName: 'v2/objects/sha256/ab/abc.md' });
    expect(completionSourceObject('gs://lib/staged/x/book.md#part01')).toEqual({ bucket: 'lib', objectName: 'staged/x/book.md' });
    expect(completionSourceObject('gs://lib/a/b.txt')).toBeDefined();
    expect(completionSourceObject('gs://lib/a/b.pdf')).toBeUndefined();
    expect(completionSourceObject('https://example.com/a.md')).toBeUndefined();
    expect(completionSourceObject(undefined)).toBeUndefined();
  });
});

describe('SourceTextCache', () => {
  test('evicts least recently used texts past its character budget', () => {
    const cache = new SourceTextCache(10, 1000);
    cache.set('a', '12345');
    cache.set('b', '12345');
    cache.get('a');
    cache.set('c', '12345');
    expect(cache.get('a')).toBe('12345');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('12345');
  });

  test('remembers misses and denied buckets until their TTL passes', () => {
    let now = 0;
    const cache = new SourceTextCache(100, 1000, () => now);
    cache.miss('gs://b/x.md');
    cache.deny('denied');
    expect(cache.recentlyMissed('gs://b/x.md', 'b')).toBe(true);
    expect(cache.recentlyMissed('gs://denied/any.md', 'denied')).toBe(true);
    expect(cache.recentlyMissed('gs://b/y.md', 'b')).toBe(false);
    now = 1001;
    expect(cache.recentlyMissed('gs://b/x.md', 'b')).toBe(false);
    expect(cache.recentlyMissed('gs://denied/any.md', 'denied')).toBe(false);
  });
});
