import { describe, expect, test } from "bun:test";
import { validatedVertexOperationName } from "../src/vertex-operation.ts";

describe("validated Vertex operation references", () => {
  const project = "projects/neutral-project/locations/europe-west1";
  const alias = "projects/123456789/locations/europe-west1";
  const corpus = `${project}/ragCorpora/123`;

  test("accepts exact project and corpus parents and only explicitly trusted aliases", () => {
    expect(validatedVertexOperationName(`${project}/operations/create-1`, [project])).toBe(`${project}/operations/create-1`);
    expect(validatedVertexOperationName(`${corpus}/operations/import_1`, [corpus])).toBe(`${corpus}/operations/import_1`);
    expect(validatedVertexOperationName(`${alias}/operations/create-1`, [project, alias])).toBe(`${alias}/operations/create-1`);
    expect(validatedVertexOperationName(`${alias}/operations/create-1`, [project])).toBeUndefined();
    expect(validatedVertexOperationName(`${corpus}/operations/import-1`, [project])).toBeUndefined();
  });

  test.each([
    undefined, null, {}, 123,
    `${corpus}/operations/`, `${corpus}/operations/../other`,
    `${corpus}/operations/import?key=value`, `${corpus}/operations/import#fragment`,
    `${corpus}/operations/import%2fother`, `${corpus}/operations/import/other`,
    `${corpus}/operations/import\n`, `${corpus}/operations/import\\other`,
    `${project}/ragCorpora/foreign/operations/import`,
    "projects/foreign-project/locations/europe-west1/ragCorpora/123/operations/import",
    "projects/neutral-project/locations/foreign-location/ragCorpora/123/operations/import",
    "https://example.invalid/operations/import",
  ])("rejects malformed or foreign references", (value) => {
    expect(validatedVertexOperationName(value, [corpus])).toBeUndefined();
  });

  test.each([
    `${project}/../other`, `${project}?key=value`, `${project}/ragCorpora/..`,
    "https://example.invalid", `${project}/ragCorpora/123/operations`,
  ])("rejects malformed parents even when the input matches their prefix", (parent) => {
    expect(validatedVertexOperationName(`${parent}/operations/import`, [parent])).toBeUndefined();
  });
});
