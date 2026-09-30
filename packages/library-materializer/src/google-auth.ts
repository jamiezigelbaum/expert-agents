import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

export const GOOGLE_ACCESS_TOKEN_ENV = "EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN";
export const GOOGLE_SERVICE_ACCOUNT_JSON_ENV = "EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON";
export const GOOGLE_SERVICE_ACCOUNT_JSON_FILE_ENV = "EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_GOOGLE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type JwtSigner = (
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: string,
) => string;

export class GoogleAuthError extends Error {
  readonly code = "google_auth_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly accessToken: string) {
    if (accessToken.length === 0) throw new GoogleAuthError("Google access token is empty");
  }

  async getAccessToken(): Promise<string> {
    return this.accessToken;
  }
}

interface ServiceAccountCredential {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface ServiceAccountTokenProviderOptions {
  credentialJson?: string;
  credentialFile?: string;
  fetchImpl?: FetchLike;
  readFileImpl?: (path: string, encoding: BufferEncoding) => Promise<string>;
  signJwt?: JwtSigner;
  now?: () => number;
  scopes?: string[];
}

export class ServiceAccountTokenProvider implements AccessTokenProvider {
  readonly #options: ServiceAccountTokenProviderOptions;
  #cache?: { token: string; expiresAtMs: number };

  constructor(options: ServiceAccountTokenProviderOptions) {
    this.#options = options;
  }

  async getAccessToken(): Promise<string> {
    const now = (this.#options.now ?? Date.now)();
    if (this.#cache !== undefined && this.#cache.expiresAtMs > now + 60_000) {
      return this.#cache.token;
    }

    const credential = await this.#credential();
    const issuedAt = Math.floor(now / 1_000);
    const tokenUri = credential.token_uri ?? GOOGLE_TOKEN_URL;
    const assertion = (this.#options.signJwt ?? signJwt)(
      { alg: "RS256", typ: "JWT" },
      {
        iss: credential.client_email,
        scope: (this.#options.scopes ?? DEFAULT_GOOGLE_SCOPES).join(" "),
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3_600,
      },
      credential.private_key,
    );
    const response = await (this.#options.fetchImpl ?? fetch)(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw new GoogleAuthError(`Google OAuth token request failed with HTTP ${response.status}`);
    }
    const token = requireNonEmptyString(body.access_token, "Google OAuth response access token");
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? Math.max(300, body.expires_in)
      : 3_600;
    this.#cache = { token, expiresAtMs: now + expiresIn * 1_000 };
    return token;
  }

  async #credential(): Promise<ServiceAccountCredential> {
    const raw = this.#options.credentialJson
      ?? (this.#options.credentialFile === undefined
        ? undefined
        : await (this.#options.readFileImpl ?? readFile)(this.#options.credentialFile, "utf8"));
    if (raw === undefined) {
      throw new GoogleAuthError("Google service-account credentials are not configured");
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new GoogleAuthError("Google service-account JSON is invalid");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new GoogleAuthError("Google service-account JSON is invalid");
    }
    const record = value as Record<string, unknown>;
    const clientEmail = requireNonEmptyString(record.client_email, "Google service-account client email");
    const privateKey = requireNonEmptyString(record.private_key, "Google service-account private key");
    const tokenUri = record.token_uri === undefined
      ? undefined
      : requireHttpsTokenUri(record.token_uri);
    return {
      client_email: clientEmail,
      private_key: privateKey,
      ...(tokenUri === undefined ? {} : { token_uri: tokenUri }),
    };
  }
}

// The token URI is both the JWT audience and the POST target, so an
// unconstrained value would send a bearer-grade assertion for this service
// account to an arbitrary host.
export function requireHttpsTokenUri(value: unknown): string {
  const uri = requireNonEmptyString(value, "Google service-account token URI");
  if (!uri.startsWith("https://")) {
    throw new GoogleAuthError("Google service-account token URI must be an https URL");
  }
  return uri;
}

export function accessTokenProviderFromEnv(
  env: Record<string, string | undefined>,
  options: Omit<ServiceAccountTokenProviderOptions, "credentialJson" | "credentialFile"> = {},
): AccessTokenProvider {
  const directToken = env[GOOGLE_ACCESS_TOKEN_ENV];
  if (directToken !== undefined) return new StaticAccessTokenProvider(directToken);
  return new ServiceAccountTokenProvider({
    ...options,
    ...(env[GOOGLE_SERVICE_ACCOUNT_JSON_ENV] === undefined
      ? {}
      : { credentialJson: env[GOOGLE_SERVICE_ACCOUNT_JSON_ENV] }),
    ...(env[GOOGLE_SERVICE_ACCOUNT_JSON_FILE_ENV] === undefined
      ? {}
      : { credentialFile: env[GOOGLE_SERVICE_ACCOUNT_JSON_FILE_ENV] }),
  });
}

export const signJwt: JwtSigner = (header, claims, privateKey) => {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaims = base64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new GoogleAuthError(`${name} is missing`);
  }
  return value;
}
