import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

describe("acquisition skill", () => {
  test("every error code it names is one the worker produces", async () => {
    const skill = await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8");
    const worker = await readFile("packages/runtime/src/workers/domain-expert/index.ts", "utf8");
    const named = [...new Set(skill.match(/`([a-z]+(?:_[a-z]+)+)`/g)?.map((code) => code.slice(1, -1)) ?? [])]
      .filter((name) => /^(annas|unsupported|rag|import|pdf|source|page)_/.test(name) && !/^(import_(failed|empty|requested|in_progress|outcome)|rag_ingest)$/.test(name));
    expect(named).toContain("page_ingest_format_unsupported");
    for (const code of named) expect(worker).toContain(`'${code}'`);
  });

  test("acquisitions land in the page library and are verified through library_ingest", async () => {
    const skill = (await readFile("skills/expert-annas-archive-acquisition/SKILL.md", "utf8")).replace(/\s+/g, " ");
    expect(skill).toContain("queues a page-library ingest job");
    expect(skill).toContain("Check `library_ingest` with `action: \"status\"`");
    expect(skill).toContain("Never describe a queued or running job as success");
    expect(skill).not.toMatch(/Vertex|rag_corpus|domain_ask|target corpus|parts of at most/);
  });
});

describe("skills", () => {
  test("no skill teaches a retired Vertex tool", async () => {
    for (const name of await readdir("skills")) {
      const skill = await readFile(`skills/${name}/SKILL.md`, "utf8").catch(() => "");
      expect({ name, retired: skill.match(/\b(?:domain_ask|domain_read|domain_source|rag_corpus)\b/g) ?? [] }).toEqual({ name, retired: [] });
    }
  });
});
