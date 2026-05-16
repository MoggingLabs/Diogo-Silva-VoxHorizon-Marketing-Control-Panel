import { NextResponse, type NextRequest } from "next/server";

/**
 * Tailscale-only access gate (defense-in-depth).
 *
 * The primary access boundary is the network layer — only tailnet members can
 * reach the host. This middleware is a secondary check: if the deployment is
 * accidentally exposed publicly (or behind a misconfigured proxy), it will
 * either log or block off-tailnet requests.
 *
 * Behavior is controlled by env vars (see .env.example):
 *   TAILSCALE_ONLY=                — disabled, requests pass through (default)
 *   TAILSCALE_ONLY=1               — log non-tailnet IPs, allow through
 *   TAILSCALE_ONLY=strict          — return 403 for non-tailnet IPs
 *
 *   TAILSCALE_CIDRS="100.64.0.0/10,..."  — override the default tailnet ranges.
 *
 * Routes excluded from the gate:
 *   - Next.js internals (`_next/static`, `_next/image`, `favicon.ico`)
 *   - `/api/health` so Vercel/uptime probes can reach the deployment
 */

const DEFAULT_TAILNET_CIDRS = ["100.64.0.0/10"];

type Cidr = { network: bigint; bits: number; family: 4 | 6 };

function parseCidr(cidr: string): Cidr | null {
  const [addr, prefix] = cidr.trim().split("/");
  if (!addr || !prefix) return null;
  const bits = Number.parseInt(prefix, 10);
  if (!Number.isFinite(bits) || bits < 0) return null;

  if (addr.includes(":")) {
    const ip = parseIPv6(addr);
    if (ip === null || bits > 128) return null;
    const network = ip & (((1n << BigInt(bits)) - 1n) << BigInt(128 - bits));
    return { network, bits, family: 6 };
  }

  const ip = parseIPv4(addr);
  if (ip === null || bits > 32) return null;
  const mask = bits === 0 ? 0n : (((1n << BigInt(bits)) - 1n) << BigInt(32 - bits));
  return { network: ip & mask, bits, family: 4 };
}

function parseIPv4(addr: string): bigint | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255 || String(n) !== part) {
      return null;
    }
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(addr: string): bigint | null {
  // Minimal IPv6 parser sufficient for membership checks. Does not normalize
  // every edge case — tailnet IPs in practice are IPv4 (100.64/10) or
  // ULA-prefixed; this branch exists only for the fd7a::/8 alias range.
  try {
    const expanded = expandIPv6(addr);
    if (!expanded) return null;
    let value = 0n;
    for (const group of expanded) {
      value = (value << 16n) | BigInt(Number.parseInt(group, 16));
    }
    return value;
  } catch {
    return null;
  }
}

function expandIPv6(addr: string): string[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map((g) => g || "0");
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  return [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((g) => g || "0");
}

function ipMatchesCidr(ip: string, cidr: Cidr): boolean {
  const parsed = cidr.family === 4 ? parseIPv4(ip) : parseIPv6(ip);
  if (parsed === null) return false;
  const totalBits = cidr.family === 4 ? 32 : 128;
  if (cidr.bits === 0) return true;
  const mask = ((1n << BigInt(cidr.bits)) - 1n) << BigInt(totalBits - cidr.bits);
  return (parsed & mask) === cidr.network;
}

function getClientIp(req: NextRequest): string | null {
  // `x-forwarded-for` is the most reliable on Vercel and behind reverse proxies.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? null;
}

const tailscaleOnly = (process.env.TAILSCALE_ONLY ?? "").trim().toLowerCase();
const tailscaleCidrsEnv = (process.env.TAILSCALE_CIDRS ?? "").trim();
const cidrStrings = tailscaleCidrsEnv
  ? tailscaleCidrsEnv.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TAILNET_CIDRS;
const parsedCidrs = cidrStrings
  .map(parseCidr)
  .filter((c): c is Cidr => c !== null);

export function middleware(req: NextRequest) {
  if (!tailscaleOnly) {
    return NextResponse.next();
  }

  const ip = getClientIp(req);
  if (!ip) {
    if (tailscaleOnly === "strict") {
      return new NextResponse("Forbidden", { status: 403 });
    }
    console.warn("[tailscale-gate] request has no client IP header");
    return NextResponse.next();
  }

  const allowed = parsedCidrs.some((cidr) => ipMatchesCidr(ip, cidr));
  if (allowed) {
    return NextResponse.next();
  }

  if (tailscaleOnly === "strict") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  console.warn(
    `[tailscale-gate] non-tailnet request ip=${ip} path=${req.nextUrl.pathname}`,
  );
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Run on everything except Next.js internals, public assets, and the
    // public health probe used by uptime monitors.
    "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
  ],
};
