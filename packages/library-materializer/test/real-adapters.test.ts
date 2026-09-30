import { describe, expect, test } from "bun:test";
import {
  GoogleGcsAdapter,
  GoogleVertexAdapter,
  VertexOperationError,
  ServiceAccountTokenProvider,
  StaticAccessTokenProvider,
} from "../src/index.ts";

describe("Google authentication", () => {
  test("shapes a service-account OAuth request with an injected signer", async () => {
    const requests: Request[] = [];
    const provider = new ServiceAccountTokenProvider({
      credentialJson: JSON.stringify({
        client_email: "neutral-service@example.invalid",
        private_key: "placeholder-key-material",
      }),
      signJwt: () => "signed-assertion",
      now: () => 1_700_000_000_000,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ access_token: "ephemeral-token", expires_in: 3600 });
      },
    });

    expect(await provider.getAccessToken()).toBe("ephemeral-token");
    expect(await provider.getAccessToken()).toBe("ephemeral-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(requests[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await requests[0]!.text()).toContain("assertion=signed-assertion");
  });

  test("refuses a credential whose token URI is not https", async () => {
    const requests: Request[] = [];
    const provider = new ServiceAccountTokenProvider({
      credentialJson: JSON.stringify({
        client_email: "neutral-service@example.invalid",
        private_key: "placeholder-key-material",
        token_uri: "http://token-sink.example.invalid/token",
      }),
      signJwt: () => "signed-assertion",
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ access_token: "ephemeral-token", expires_in: 3600 });
      },
    });

    await expect(provider.getAccessToken()).rejects.toThrow(/token URI must be an https URL/);
    expect(requests).toHaveLength(0);
  });

  test("honours an https token URI as both audience and target", async () => {
    const requests: Request[] = [];
    const claims: Array<Record<string, unknown>> = [];
    const provider = new ServiceAccountTokenProvider({
      credentialJson: JSON.stringify({
        client_email: "neutral-service@example.invalid",
        private_key: "placeholder-key-material",
        token_uri: "https://oauth2.example.invalid/token",
      }),
      signJwt: (_header, payload) => {
        claims.push(payload as Record<string, unknown>);
        return "signed-assertion";
      },
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ access_token: "ephemeral-token", expires_in: 3600 });
      },
    });

    expect(await provider.getAccessToken()).toBe("ephemeral-token");
    expect(requests[0]!.url).toBe("https://oauth2.example.invalid/token");
    expect(claims[0]!.aud).toBe("https://oauth2.example.invalid/token");
  });
});

describe("Google GCS adapter request shaping", () => {
  test("uses scoped object names, bearer auth, and generation preconditions", async () => {
    const requests: Request[] = [];
    const responses = [
      Response.json({ generation: "8" }),
      new Response("canonical", { headers: { "x-goog-generation": "8" } }),
    ];
    const adapter = new GoogleGcsAdapter({
      bucket: "neutral-library-bucket",
      prefix: "shared/library",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      },
    });

    expect(await adapter.writeIfGeneration("manifest/master.json", new TextEncoder().encode("canonical"), "7"))
      .toBe("8");
    expect(new URL(requests[0]!.url).searchParams.get("name")).toBe("shared/library/manifest/master.json");
    expect(new URL(requests[0]!.url).searchParams.get("ifGenerationMatch")).toBe("7");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-token");

    expect(new TextDecoder().decode((await adapter.read("manifest/master.json"))!.bytes)).toBe("canonical");
    expect(new URL(requests[1]!.url).searchParams.get("alt")).toBe("media");
  });

  test("retries rate-limited conditional writes before succeeding", async () => {
    const responses = [
      new Response("slow down", { status: 429 }),
      new Response("slow down", { status: 429 }),
      Response.json({ generation: "9" }),
    ];
    const adapter = new GoogleGcsAdapter({
      bucket: "neutral-library-bucket",
      prefix: "shared/library",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      writeRetries: 3,
      writeRetryDelayMs: 0,
      fetchImpl: async () => responses.shift()!,
    });

    expect(await adapter.writeIfGeneration("ledgers/neutral-agent.json", new TextEncoder().encode("x"), "8"))
      .toBe("9");
  });

  test("stops retrying rate-limited writes after the configured limit", async () => {
    const adapter = new GoogleGcsAdapter({
      bucket: "neutral-library-bucket",
      prefix: "shared/library",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      writeRetries: 1,
      writeRetryDelayMs: 0,
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    });

    await expect(adapter.writeIfGeneration("ledgers/neutral-agent.json", new TextEncoder().encode("x"), "8"))
      .rejects.toThrow("GCS conditional write failed with HTTP 429");
  });
});

