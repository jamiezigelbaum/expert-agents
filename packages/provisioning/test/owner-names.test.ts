import { expect, test } from 'bun:test';
import { ownerWordsIn, wordsOf } from '../src/owner-names.ts';

test('words split on punctuation and camelCase without inventing shorter words', () => {
  expect(wordsOf('ExampleRenamed_tBot rootDevice HTTPServer')).toEqual(['example', 'renamed', 't', 'bot', 'root', 'device', 'http', 'server']);
});

test('neutral fixture vocabulary is not an owner word', () => {
  expect(ownerWordsIn('example expert-a research governance climate history rootDevice first-device')).toEqual([]);
});
