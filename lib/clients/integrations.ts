import "server-only";

import type { Json } from "@/lib/supabase/types.gen";
import type { ClientIntegration } from "@/lib/clients/schemas";

/**
 * Secret masking for `client_integrations` (E2.3 / #588).
 *
 * Integration `config` jsonb can carry credentials (api keys, tokens, client
 * secrets, refresh tokens, webhook signing secrets). The CRUD routes return
 * the integration row to the operator UI, so any secret-looking value must be
 * masked before it leaves the server. The DB keeps the real value; only the
 * wire representation is masked.
 *
 * Heuristic: a top-level config key whose (lowercased) name contains one of
 * the SECRET_HINTS is masked. We keep a short, deterministic tail (last 4
 * chars) so an operator can still recognise WHICH secret is set without ever
 * seeing the full value. Empty / non-string secret values mask to a fixed
 * sentinel so "is it set?" stays answerable without leaking length.
 */

const SECRET_HINTS = [
  "secret",
  "token",
  "key",
  "password",
  "passwd",
  "credential",
  "auth",
  "private",
  "signature",
  "access_token",
  "refresh_token",
];

/** True when a config key name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  // `external_id` / `account_id` / `location_id` are identifiers, not secrets.
  if (k.endsWith("_id") || k === "id") return false;
  return SECRET_HINTS.some((hint) => k.includes(hint));
}

const MASK = "********";

/** Mask one secret value, preserving a recognisable 4-char tail when possible. */
function maskValue(value: Json): string {
  if (typeof value === "string" && value.length > 4) {
    return `${MASK}${value.slice(-4)}`;
  }
  // short / non-string secret -> fixed sentinel (don't leak length or shape).
  return MASK;
}

/**
 * Return a copy of a config object with secret-looking top-level keys masked.
 * Non-object configs (array / scalar / null) are returned unchanged — secrets
 * live under named keys, and a bare scalar carries no key to judge.
 */
export function maskConfig(config: Json | null | undefined): Json {
  if (config === null || config === undefined) return {};
  if (typeof config !== "object" || Array.isArray(config)) return config;

  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(config as Record<string, Json>)) {
    out[key] = isSecretKey(key) ? maskValue(value) : value;
  }
  return out;
}

/** Return an integration row with its `config` secrets masked for the wire. */
export function maskIntegration<R extends Pick<ClientIntegration, "config">>(row: R): R {
  return { ...row, config: maskConfig(row.config) };
}

/** Mask a list of integration rows. */
export function maskIntegrations<R extends Pick<ClientIntegration, "config">>(rows: R[]): R[] {
  return rows.map(maskIntegration);
}