describe("Google Vertex adapter request shaping", () => {
  test("lists an existing corpus and imports a GCS object through an operation", async () => {
    const requests: Request[] = [];
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
    const ragFile = `${corpus}/ragFiles/file-1`;
    const responses = [
      Response.json({ ragCorpora: [{ name: corpus, displayName: "neutral-agent-library" }] }),
      Response.json({
        name: `${corpus}/operations/import-1`,
        done: true,
        response: { importedRagFilesCount: "1" },
      }),
      Response.json({ ragFiles: [{ name: ragFile, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: ["gs://neutral-library-bucket/shared/library/objects/a"] } }] }),
    ];
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      },
    });

    expect(await adapter.ensureCorpus("neutral-agent-library")).toBe(corpus);
    expect(await adapter.importFile(corpus, "gs://neutral-library-bucket/shared/library/objects/a"))
      .toBe(ragFile);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[1]!.method).toBe("POST");
    expect(requests[1]!.url).toEndWith(`/${corpus}/ragFiles:import`);
    expect(await requests[1]!.json()).toEqual({
      importRagFilesConfig: {
        gcsSource: { uris: ["gs://neutral-library-bucket/shared/library/objects/a"] },
        // Chunking is stated explicitly rather than left to the API default,
        // and an extensionless object is not an LLM parser file type.
        ragFileTransformationConfig: {
          ragFileChunkingConfig: { fixedLengthChunking: { chunkSize: 1024, chunkOverlap: 256 } },
        },
      },
    });
  });

  test("imports a PDF with the LLM parser by default and leaves other types to the default parser", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
    const bodies = await importedConfigs(corpus, [
      "gs://neutral-library-bucket/shared/library/objects/book.pdf",
      "gs://neutral-library-bucket/shared/library/objects/notes.md",
    ]);

    expect(bodies[0]!.ragFileParsingConfig).toEqual({
      llmParser: {
        modelName: "projects/neutral-project/locations/europe-west1/publishers/google/models/gemini-2.5-flash",
      },
    });
    expect(bodies[1]).not.toHaveProperty("ragFileParsingConfig");
    for (const body of bodies) {
      expect(body.ragFileTransformationConfig).toEqual({
        ragFileChunkingConfig: { fixedLengthChunking: { chunkSize: 1024, chunkOverlap: 256 } },
      });
    }
  });

  test("an explicit parser model overrides the default and the literal default disables parsing", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
    const uris = ["gs://neutral-library-bucket/shared/library/objects/book.pdf"];

    const overridden = await importedConfigs(corpus, uris, "gemini-2.5-pro");
    expect(overridden[0]!.ragFileParsingConfig).toEqual({
      llmParser: {
        modelName: "projects/neutral-project/locations/europe-west1/publishers/google/models/gemini-2.5-pro",
      },
    });

    const disabled = await importedConfigs(corpus, uris, "default");
    expect(disabled[0]).not.toHaveProperty("ragFileParsingConfig");
    expect(disabled[0]!.ragFileTransformationConfig).toEqual({
      ragFileChunkingConfig: { fixedLengthChunking: { chunkSize: 1024, chunkOverlap: 256 } },
    });
  });

  test("writes per-file import results to a unique directory under the configured receipts prefix", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
    const bodies = await importedConfigs(
      corpus,
      [
        "gs://neutral-library-bucket/shared/library/objects/a.pdf",
        "gs://neutral-library-bucket/shared/library/objects/b.pdf",
      ],
      undefined,
      // Trailing slashes are normalized, so an operator-supplied prefix with or
      // without one produces the same receipts location.
      "gs://neutral-library-bucket/shared/library/import-results",
    );

    const prefixes = bodies.map((body) => body.importResultGcsSink.outputUriPrefix as string);
    for (const prefix of prefixes) {
      expect(prefix).toStartWith("gs://neutral-library-bucket/shared/library/import-results/");
      expect(prefix).toEndWith("/");
    }
    // Vertex's result-file naming under a shared prefix is undocumented, so two
    // imports must not be able to overwrite each other's receipts.
    expect(prefixes[0]).not.toBe(prefixes[1]);
  });

  test("sends no import result sink when no receipts prefix is configured", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
    const bodies = await importedConfigs(corpus, ["gs://neutral-library-bucket/shared/library/objects/a.pdf"]);

    expect(bodies[0]).not.toHaveProperty("importResultGcsSink");
  });

  test("rejects a receipts prefix that is not a GCS URI", () => {
    expect(() => new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      importResultGcsPrefix: "https://example.invalid/receipts",
    })).toThrow("GCS URI validation");
  });

  test("accepts resource names that use the project number instead of the configured id", async () => {
    const corpus = "projects/123456789/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async (input) => String(input).startsWith("https://cloudresourcemanager.googleapis.com/")
        ? Response.json({ projectId: "neutral-project", projectNumber: "123456789" })
        : Response.json({ ragCorpora: [{ name: corpus, displayName: "neutral-agent-library" }] }),
    });

    expect(await adapter.ensureCorpus("neutral-agent-library")).toBe(corpus);
  });

  test.each(["foreign-project", "987654321"])("rejects foreign project %s on every corpus entrypoint", async (project) => {
    const corpus = `projects/${project}/locations/europe-west1/ragCorpora/456`;
    for (const action of ["ensure", "list", "import"] as const) {
      const requests: Request[] = [];
      const adapter = new GoogleVertexAdapter({
        project: "neutral-project", location: "europe-west1",
        tokenProvider: new StaticAccessTokenProvider("test-token"),
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.url.startsWith("https://cloudresourcemanager.googleapis.com/")) {
            return Response.json({ projectId: "neutral-project", projectNumber: "123456789" });
          }
          return Response.json({ ragCorpora: [{ name: corpus, displayName: "neutral-agent-library" }] });
        },
      });
      const operation = action === "ensure" ? adapter.ensureCorpus("neutral-agent-library")
        : action === "list" ? adapter.listFiles(corpus)
          : adapter.importFile(corpus, "gs://neutral-library-bucket/objects/a");
      await expect(operation).rejects.toThrow("Vertex corpus resource scope validation");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(requests.every((request) => !request.url.includes(`/projects/${project}/`))).toBe(true);
    }
  });

  test("verified numeric project aliases support imports and reuse identity lookup", async () => {
    const corpus = "projects/123456789/locations/europe-west1/ragCorpora/456";
    const uri = "gs://neutral-library-bucket/objects/a";
    let lookups = 0;
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project", location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.startsWith("https://cloudresourcemanager.googleapis.com/")) {
          lookups += 1;
          return Response.json({ projectId: "neutral-project", projectNumber: "123456789" });
        }
        return request.method === "POST"
          ? Response.json({ name: `${corpus}/operations/import`, done: true, response: { importedRagFilesCount: "1" } })
          : Response.json({ ragFiles: [{ name: `${corpus}/ragFiles/file`, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: [uri] } }] });
      },
    });
    expect(await adapter.importFile(corpus, uri)).toBe(`${corpus}/ragFiles/file`);
    expect(await adapter.listFiles(corpus)).toHaveLength(1);
    expect(lookups).toBe(1);
  });

  test("accepts an import operation named under the project number for a project-ID corpus", async () => {
    // Live shape: the ledger pins the corpus by project ID, Vertex answers
    // with the operation (and rag file) under the project number.
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const numbered = "projects/123456789/locations/europe-west1/ragCorpora/456";
    const uri = "gs://neutral-library-bucket/objects/a";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project", location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.startsWith("https://cloudresourcemanager.googleapis.com/")) {
          return Response.json({ projectId: "neutral-project", projectNumber: "123456789" });
        }
        return request.method === "POST"
          ? Response.json({ name: `${numbered}/operations/import`, done: true, response: { importedRagFilesCount: "1" } })
          : Response.json({ ragFiles: [{ name: `${numbered}/ragFiles/file`, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: [uri] } }] });
      },
    });
    expect(await adapter.importFile(corpus, uri)).toBe(`${numbered}/ragFiles/file`);
  });

  test("still rejects an import operation named under a foreign project", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project", location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.startsWith("https://cloudresourcemanager.googleapis.com/")) {
          return Response.json({ projectId: "neutral-project", projectNumber: "123456789" });
        }
        return Response.json({ name: "projects/999/locations/europe-west1/ragCorpora/456/operations/import", done: true, response: { importedRagFilesCount: "1" } });
      },
    });
    await expect(adapter.importFile(corpus, "gs://neutral-library-bucket/objects/a"))
      .rejects.toThrow("Vertex RAG file import operation scope validation");
  });

  test("rejects resource names outside the configured location", async () => {
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async () =>
        Response.json({
          ragCorpora: [{
            name: "projects/123456789/locations/us-east4/ragCorpora/456",
            displayName: "neutral-agent-library",
          }],
        }),
    });

    await expect(adapter.ensureCorpus("neutral-agent-library")).rejects.toThrow(
      "Vertex corpus resource validation",
    );
  });

  test("resolves the imported rag file via listing when the operation reports only counts", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const uri = "gs://neutral-library-bucket/shared/library/objects/a";
    const ragFile = `${corpus}/ragFiles/file-9`;
    const responses = [
      Response.json({
        name: `${corpus}/operations/import-2`,
        done: true,
        response: { importedRagFilesCount: "1" },
      }),
      Response.json({
        ragFiles: [{ name: ragFile, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: [uri] } }],
      }),
    ];
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async () => responses.shift()!,
    });

    expect(await adapter.importFile(corpus, uri)).toBe(ragFile);
  });

  test("surfaces a typed rejection when the import operation reports failures", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async () =>
        Response.json({
          name: `${corpus}/operations/import-3`,
          done: true,
          metadata: {
            genericMetadata: {
              partialFailures: [{ code: 3, message: "File does not have extension. processing gs://neutral-library-bucket/objects/x" }],
            },
          },
          response: { failedRagFilesCount: "1" },
        }),
    });

    await expect(adapter.importFile(corpus, "gs://neutral-library-bucket/objects/x")).rejects.toThrow(
      "Vertex RAG file import rejected: failed 1, skipped 0",
    );
  });

  test("retries quota-exhausted import rejections before succeeding", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const uri = "gs://neutral-library-bucket/objects/y";
    const ragFile = `${corpus}/ragFiles/file-11`;
    const quotaRejection = Response.json({
      name: `${corpus}/operations/import-4`,
      done: true,
      metadata: {
        genericMetadata: {
          partialFailures: [{ code: 8, message: "429 Resource has been exhausted (e.g. check quota)." }],
        },
      },
      response: { failedRagFilesCount: "1" },
    });
    const responses = [
      quotaRejection,
      Response.json({
        name: `${corpus}/operations/import-5`,
        done: true,
        response: { importedRagFilesCount: "1" },
      }),
      Response.json({ ragFiles: [{ name: ragFile, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: [uri] } }] }),
    ];
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      quotaRetries: 2,
      quotaRetryDelayMs: 0,
      fetchImpl: async () => responses.shift()!,
    });

    expect(await adapter.importFile(corpus, uri)).toBe(ragFile);
  });

  test("stops retrying quota rejections after the configured limit", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const quotaBody = () => Response.json({
      name: `${corpus}/operations/import-6`,
      done: true,
      metadata: {
        genericMetadata: {
          partialFailures: [{ code: 8, message: "429 Resource has been exhausted (e.g. check quota)." }],
        },
      },
      response: { failedRagFilesCount: "1" },
    });
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      quotaRetries: 1,
      quotaRetryDelayMs: 0,
      fetchImpl: async () => quotaBody(),
    });

    await expect(adapter.importFile(corpus, "gs://neutral-library-bucket/objects/z")).rejects.toThrow(
      "RESOURCE_EXHAUSTED",
    );
  });

  test("surfaces a request-level 400 as a per-file import rejection", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });

    await expect(adapter.importFile(corpus, "gs://neutral-library-bucket/objects/w")).rejects.toThrow(
      "Vertex RAG file import rejected: request failed with HTTP 400",
    );
  });

  test("keeps request-level auth failures fatal rather than tolerated", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(adapter.importFile(corpus, "gs://neutral-library-bucket/objects/w")).rejects.toThrow(
      "Vertex RAG file import failed with HTTP 401",
    );
  });

  test("retries rate-limited list requests before succeeding", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const responses = [
      new Response("slow down", { status: 429 }),
      Response.json({ ragFiles: [{ name: `${corpus}/ragFiles/file-1`, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: ["gs://neutral-library-bucket/objects/a"] } }] }),
    ];
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      quotaRetries: 2,
      quotaRetryDelayMs: 0,
      fetchImpl: async () => responses.shift()!,
    });

    const files = await adapter.listFiles(corpus);
    expect(files).toHaveLength(1);
  });

  test("stops retrying rate-limited requests after the configured limit", async () => {
    const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/456";
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project",
      location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0,
      quotaRetries: 1,
      quotaRetryDelayMs: 0,
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    });

    await expect(adapter.listFiles(corpus)).rejects.toThrow("Vertex RAG file list failed with HTTP 429");
  });
});

