import { describe, expect, test } from "bun:test";
import { parseMaterializeScopeArguments } from "../scripts/materialize-scope.ts";

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
});
