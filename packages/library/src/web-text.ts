// The main text of a web page: Mozilla Readability (the Firefox Reader View
// extractor) over a linkedom document, then the library's own HTML-to-Markdown
// converter. Navigation, menus, sidebars and footers are left out. Pure and
// local: no network, no model.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { xhtmlToMarkdown } from "./ebook-text.ts";

export interface WebMainText {
  /** The article as Markdown, or the whole page when no article was found. */
  markdown: string;
  /** Whether Readability found an article; false means the whole page was converted. */
  article: boolean;
  title?: string;
  /** The article's byline, else the site name. */
  author?: string;
  siteName?: string;
}

// Readability's own default for "this is an article": shorter results are menus or stubs.
const MIN_ARTICLE_CHARACTERS = 500;

export function extractWebMainText(html: string): WebMainText {
  const whole = xhtmlToMarkdown(html);
  let parsed: ReturnType<Readability["parse"]> = null;
  try {
    const { document } = parseHTML(html);
    parsed = new Readability(document as unknown as Document, { charThreshold: MIN_ARTICLE_CHARACTERS }).parse();
  } catch {
    parsed = null;
  }
  const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || undefined;
  const title = clean(parsed?.title) ?? clean(whole.title);
  const siteName = clean(parsed?.siteName);
  const author = clean(parsed?.byline) ?? siteName;
  const meta = { ...(title ? { title } : {}), ...(author ? { author } : {}), ...(siteName ? { siteName } : {}) };
  if (!parsed?.content || (parsed.textContent ?? "").trim().length < MIN_ARTICLE_CHARACTERS) {
    return { markdown: whole.markdown, article: false, ...meta };
  }
  const body = xhtmlToMarkdown(`<html><body>${parsed.content}</body></html>`).markdown;
  return { markdown: title && !/^#\s/.test(body) ? `# ${title}\n\n${body}` : body, article: true, ...meta };
}
