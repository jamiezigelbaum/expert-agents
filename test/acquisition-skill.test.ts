import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("acquisition skill", () => {
  test("every error code it names is one the worker produces", async () => {
    const skill = await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8");
    const worker = await readFile("packages/runtime/src/workers/domain-expert/index.ts", "utf8");
    const named = [...new Set(skill.match(/`([a-z]+(?:_[a-z]+)+)`/g)?.map((code) => code.slice(1, -1)) ?? [])]
      .filter((name) => /^(annas|unsupported|rag|import|pdf|source)_/.test(name) && !/^(import_(failed|empty|requested|in_progress|outcome))$/.test(name));
    expect(named).toContain("pdf_exceeds_parser_page_limit");
    expect(named).toContain("source_holding_unverified");
    for (const code of named) expect(worker).toContain(`'${code}'`);
  });

  test("the split size it describes is the worker's default", async () => {
    const skill = (await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8")).replace(/\s+/g, " ");
    const library = await readFile("packages/library/src/pdf-split.ts", "utf8");
    const size = /export const LLM_PARSER_MAX_PDF_PAGES = (\d+);/.exec(library)?.[1];
    expect(size).toBeDefined();
    expect(skill).toContain(`parts of at most ${size} pages`);
    // The same number is the limit a host that cannot split refuses above: one knob.
    expect(skill).toContain(`a PDF longer than ${size} pages is refused before upload`);
    expect(skill).not.toMatch(/ceiling|default 500/);
  });
});
