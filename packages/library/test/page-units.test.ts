import { describe, expect, test } from "bun:test";
import {
  bookId,
  offsetUnits,
  pageDerivativePrefix,
  pageNeedsOcr,
  parseUnitSlug,
  partOf,
  renderUnitMarkdown,
  sectionText,
  splitPdfText,
  unitBody,
  unitName,
  unitNumber,
} from "../src/page-units.ts";

const SHA = "sha256:" + "ab".repeat(32);

describe("page units", () => {
  test("pdftotext output splits into pages and drops the trailing form feed", () => {
    expect(splitPdfText("one\fand two\f")).toEqual(["one", "and two"]);
    expect(splitPdfText("one\f\fthree")).toEqual(["one", "", "three"]);
  });

  test("a page with almost no text layer needs OCR", () => {
    expect(pageNeedsOcr("  12  ")).toBe(true);
    expect(pageNeedsOcr("x".repeat(200))).toBe(false);
  });

  test("unit names round-trip and refuse nonsense", () => {
    expect(unitName("p", 7)).toBe("p0007");
    expect(unitNumber("s0123")).toBe(123);
    expect(() => unitName("p", 0)).toThrow();
    expect(() => unitNumber("x01")).toThrow();
  });

  test("sections stay near the target, never split a paragraph, and carry their heading", () => {
    const para = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const text = ["# One", para(300), para(300), "# Two", para(100), para(700), para(50)].join("\n\n");
    const out = sectionText(text, 500);
    expect(out.map((s) => s.heading)).toEqual(["One", "Two", "Two"]);
    expect(out[0]!.text.startsWith("# One")).toBe(true);
    expect(out[1]!.text.split(/\s+/).length).toBeGreaterThanOrEqual(500);
    expect(out.map((s) => s.text).join("\n\n").split(/\s+/).length).toBe(text.split(/\s+/).length);
  });

  test("split PDF parts are recognised and renumber to the original pages", () => {
    expect(partOf("bailey---esoteric-healing-2009-part-2-of-4.pdf")).toEqual({ base: "bailey---esoteric-healing-2009", part: 2, of: 4 });
    expect(partOf("ferguson---civilization-2011--part1of3.pdf")?.part).toBe(1);
    expect(partOf("plain-book.pdf")).toBeUndefined();
    const units = offsetUnits([{ unit: "p0001", sourcePage: 1, parser: "pdftotext", text: "a" }, { unit: "s0003", parser: "text", text: "b" }], 200);
    expect(units[0]).toMatchObject({ unit: "p0201", sourcePage: 1, sourceUnit: "p0001" });
    expect(units[1]).toMatchObject({ unit: "s0203", sourceUnit: "s0003" });
  });

  test("book ids are readable and edition-safe; slugs parse strictly", () => {
    expect(bookId("Esoteric Healing: Volume IV", SHA)).toBe("esoteric-healing-volume-iv-ababab");
    expect(bookId("…", SHA)).toBe("untitled-ababab");
    expect(parseUnitSlug("books/esoteric-healing-ababab/p0012")).toEqual({ book: "esoteric-healing-ababab", unit: "p0012" });
    expect(parseUnitSlug("books/../etc/p0001")).toBeUndefined();
    expect(parseUnitSlug("books/a/p0001/x")).toBeUndefined();
  });

  test("unit Markdown quotes front matter and its body round-trips", () => {
    const md = renderUnitMarkdown({ title: 'A "quoted": title', page: 3 }, "\nBody text.\n\n---\n\nMore.\n");
    expect(md).toContain('title: "A \\"quoted\\": title"\npage: 3');
    expect(unitBody(md)).toBe("Body text.\n\n---\n\nMore.");
  });

  test("derivatives sit beside the original's content address", () => {
    expect(pageDerivativePrefix(SHA)).toBe(`derivatives/pages/v2/ab/${"ab".repeat(32)}`);
    expect(() => pageDerivativePrefix("sha1:abc")).toThrow();
  });
});
