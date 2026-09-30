import { createHash } from 'node:crypto';

// Words that identify the maintainer's private deployment — agent names, hosts,
// people and private products — and must never appear in this repository or
// its shipped artifacts. They are stored as truncated SHA-256 digests so the
// list itself discloses nothing. To add one, append the first 16 hex characters
// of `printf '%s' "<word>" | shasum -a 256`, lowercased word.
const OWNER_TOKEN_DIGESTS = new Set([
  '298bab1136dcde8c',
  'ada27f52bf3030f4',
  '59ade5a471560afa',
  '0a230341201d3a9e',
  '7c82602500857aa6',
  'f05ca418eaf93a42',
  '754eb644cac7a905',
  'e7a4477ec945697c',
  '63fe2c1b8e318f0e',
  'd07d4cc7e4e2261f',
]);

// Splits on non-alphanumerics and camelCase boundaries, so `ExampleRenamed_tBot`
// yields `example`, `renamed`, `t`, `bot` while `rootDevice` never yields a
// shorter embedded word.
export function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const verdicts = new Map<string, boolean>();

function isOwnerWord(word: string): boolean {
  let verdict = verdicts.get(word);
  if (verdict === undefined) {
    verdict = OWNER_TOKEN_DIGESTS.has(createHash('sha256').update(word).digest('hex').slice(0, 16));
    verdicts.set(word, verdict);
  }
  return verdict;
}

/** Returns each distinct owner word found in the text, for error messages. */
export function ownerWordsIn(text: string): string[] {
  return [...new Set(wordsOf(text).filter(isOwnerWord))];
}
