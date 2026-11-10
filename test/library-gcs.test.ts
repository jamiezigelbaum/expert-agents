import { describe, expect, test } from "bun:test";
import { ServiceAccountTokenProvider, StaticAccessTokenProvider } from "../scripts/google-auth.ts";
import { GcsCasConflictError, GoogleGcsAdapter, InMemoryGcsAdapter } from "../scripts/library-gcs.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

describe("in-memory GCS adapter", () => {
  test("enforces generation zero create semantics and compare-and-set updates", async () => {
    const gcs = new InMemoryGcsAdapter();

    const firstGeneration = await gcs.writeIfGeneration("manifest/master.json", encoder.encode("one"), 0);
    expect(firstGeneration).toBe("1");
    await expect(gcs.writeIfGeneration("manifest/master.json", encoder.encode("stale"), 0))
      .rejects.toBeInstanceOf(GcsCasConflictError);

    const secondGeneration = await gcs.writeIfGeneration(
      "manifest/master.json",
      encoder.encode("two"),
      firstGeneration,
    );
    expect(secondGeneration).toBe("2");
    await expect(gcs.writeIfGeneration("manifest/master.json", encoder.encode("stale"), firstGeneration))
      .rejects.toBeInstanceOf(GcsCasConflictError);
    expect(decoder.decode((await gcs.read("manifest/master.json"))!.bytes)).toBe("two");
  });

  test("returns defensive byte copies", async () => {
    const bytes = encoder.encode("canonical");
    const gcs = new InMemoryGcsAdapter([{ path: "objects/a", bytes }]);
    bytes[0] = 0;

    const read = await gcs.read("objects/a");
    read!.bytes[0] = 0;

    expect(decoder.decode((await gcs.read("objects/a"))!.bytes)).toBe("canonical");
  });
});
