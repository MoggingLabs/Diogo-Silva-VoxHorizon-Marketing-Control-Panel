/**
 * Single-operator app session: sign / verify / read helpers.
 *
 * App-layer auth (defense-in-depth) keeps the single-operator posture but no
 * longer relies solely on the Caddy edge. The login route verifies the
 * operator's password (bcrypt) then issues a signed, HttpOnly, SameSite cookie
 * carrying this opaque token; `middleware.ts` validates the token on every
 * non-public request.
 *
 * Token mechanism: an OPAQUE signed token, NOT a JWT. The shape is
 *
 *     base64url(JSON payload) "." base64url(HMAC-SHA256 over the payload part)
 *
 * signed with `SESSION_SECRET`. We pick a hand-rolled HMAC token (over a JWT
 * library) for two reasons:
 *   1. Web Crypto (`crypto.subtle`) is available in BOTH the Edge runtime
 *      (where `middleware.ts` runs) and the Node runtime (where the login
 *      route runs), so the same verify path works in both with zero native
 *      deps and no extra dependency to vet.
 *   2. The payload is tiny and fixed (operator email + issued/expiry epoch),
 *      so JWT's registered-claim ceremony buys us nothing here.
 *
 * The HMAC is compared in constant time (see {@link timingSafeEqualBytes}) so
 * a tampered signature cannot be discovered byte-by-byte via timing.
 *
 * This module is deliberately framework-agnostic and does NOT import
 * `server-only`: middleware (Edge) and the unit tests import it directly. The
 * `SESSION_SECRET` is read lazily inside each function so importing the module
 * never throws at load time (matters for the Edge middleware bundle).
 */

/** Cookie name carrying the signed session token. */
export const SESSION_COOKIE = "vox_session";

/** Default session lifetime: 7 days, in seconds. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The decoded, verified session payload. */
export type SessionPayload = {
  /** Authenticated operator email (lowercased). */
  email: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
};

/**
 * Resolve the signing secret. Trimmed (env values often carry a stray
 * newline) and required: a blank secret means we cannot sign or verify, so we
 * fail closed by throwing. Callers in the request path catch this and treat it
 * as "no valid session" rather than crashing.
 */
function getSecret(): string {
  const raw = process.env.SESSION_SECRET;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "Missing required environment variable: SESSION_SECRET. " +
        "Set it in .env.local (see .env.example).",
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// base64url + byte helpers (Edge + Node safe — no Buffer dependency)
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // btoa is available in both the Edge runtime and Node 18+.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function utf8ToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToUtf8(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

/**
 * Constant-time byte comparison. Returns false fast on a length mismatch
 * (comparing different-length buffers would itself leak length), otherwise
 * accumulates the XOR of every byte so the timing is independent of WHERE the
 * first difference is.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i]! ^ b[i]!;
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

async function hmac(payloadPart: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));
  return new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a freshly-signed session token for the given operator email. The
 * email is lowercased so the token's identity is canonical regardless of how
 * the operator typed it. `nowSeconds` is injectable for deterministic tests.
 */
export async function issueSessionToken(
  email: string,
  options: { ttlSeconds?: number; nowSeconds?: number } = {},
): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    email: email.trim().toLowerCase(),
    iat: now,
    exp: now + ttl,
  };
  const payloadPart = utf8ToBase64Url(JSON.stringify(payload));
  const sigPart = bytesToBase64Url(await hmac(payloadPart));
  return `${payloadPart}.${sigPart}`;
}

/**
 * Verify a session token's signature and expiry. Returns the decoded payload
 * on success, or `null` for ANY failure (malformed, tampered signature,
 * expired, or a missing/blank secret). Never throws — the request path treats
 * a `null` here as "no valid session".
 *
 * @param nowSeconds injectable clock for deterministic expiry tests.
 */
export async function verifySessionToken(
  token: string | null | undefined,
  options: { nowSeconds?: number } = {},
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let expectedSig: Uint8Array;
  let presentedSig: Uint8Array;
  try {
    expectedSig = await hmac(payloadPart);
    presentedSig = base64UrlToBytes(sigPart);
  } catch {
    // Bad base64url, or a missing/blank SESSION_SECRET -> not a valid session.
    return null;
  }
  if (!timingSafeEqualBytes(presentedSig, expectedSig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlToUtf8(payloadPart)) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.email !== "string" ||
    typeof payload?.exp !== "number" ||
    typeof payload?.iat !== "number"
  ) {
    return null;
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;

  return payload;
}

/**
 * Read + verify the session from a request's `Cookie` header. Works with both
 * the Web `Request` (route handlers) and `NextRequest` (middleware) since both
 * expose `headers.get("cookie")`. Returns the verified payload or `null`.
 */
export async function readSessionFromRequest(
  req: { headers: { get(name: string): string | null } },
  options: { nowSeconds?: number } = {},
): Promise<SessionPayload | null> {
  const cookieHeader = req.headers.get("cookie");
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  return verifySessionToken(token, options);
}

/**
 * Minimal `Cookie` header parser: returns the value of the named cookie, or
 * `null`. Splits on `;`, trims, and matches the first `name=value` pair.
 */
export function parseCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * The cookie attributes the login route sets and the logout route clears.
 * HttpOnly (no JS access -> XSS can't read the token), SameSite=Lax (sent on
 * top-level navigations so a normal dashboard visit carries it, but NOT on
 * cross-site sub-requests -> CSRF defense), Secure in production, Path=/ so it
 * scopes the whole app. `maxAge` is in seconds.
 */
export function sessionCookieOptions(maxAgeSeconds: number): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Secure is required for the cookie to ride HTTPS in prod; relaxed in dev
    // (http://localhost) so the e2e harness + local login work over plain HTTP.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
