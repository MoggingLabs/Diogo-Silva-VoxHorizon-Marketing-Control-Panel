/**
 * Environment variable accessor that trims trailing whitespace/newlines.
 *
 * Some hosting providers and copy-paste workflows append `\n`, ` `, or `\r` to
 * env values when they're set through dashboards or .env files. This helper
 * normalizes that and throws when a required variable is missing — far easier
 * to diagnose than the cryptic "fetch failed" you get when, e.g., a Supabase
 * URL has a stray newline.
 *
 * @param name - Name of the environment variable to read.
 * @param options - When `optional: true`, returns `undefined` instead of throwing.
 * @returns The trimmed value, or `undefined` when optional and missing.
 */
export function cleanEnv(
  name: string,
  options?: { optional?: false },
): string;
export function cleanEnv(
  name: string,
  options: { optional: true },
): string | undefined;
export function cleanEnv(
  name: string,
  options?: { optional?: boolean },
): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (options?.optional) return undefined;
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env.local (see .env.example for the full list).`,
    );
  }
  return raw.trim();
}
