import { describe, expect, test } from "bun:test";
import {
  EbookConversionError,
  convertEpubToMarkdown,
  decodeXmlEntities,
  plainTextToMarkdown,
  resolveArchivePath,
  xhtmlToMarkdown,
} from "../src/ebook-text.ts";
import { buildEpub, buildZip } from "./epub-fixture.ts";

describe("EPUB to Markdown conversion", () => {
  test("walks the spine in order, keeps chapter headings, strips markup and decodes entities", () => {
    const result = convertEpubToMarkdown(buildEpub());

    expect(result.title).toBe("Fixture Monograph");
    expect(result.creator).toBe("Example Author");
    expect(result.sections).toBe(2);
    // The stylesheet itemref and the dangling idref never become sections.
    expect(result.skipped).toBe(0);
    expect(result.markdown.startsWith("# Fixture Monograph\n\n*Example Author*\n\n")).toBe(true);
    const one = result.markdown.indexOf("## One: The & Beginning");
    const two = result.markdown.indexOf("## Chapter Two");
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
    expect(result.markdown).toContain("First paragraph with an emphasised word and a footnote1.");
    expect(result.markdown).toContain("Second paragraph — with a dash and ‘quotes’.");
    expect(result.markdown).toContain("- alpha\n- beta");
    expect(result.markdown).toContain("More of it.\nOn a new line.");
    expect(result.markdown).not.toContain("<");
    expect(result.markdown).not.toContain("alert(");
    expect(result.markdown).not.toContain("margin: 0");
  });

  test("resolves hrefs relative to the OPF directory and reads deflated entries", () => {
    const result = convertEpubToMarkdown(buildEpub({ contentDirectory: "book/content" }));
    expect(result.sections).toBe(2);
    expect(result.markdown).toContain("Plain second chapter body.");
  });

  test("reports a missing spine document as skipped with a warning and still converts the rest", () => {
    const zip = buildZip([
      { name: "mimetype", data: "application/epub+zip", stored: true },
      { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      {
        name: "OEBPS/content.opf",
        data: '<package><metadata></metadata><manifest><item id="ch1" href="text/present.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="text/gone.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
      },
      { name: "OEBPS/text/present.xhtml", data: "<html><body><p>present</p></body></html>" },
    ]);
    const result = convertEpubToMarkdown(zip);
    expect(result.sections).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toEqual(["spine document OEBPS/text/gone.xhtml is missing or unreadable"]);
    expect(result.markdown).toContain("## Section 1\n\npresent");
  });

  test("falls back to a lone .opf when container.xml is absent", () => {
    const result = convertEpubToMarkdown(buildEpub({ omitContainer: true }));
    expect(result.sections).toBe(2);
  });

  test("refuses bytes that are not a ZIP with a typed code", () => {
    expect(() => convertEpubToMarkdown(new TextEncoder().encode("%PDF-1.4 not an epub at all"))).toThrow(EbookConversionError);
    try {
      convertEpubToMarkdown(new TextEncoder().encode("%PDF-1.4 not an epub at all"));
    } catch (error) {
      expect((error as EbookConversionError).code).toBe("epub_not_zip");
    }
  });

  test("refuses a package whose container names a missing OPF", () => {
    const zip = buildZip([
      { name: "mimetype", data: "application/epub+zip", stored: true },
      { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="OEBPS/nope.opf"/></rootfiles></container>' },
      { name: "OEBPS/other.opf", data: "<package/>" },
    ]);
    expect(() => convertEpubToMarkdown(zip)).toThrow(/OEBPS\/nope.opf/);
  });

  test("refuses a package whose spine yields no text", () => {
    const zip = buildEpub({
      chapters: [{ id: "ch1", href: "text/empty.xhtml", xhtml: "<html><body><script>x()</script></body></html>" }],
    });
    try {
      convertEpubToMarkdown(zip);
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as EbookConversionError).code).toBe("epub_no_text");
    }
  });

  test("bounds inflated output", () => {
    expect(() => convertEpubToMarkdown(buildEpub(), { maxInflatedBytes: 64 })).toThrow(EbookConversionError);
  });
});

describe("XHTML helpers", () => {
  test("decodes numeric and named entities and leaves unknown ones alone", () => {
    expect(decodeXmlEntities("a &amp; b &#65; &#x42; &mdash; &unknownthing; &#0;")).toBe("a & b A B — &unknownthing; &#0;");
  });

  test("keeps heading levels and reports the first heading", () => {
    const converted = xhtmlToMarkdown("<html><head><title>T</title></head><body><h2>Two</h2><p>x</p><h3>Three</h3></body></html>");
    expect(converted.markdown).toBe("## Two\n\nx\n\n### Three");
    expect(converted.firstHeading).toBe("Two");
    expect(converted.title).toBe("T");
  });

  test("resolves archive paths relative to the package document", () => {
    expect(resolveArchivePath("OEBPS/content.opf", "text/ch1.xhtml#frag")).toBe("OEBPS/text/ch1.xhtml");
    expect(resolveArchivePath("OEBPS/content.opf", "../images/a%20b.png")).toBe("images/a b.png");
    expect(resolveArchivePath("content.opf", "./ch1.xhtml")).toBe("ch1.xhtml");
    expect(resolveArchivePath("a/b/c.opf", "/root.xhtml")).toBe("root.xhtml");
  });

  test("wraps plain text with a title and turns page breaks into rules", () => {
    expect(plainTextToMarkdown("page one\r\n\fpage two   \n\n\n\nend", { title: "Scan", creator: "Who" }))
      .toBe("# Scan\n\n*Who*\n\npage one\n\n---\n\npage two\n\nend\n");
  });
});
