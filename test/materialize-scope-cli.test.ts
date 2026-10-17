import { describe, expect, test } from "bun:test";
import { parseMaterializeScopeArguments, pdfPageLimitFromEnv } from "../scripts/materialize-scope.ts";

describe("library materializer CLI", () => {
  test("parses the required plan-only arguments", () => {
    expect(parseMaterializeScopeArguments([
      "--bucket", "neutral-library-bucket",
      "--prefix", "shared/library",
      "--scope", "/agent/scope.json",
      "--candidates", "/operator/candidates",
      "--receipt", "/operator/receipt.json",
    ])).toEqual({
      bucket: "neutral-library-bucket",
      prefix: "shared/library",
      scopePath: "/agent/scope.json",
      candidatesDirectory: "/operator/candidates",
      receiptPath: "/operator/receipt.json",
      execute: false,
    });
  });

  test("refuses empty and root prefixes", () => {
    const base = [
      "--bucket", "neutral-library-bucket",
      "--scope", "/agent/scope.json",
      "--candidates", "/operator/candidates",
      "--receipt", "/operator/receipt.json",
    ];
    expect(() => parseMaterializeScopeArguments(["--prefix", "/", ...base])).toThrow("must not be empty or /");
    expect(() => parseMaterializeScopeArguments(["--prefix", "", ...base])).toThrow();
  });

  // One page knob for the worker and the materializer.
  test("reads the PDF page limit from the worker's split-size setting", () => {
    const limit = (env: Record<string, string | undefined>) => pdfPageLimitFromEnv(env, "/usr/bin/qpdf").pdfPageLimit?.maxPages;
    expect(limit({})).toBe(200);
    expect(limit({ EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES: "150" })).toBe(150);
    // 0 disables splitting; the materializer never splits, so the default limit stands.
    expect(limit({ EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES: "0" })).toBe(200);
    expect(() => limit({ EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES: "many" })).toThrow("EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES must be");
    // With Google's default parser no page limit applies.
    expect(pdfPageLimitFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL: "default" }, "/usr/bin/qpdf")).toEqual({});
  });
});
