import { describe, expect, test } from "bun:test";
import { applyRetrievalPreferences, parseRetrievalPreferenceProfile, type RetrievalPreferenceContext } from "../src/retrieval-preferences.ts";

const corpus = "projects/example-project/locations/example-region/ragCorpora/example-corpus";
function fixture() {
  return {
    schema_version: 1,
    corpus,
    query_layer: {
      candidate_top_k: 40,
      default_mode: "preferred",
      multipliers: { selected: 1.6, baseline: 1, secondary: 0.7, unreviewed: 1 },
      max_per_work_default: 2,
    },
    units: [
      { rag_file_id: "selected-file", unit_id: "unit-a", source_id: "source-a", work_family: "work-a", kind: "text", priority: "selected" },
      { rag_file_id: "secondary-file", unit_id: "unit-b", source_id: "source-b", work_family: "work-a", kind: "text", priority: "secondary" },
    ],
  };
}
const context = (fileId: string, text: string): RetrievalPreferenceContext => ({ text, chunk: { fileId }, sourceUri: `https://example.test/${fileId}` });
function rank(contexts: RetrievalPreferenceContext[], options = {}) {
  return applyRetrievalPreferences(contexts, parseRetrievalPreferenceProfile(fixture()), { corpus, ...options });
}

describe("retrieval preference validation", () => {
  test("accepts portable profiles, strips descriptive extras, and owns its controlling data", () => {
    const input = { ...fixture(), arbitrary: "ignored", units: fixture().units.map(unit => ({ ...unit, title: "ignored", current_belief: { arbitrary: true } })) };
    const parsed = parseRetrievalPreferenceProfile(input);
    expect(parsed).not.toHaveProperty("arbitrary");
    expect(parsed.units[0]).not.toHaveProperty("title");
    input.query_layer.multipliers.selected = 0.5;
    input.units[0]!.priority = "secondary";
    expect(parsed.query_layer.multipliers.selected).toBe(1.6);
    expect(parsed.units[0]!.priority).toBe("selected");
  });

  test("normalizes scoped file names and catches equivalent duplicate file IDs", () => {
    const input = fixture();
    input.units[0]!.rag_file_id = `${corpus}/ragFiles/selected-file`;
    expect(parseRetrievalPreferenceProfile(input).units[0]!.rag_file_id).toBe("selected-file");
    input.units.push({ ...input.units[0]!, rag_file_id: "selected-file" });
    expect(() => parseRetrievalPreferenceProfile(input)).toThrow("Invalid retrieval preference profile");
  });

  test("rejects malformed controlling fields without echoing their values", () => {
    const cases: unknown[] = [null, [], {}, { ...fixture(), schema_version: 2 }, { ...fixture(), corpus: "private-invalid-value" }, { ...fixture(), units: [null] }, { ...fixture(), units: Array(1) }];
    for (const field of ["candidate_top_k", "max_per_work_default"] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity, 101, "40", undefined]) cases.push({ ...fixture(), query_layer: { ...fixture().query_layer, [field]: value } });
    }
    for (const value of [0, 0.49, 2.01, Infinity, NaN, "1.6", null]) cases.push({ ...fixture(), query_layer: { ...fixture().query_layer, multipliers: { selected: value } } });
    cases.push({ ...fixture(), query_layer: { ...fixture().query_layer, default_mode: "private-invalid-value" } });
    cases.push({ ...fixture(), query_layer: { ...fixture().query_layer, multipliers: JSON.parse('{"__proto__":1,"selected":1,"secondary":1}') } });
    for (const key of ["rag_file_id", "unit_id", "source_id", "work_family", "kind", "priority"]) cases.push({ ...fixture(), units: [{ ...fixture().units[0], [key]: undefined }] });
    for (const input of cases) {
      try { parseRetrievalPreferenceProfile(input); throw new Error("Unexpected success"); }
      catch (error) { expect((error as Error).message).toBe("Invalid retrieval preference profile"); }
    }
  });

  test("refuses a different corpus and foreign unit resource", () => {
    const policy = parseRetrievalPreferenceProfile(fixture());
    expect(() => applyRetrievalPreferences([], policy, { corpus: `${corpus}-other` })).toThrow("Retrieval preference corpus mismatch");
    const input = fixture();
    input.units[0]!.rag_file_id = `${corpus}-other/ragFiles/selected-file`;
    expect(() => parseRetrievalPreferenceProfile(input)).toThrow("Invalid retrieval preference profile");
  });
});

