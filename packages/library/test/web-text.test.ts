import { describe, expect, test } from "bun:test";
import { extractWebMainText } from "../src/web-text.ts";

const body = Array.from({ length: 120 }, (_, i) => `assembly${i % 9}`).join(" ");
const page = `<!doctype html><html><head><title>Assemblies of Old - The Review</title>
<meta name="author" content="A. Historian"><meta property="og:site_name" content="The Review"></head><body>
<header><nav><ul><li><a href="/">Main menu</a></li><li><a href="/about">About</a></li></ul></nav></header>
<div id="sidebar"><a href="/random">Random article</a></div>
<main><article><h1>Assemblies of Old</h1><p>The assembly met at dawn on the hill.</p><p>${body}</p>
<h2>Classes</h2><p>${body}</p></article></main>
<footer>Privacy policy | Contact us</footer></body></html>`;

describe("extractWebMainText", () => {
  test("keeps the article and drops navigation, sidebar and footer", () => {
    const got = extractWebMainText(page);
    expect(got.article).toBe(true);
    expect(got.markdown).toContain("The assembly met at dawn");
    expect(got.markdown).toContain("## Classes");
    for (const chrome of ["Main menu", "Random article", "Privacy policy"]) expect(got.markdown).not.toContain(chrome);
    expect(got).toMatchObject({ author: "A. Historian", siteName: "The Review" });
  });

  test("a page with no article falls back to the whole page", () => {
    const got = extractWebMainText("<html><head><title>Index</title></head><body><p>Short list.</p></body></html>");
    expect(got.article).toBe(false);
    expect(got.markdown).toContain("Short list.");
    expect(got.title).toBe("Index");
  });
});
