import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowedEmails,
  parseAllowedDomains,
  extractEmail,
  isAllowedEmail,
  bearerFromRequest,
  verifyToken,
  AuthError,
} from "../src/auth.mjs";

test("parseAllowedEmails trims, lowercases, drops blanks, dedupes", () => {
  const set = parseAllowedEmails(" CEO@Overay.com , cfo@overay.com ,, CEO@overay.com ");
  assert.equal(set.size, 2);
  assert.ok(set.has("ceo@overay.com"));
  assert.ok(set.has("cfo@overay.com"));
});

test("parseAllowedEmails handles empty / undefined", () => {
  assert.equal(parseAllowedEmails("").size, 0);
  assert.equal(parseAllowedEmails(undefined).size, 0);
});

test("extractEmail prefers preferred_username, then email, then upn (lowercased)", () => {
  assert.equal(extractEmail({ preferred_username: "CEO@Overay.com" }), "ceo@overay.com");
  assert.equal(extractEmail({ email: "x@overay.com" }), "x@overay.com");
  assert.equal(extractEmail({ upn: "Y@Overay.com" }), "y@overay.com");
  assert.equal(extractEmail({}), "");
  assert.equal(extractEmail(null), "");
});

test("isAllowedEmail is case-insensitive membership against the given set", () => {
  const allowed = parseAllowedEmails("ceo@overay.com");
  const noDomains = new Set();
  assert.equal(isAllowedEmail("CEO@overay.com", allowed, noDomains), true);
  assert.equal(isAllowedEmail("intern@overay.com", allowed, noDomains), false);
  assert.equal(isAllowedEmail("", allowed, noDomains), false);
});

test("parseAllowedDomains strips @, lowercases, dedupes", () => {
  const set = parseAllowedDomains(" @Overay.com , overay.com , VTYLE.com ");
  assert.equal(set.size, 2);
  assert.ok(set.has("overay.com"));
  assert.ok(set.has("vtyle.com"));
});

test("isAllowedEmail allows any address on an allowed company domain", () => {
  const noEmails = new Set();
  const domains = parseAllowedDomains("overay.com");
  assert.equal(isAllowedEmail("anyone@overay.com", noEmails, domains), true);
  assert.equal(isAllowedEmail("ANYONE@Overay.com", noEmails, domains), true);
  assert.equal(isAllowedEmail("outsider@gmail.com", noEmails, domains), false);
  assert.equal(isAllowedEmail("nodomain", noEmails, domains), false);
});

test("bearerFromRequest extracts token with case-insensitive scheme", () => {
  assert.equal(bearerFromRequest({ headers: { authorization: "Bearer abc.def.ghi" } }), "abc.def.ghi");
  assert.equal(bearerFromRequest({ headers: { authorization: "bearer XYZ" } }), "XYZ");
  assert.equal(bearerFromRequest({ headers: {} }), "");
  assert.equal(bearerFromRequest({ headers: { authorization: "Basic zzz" } }), "");
});

test("verifyToken rejects missing / malformed tokens before any network call", async () => {
  await assert.rejects(() => verifyToken(""), (e) => e instanceof AuthError && e.code === "no_token");
  await assert.rejects(() => verifyToken("not-a-jwt"), (e) => e instanceof AuthError && e.code === "malformed");
  await assert.rejects(() => verifyToken("a.b"), (e) => e instanceof AuthError && e.code === "malformed");
});

test("verifyToken rejects non-RS256 algorithms before fetching keys", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: "x" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
  const token = `${header}.${payload}.AAAA`;
  await assert.rejects(() => verifyToken(token), (e) => e instanceof AuthError && e.code === "bad_alg");
});