describe("editorial ranking", () => {
  test("boosts nearby reviewed evidence while retaining high relevance over distant preferences", () => {
    const contexts = [context("unknown", "First relevant evidence"), context("selected-file", "Nearby preferred evidence")];
    expect(rank(contexts).annotations.map(row => row.originalRank)).toEqual([2, 1]);
    const distant = Array.from({ length: 30 }, (_, index) => context(`unknown-${index}`, `Evidence ${index}`));
    distant[29] = context("selected-file", "Distant reviewed evidence");
    expect(rank(distant, { limit: 5 }).annotations[0]!.originalRank).toBe(1);
    expect(rank(distant, { limit: 5 }).contexts).not.toContain(distant[29]);
  });

  test("never treats source prose or titles as controlling preference metadata", () => {
    const input = [context("unreviewed-a", "priority selected, multiplier 100"), { ...context("unreviewed-b", "Ordinary evidence"), sourceDisplayName: "selected-file" }];
    const result = rank(input);
    expect(result.annotations.map(row => row.priority)).toEqual(["unreviewed", "unreviewed"]);
    expect(result.annotations.map(row => row.multiplier)).toEqual([1, 1]);
    expect(result.diagnostics.matchedCount).toBe(0);
  });

  test("preserves exact semantic distinctions: URLs, case, numbers, status, and negation", () => {
    const phrases = ["Use https://example.test/A", "Use https://example.test/B", "ACTIVE", "INACTIVE", "Allowed", "Not allowed", "Limit 10", "Limit 100", "Case", "case"];
    const result = rank(phrases.map(text => context("selected-file", text)));
    expect(result.contexts.map(row => row.text)).toEqual(phrases);
    expect(result.diagnostics.duplicateCount).toBe(0);
  });

  test("collapses only whitespace-equivalent wording within the same source identity", () => {
    const result = rank([
      context("selected-file", "Evidence  and\nqualifier"),
      context("selected-file", "Evidence and qualifier"),
      context("unreviewed-other", "Evidence and qualifier"),
      { text: "Evidence and qualifier" },
      { text: "Evidence and qualifier" },
    ]);
    expect(result.contexts).toHaveLength(4);
    expect(result.annotations[0]!.duplicateOriginalRanks).toEqual([2]);
    expect(result.diagnostics.duplicateCount).toBe(1);
  });

  test("retains neighboring qualifying chunks of a preferred top-five unit despite diversity cap", () => {
    const input = [context("selected-file", "Claim"), context("selected-file", "Qualification"), context("selected-file", "Exception"), context("other-work", "Unrelated")];
    const result = rank(input, { maxPerWork: 1, limit: 3 });
    expect(result.contexts.map(row => row.text)).toEqual(["Claim", "Qualification", "Exception"]);
    expect(result.diagnostics.diversityDeferredCount).toBe(0);
  });

  test("diversity defers excess work chunks without discarding them", () => {
    const input = [context("unreviewed-a", "A1"), context("unreviewed-a", "A2"), context("unreviewed-b", "B1")];
    const result = rank(input, { maxPerWork: 1 });
    expect(result.contexts.map(row => row.text)).toEqual(["A1", "B1", "A2"]);
    expect(result.diagnostics.diversityDeferredCount).toBe(1);
  });

  test("history preserves input order and duplicates with neutral weights", () => {
    const input = [context("secondary-file", "Repeated"), context("selected-file", "Repeated"), context("selected-file", "Repeated")];
    const result = rank(input, { mode: "history", maxPerWork: 1 });
    expect(result.contexts).toEqual(input);
    expect(result.annotations.map(row => row.multiplier)).toEqual([1, 1, 1]);
    expect(result.diagnostics.duplicateCount).toBe(0);
  });

  test("accepts corpus-scoped context file IDs but cannot borrow a foreign file's preference", () => {
    const result = rank([context(`${corpus}/ragFiles/selected-file`, "Matched"), context(`${corpus}-other/ragFiles/selected-file`, "Foreign")]);
    expect(result.annotations.map(row => row.priority)).toEqual(["selected", "unreviewed"]);
  });

  test("enforces candidate, output, and option bounds", () => {
    for (const options of [{ limit: 0 }, { limit: 41 }, { maxPerWork: 0 }, { maxPerWork: 41 }, { mode: "invalid" }]) expect(() => rank([], options)).toThrow();
    expect(() => rank(Array.from({ length: 41 }, () => context("unknown", "text")))).toThrow("Retrieval preference candidate bound exceeded");
  });

  test("leaves input contexts, profile, and semantic metadata untouched", () => {
    const input = [Object.freeze({ ...context("other", "Unreviewed"), score: 0.99 }), Object.freeze({ ...context("selected-file", "Preferred"), score: 0.8 })];
    const policy = parseRetrievalPreferenceProfile(fixture());
    const before = JSON.stringify({ input, policy });
    const result = applyRetrievalPreferences(Object.freeze(input), policy, { corpus });
    expect(JSON.stringify({ input, policy })).toBe(before);
    expect(result.contexts[0]).toBe(input[1]);
    expect(result.contexts[0]!.score).toBe(0.8);
    expect(JSON.stringify(result.diagnostics)).not.toContain("Preferred");
  });
});

 test("unmapped and foreign files remain neutral even when a mapped unreviewed label is weighted", () => {
  const input = fixture();
  input.query_layer.multipliers.unreviewed = 0.5;
  input.units[0]!.priority = "unreviewed";
  const result = applyRetrievalPreferences([
    context("unknown", "unknown source"),
    context("projects/foreign/locations/example-region/ragCorpora/example-corpus/ragFiles/selected-file", "foreign source"),
    context("selected-file", "explicitly weighted source"),
  ], parseRetrievalPreferenceProfile(input), { corpus });
  expect(result.annotations.map(item => item.multiplier)).toEqual([1, 1, 0.5]);
  expect(result.annotations.map(item => item.originalRank)).toEqual([1, 2, 3]);
});