// Imports each URI through one adapter and returns the importRagFilesConfig
// each request carried, in the order the URIs were given.
async function importedConfigs(
  corpus: string,
  uris: string[],
  parserModel?: string,
  importResultGcsPrefix?: string,
): Promise<Array<Record<string, any>>> {
  const requests: Request[] = [];
  let currentUri = "";
  const adapter = new GoogleVertexAdapter({
    project: "neutral-project",
    location: "europe-west1",
    tokenProvider: new StaticAccessTokenProvider("test-token"),
    pollIntervalMs: 0,
    ...(parserModel === undefined ? {} : { parserModel }),
    ...(importResultGcsPrefix === undefined ? {} : { importResultGcsPrefix }),
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json({ ragFiles: [{
        name: `${corpus}/ragFiles/file-1`, fileStatus: { state: "ACTIVE" }, gcsSource: { uris: [currentUri] },
      }] });
      requests.push(request);
      currentUri = (await request.clone().json()).importRagFilesConfig.gcsSource.uris[0];
      return Response.json({
        name: `${corpus}/operations/import-parser`,
        done: true,
        response: { importedRagFiles: [{ ragFile: { name: `${corpus}/ragFiles/file-1` } }] },
      });
    },
  });

  for (const uri of uris) await adapter.importFile(corpus, uri);
  return Promise.all(requests.map(async (request) => {
    const body = await request.json() as { importRagFilesConfig: Record<string, any> };
    return body.importRagFilesConfig;
  }));
}

