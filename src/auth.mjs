// Microsoft (Azure AD / Entra ID) login enforcement — server side.
//
// The browser logs in with MSAL against the company tenant and sends the
// resulting **ID token** as `Authorization: Bearer <token>` on every /api/*
// request. This module verifies that token against Microsoft's public keys
// (RS256 / JWKS) using only Node stdlib — no npm dependencies — and then
// checks the caller's email against an allow-list kept in env (never in code).
//
// Auth turns on only when configured (MS_CLIENT_ID + AUTH_ALLOWED_EMAILS), so
// local dev and CI run open exactly as before. Set AUTH_ENABLED=true/false to
// force it either way.

import { createPublicKey, createVerify } from "node:crypto";

const TENANT_ID = process.env.MS_TENANT_ID || "f1f0a729-25be-432c-b9c9-24775c52aa1a";
const CLIENT_ID = process.env.MS_CLIENT_ID || "";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const LOGIN_SCOPES = ["openid", "profile", "email"];
const CLOCK_SKEW_SEC = 120;
const JWKS_TTL_MS = 12 * 60 * 60 * 1000;

export function parseAllowedEmails(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseAllowedDomains(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );
}

const ALLOWED_EMAILS = parseAllowedEmails(process.env.AUTH_ALLOWED_EMAILS);
// Allow a whole company domain (e.g. "overay.com") — "all employees" mode.
// Combined with single-tenant + server-side tid check, this means: any signed-in
// account whose email is on the company domain. Narrow later to AUTH_ALLOWED_EMAILS.
const ALLOWED_DOMAINS = parseAllowedDomains(process.env.AUTH_ALLOWED_DOMAIN);

function computeEnabled() {
  const flag = process.env.AUTH_ENABLED;
  if (flag === "true") return true;
  if (flag === "false") return false;
  // Default: enforce once configured — by explicit emails and/or a domain.
  return Boolean(CLIENT_ID && (ALLOWED_EMAILS.size > 0 || ALLOWED_DOMAINS.size > 0));
}

export const authEnabled = computeEnabled();

/** Public, non-secret config the browser needs to start the MSAL login. */
export function getPublicAuthConfig() {
  return {
    enabled: authEnabled,
    clientId: CLIENT_ID,
    tenantId: TENANT_ID,
    authority: AUTHORITY,
    scopes: LOGIN_SCOPES,
  };
}

export class AuthError extends Error {
  constructor(message, code = "unauthorized", statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---- JWKS (Microsoft signing keys) cache ----
let jwksCache = { keys: new Map(), fetchedAt: 0 };

async function fetchJwks() {
  const response = await fetch(JWKS_URI);
  if (!response.ok) {
    throw new AuthError(`JWKS fetch failed (${response.status})`, "jwks_error", 503);
  }
  const body = await response.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kid) keys.set(jwk.kid, jwk);
  }
  jwksCache = { keys, fetchedAt: Date.now() };
  return jwksCache;
}

async function getSigningKey(kid) {
  const fresh = Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && jwksCache.keys.has(kid)) return jwksCache.keys.get(kid);
  // Cache miss or stale → refetch once (handles Microsoft key rotation).
  const refreshed = await fetchJwks();
  if (!refreshed.keys.has(kid)) {
    throw new AuthError("Signing key not found", "unknown_kid");
  }
  return refreshed.keys.get(kid);
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Verify a Microsoft-issued JWT: signature (RS256 via JWKS), issuer, audience,
 * tenant, and expiry. Returns the decoded claims or throws AuthError.
 */
export async function verifyToken(token) {
  if (!token || typeof token !== "string") {
    throw new AuthError("Missing token", "no_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError("Malformed token", "malformed");
  }
  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    throw new AuthError("Malformed token", "malformed");
  }
  if (header.alg !== "RS256") {
    throw new AuthError(`Unsupported signature algorithm: ${header.alg}`, "bad_alg");
  }

  const jwk = await getSigningKey(header.kid);
  const keyObject = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(keyObject, Buffer.from(parts[2], "base64url"))) {
    throw new AuthError("Invalid token signature", "bad_signature");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp + CLOCK_SKEW_SEC) {
    throw new AuthError("Token expired", "expired");
  }
  if (typeof payload.nbf === "number" && now + CLOCK_SKEW_SEC < payload.nbf) {
    throw new AuthError("Token not yet valid", "not_yet");
  }
  if (payload.iss !== ISSUER) {
    throw new AuthError("Invalid token issuer", "bad_issuer");
  }
  // ID token audience is the client id; also accept an access token minted for
  // an exposed API scope (api://<client_id>).
  if (CLIENT_ID && payload.aud !== CLIENT_ID && payload.aud !== `api://${CLIENT_ID}`) {
    throw new AuthError("Invalid token audience", "bad_audience");
  }
  if (payload.tid && payload.tid !== TENANT_ID) {
    throw new AuthError("Token from unexpected tenant", "bad_tenant");
  }
  return payload;
}

export function extractEmail(claims) {
  const raw =
    (claims && (claims.preferred_username || claims.email || claims.upn)) || "";
  return String(raw).trim().toLowerCase();
}

export function isAllowedEmail(email, allowed = ALLOWED_EMAILS, domains = ALLOWED_DOMAINS) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;
  if (allowed.has(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  return at !== -1 && domains.has(normalized.slice(at + 1));
}

export function bearerFromRequest(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match ? match[1].trim() : "";
}

/**
 * Full gate for an incoming request: extract bearer, verify it, confirm the
 * caller is on the allow-list. Returns { email, claims } or throws AuthError.
 */
export async function authenticateRequest(req) {
  const token = bearerFromRequest(req);
  if (!token) throw new AuthError("No credentials", "no_token", 401);
  const claims = await verifyToken(token);
  const email = extractEmail(claims);
  if (!email) throw new AuthError("Token has no email claim", "no_email", 403);
  if (!isAllowedEmail(email)) {
    throw new AuthError("This account is not authorized", "not_allowed", 403);
  }
  return { email, claims };
}

export function authConfigSummary() {
  return {
    enabled: authEnabled,
    tenantId: TENANT_ID,
    clientIdSet: Boolean(CLIENT_ID),
    allowedCount: ALLOWED_EMAILS.size,
    allowedDomains: [...ALLOWED_DOMAINS],
  };
}
