import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("acquisition skill", () => {
  test("every error code it names is one the worker produces", async () => {
    const skill = await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8");
    const worker = await readFile("packages/runtime/src/workers/domain-expert/index.ts", "utf8");
    const named = [...new Set(skill.match(/`([a-z]+(?:_[a-z]+)+)`/g)?.map((code) => code.slice(1, -1)) ?? [])]
      .filter((name) => /^(annas|unsupported|rag|import)_/.test(name) && !/^(import_(failed|empty|requested|in_progress|outcome))$/.test(name));
    expect(named).toContain("annas_pdf_exceeds_parser_page_limit");
    for (const code of named) expect(worker).toContain(`'${code}'`);
  });

  test("the page ceiling it describes is the worker's default", async () => {
    const skill = (await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8")).replace(/\s+/g, " ");
    const worker = await readFile("packages/runtime/src/workers/domain-expert/index.ts", "utf8");
    const ceiling = /const DEFAULT_ANNAS_MAX_PDF_PAGES = (\d+);/.exec(worker)?.[1];
    expect(ceiling).toBeDefined();
    expect(skill).toContain(`configured ceiling (default ${ceiling})`);
  });

  test("the split size it describes is the worker's default", async () => {
    const skill = (await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8")).replace(/\s+/g, " ");
    const worker = await readFile("packages/runtime/src/workers/domain-expert/index.ts", "utf8");
    const size = /const DEFAULT_ANNAS_PDF_SPLIT_PAGES = (\d+);/.exec(worker)?.[1];
    expect(size).toBeDefined();
    expect(skill).toContain(`parts of at most ${size} pages`);
  });
});