describe("Vertex import proof and operation custody", () => {
  const corpus = "projects/neutral-project/locations/europe-west1/ragCorpora/123";
  const uri = "gs://neutral-library-bucket/objects/proof.md";
  const operationName = `${corpus}/operations/import-proof`;
  const file = { name: `${corpus}/ragFiles/proof`, gcsSource: { uris: [uri] }, fileStatus: { state: "ACTIVE" } };

  function harness(responses: Array<Response | Error>, options: { maxPolls?: number; importResultGcsPrefix?: string } = {}) {
    const requests: Request[] = [];
    const adapter = new GoogleVertexAdapter({
      project: "neutral-project", location: "europe-west1",
      tokenProvider: new StaticAccessTokenProvider("test-token"),
      pollIntervalMs: 0, quotaRetryDelayMs: 0, quotaRetries: 1, ...options,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });
    return { adapter, requests };
  }

  test.each([
    "projects/foreign-project/locations/europe-west1/ragCorpora/123/operations/x",
    "projects/neutral-project/locations/us-east4/ragCorpora/123/operations/x",
    "projects/neutral-project/locations/europe-west1/ragCorpora/other/operations/x",
    "projects/neutral-project/locations/europe-west1/operations/x",
    `${operationName}?key=private`, `${operationName}/../other`, `${operationName}%2fother`,
    "https://example.invalid/operations/x",
  ])("rejects an untrusted operation reference before polling: %s", async (name) => {
    const { adapter, requests } = harness([Response.json({ name })]);
    await expect(adapter.importFile(corpus, uri)).rejects.toThrow("operation scope validation");
    expect(requests).toHaveLength(1);
  });

  test("polls the exact corpus operation and resolves count-only v1 success", async () => {
    const { adapter, requests } = harness([
      Response.json({ name: operationName }),
      Response.json({ name: operationName, done: true, response: { importedRagFilesCount: "1" } }),
      Response.json({ ragFiles: [file] }),
    ]);
    expect(await adapter.importFile(corpus, uri)).toBe(file.name);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(requests[1]!.url).toBe(`https://europe-west1-aiplatform.googleapis.com/v1/${operationName}`);
  });

  test("pins the initial operation even if a poll response changes its name", async () => {
    const { adapter, requests } = harness([
      Response.json({ name: operationName }),
      Response.json({ name: `${corpus}/operations/other` }),
    ]);
    const error = await adapter.importFile(corpus, uri).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VertexOperationError);
    expect((error as VertexOperationError).operationName).toBe(operationName);
    expect(requests).toHaveLength(2);
  });

  test.each(["timeout", "terminal", "network"])("retains sanitized operation custody after %s without resubmission", async (kind) => {
    const responses = kind === "terminal"
      ? [Response.json({ name: operationName, done: true, error: { code: 13, message: "secret provider path gs://private/source" } })]
      : [Response.json({ name: operationName }), ...(kind === "network" ? [new Error("secret network diagnostics")] : [])];
    const { adapter, requests } = harness(responses, { maxPolls: kind === "timeout" ? 0 : 1, importResultGcsPrefix: "gs://neutral-library-bucket/results/" });
    const error = await adapter.importFile(corpus, uri).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VertexOperationError);
    expect((error as VertexOperationError).operationName).toBe(operationName);
    expect((error as Error).message).not.toContain("secret");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test.each([new Response("ambiguous", { status: 503 }), new Error("network timeout")])("does not retry an ambiguous import submission", async (response) => {
    const { adapter, requests } = harness([response]);
    await expect(adapter.importFile(corpus, uri)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test.each([
    { ...file, fileStatus: { state: "ERROR" } },
    { ...file, fileStatus: {} },
    { ...file, gcsSource: { uris: [`${uri}.other`] } },
    { ...file, name: "projects/foreign-project/locations/europe-west1/ragCorpora/123/ragFiles/proof" },
  ])("does not accept a returned name without exact URI and ACTIVE evidence", async (candidate) => {
    const { adapter } = harness([
      Response.json({ name: operationName, done: true, response: { importedRagFiles: [{ ragFile: file }] } }),
      Response.json({ ragFiles: [candidate] }),
    ]);
    const error = await adapter.importFile(corpus, uri).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VertexOperationError);
    expect((error as VertexOperationError).operationName).toBe(operationName);
  });

  test("does not replay ambiguous quota text or partial import success", async () => {
    for (const partialFailure of [{ code: 13, message: "429 maybe accepted" }, { code: 8, message: "quota" }]) {
      const { adapter, requests } = harness([Response.json({
        name: operationName, done: true,
        metadata: { genericMetadata: { partialFailures: [partialFailure] } },
        response: { failedRagFilesCount: "1", importedRagFilesCount: partialFailure.code === 8 ? "1" : "0" },
      })]);
      await expect(adapter.importFile(corpus, uri)).rejects.toThrow("import rejected");
      expect(requests).toHaveLength(1);
    }
  });

  test("retries an explicit HTTP quota rejection then verifies ACTIVE evidence", async () => {
    const { adapter, requests } = harness([
      new Response("quota", { status: 429 }),
      Response.json({ name: operationName, done: true, response: { importedRagFilesCount: "1" } }),
      Response.json({ ragFiles: [file] }),
    ]);
    expect(await adapter.importFile(corpus, uri)).toBe(file.name);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  test("creates a corpus through only the configured project/location operation", async () => {
    const name = "projects/neutral-project/locations/europe-west1/operations/create-proof";
    const { adapter, requests } = harness([
      Response.json({ ragCorpora: [] }),
      Response.json({ projectId: "neutral-project", projectNumber: "123456789" }),
      Response.json({ name }),
      Response.json({ name, done: true, response: { name: corpus } }),
    ]);
    expect(await adapter.ensureCorpus("neutral-library")).toBe(corpus);
    expect(requests[3]!.url).toEndWith(`/v1/${name}`);
  });

  test("rejects a foreign project create operation without polling", async () => {
    const { adapter, requests } = harness([
      Response.json({ ragCorpora: [] }),
      Response.json({ projectId: "neutral-project", projectNumber: "123456789" }),
      Response.json({ name: "projects/foreign-project/locations/europe-west1/operations/create-proof" }),
    ]);
    await expect(adapter.ensureCorpus("neutral-library")).rejects.toThrow("operation scope validation");
    expect(requests).toHaveLength(3);
  });
  test("verifies and caches the numeric project alias before corpus creation", async () => {
    const numericCorpus = "projects/123456789/locations/europe-west1/ragCorpora/456";
    const name = "projects/123456789/locations/europe-west1/operations/create-proof";
    const { adapter, requests } = harness([
      Response.json({ ragCorpora: [] }),
      Response.json({ projectId: "neutral-project", projectNumber: "123456789" }),
      Response.json({ name }),
      Response.json({ name, done: true, response: { name: numericCorpus } }),
      Response.json({ ragCorpora: [] }),
      Response.json({ name, done: true, response: { name: numericCorpus } }),
    ]);
    expect(await adapter.ensureCorpus("neutral-library")).toBe(numericCorpus);
    expect(await adapter.ensureCorpus("another-library")).toBe(numericCorpus);
    expect(requests[1]!.url).toBe("https://cloudresourcemanager.googleapis.com/v1/projects/neutral-project");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer test-token");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST", "GET", "GET", "POST"]);
    expect(requests.filter((request) => request.url.includes("cloudresourcemanager"))).toHaveLength(1);
  });

  test("rejects a foreign numeric create operation despite a verified alias", async () => {
    const { adapter, requests } = harness([
      Response.json({ ragCorpora: [] }),
      Response.json({ projectId: "neutral-project", projectNumber: "123456789" }),
      Response.json({ name: "projects/987654321/locations/europe-west1/operations/create-proof" }),
    ]);
    await expect(adapter.ensureCorpus("neutral-library")).rejects.toThrow("operation scope validation");
    expect(requests).toHaveLength(3);
  });

  test.each([
    new Response("denied", { status: 403 }), new Error("unavailable"),
    Response.json({ projectId: "foreign-project", projectNumber: "123456789" }),
    Response.json({ projectId: "neutral-project", projectNumber: "123456789/foreign" }),
    Response.json({ projectId: "neutral-project" }),
  ])("fails before create when project identity cannot be verified", async (response) => {
    const { adapter, requests } = harness([Response.json({ ragCorpora: [] }), response]);
    await expect(adapter.ensureCorpus("neutral-library")).rejects.toThrow("Vertex project identity");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

});
