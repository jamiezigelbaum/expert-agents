import { describe, expect, test } from "bun:test";
import { LIBRARY_MATERIALIZER_SCHEMA_VERSION } from "../src/index.ts";

describe("library materializer package", () => {
  test("exports its schema version", () => {
    expect(LIBRARY_MATERIALIZER_SCHEMA_VERSION).toBe(1);
  });
});
