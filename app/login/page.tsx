"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Single-operator login screen.
 *
 * Posts `{ email, password }` to `/api/auth/login`. On success the route sets
 * the HttpOnly session cookie and we navigate to the post-login destination
 * (the `?next=` the middleware appended when it bounced an unauthenticated
 * request, defaulting to `/`). The cookie is HttpOnly so this component never
 * touches the token — it only triggers the navigation.
 *
 * `next` is sanitised to a same-origin path so a crafted `?next=//evil.com`
 * cannot turn the post-login redirect into an open redirect.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  // Must be a site-relative path (starts with a single slash) and not a
  // protocol-relative `//host` escape.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // Full navigation so the server re-renders with the new cookie applied.
        router.replace(next as never);
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError("Incorrect email or password.");
      } else if (res.status === 503) {
        setError("Login is not configured on this server.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden="true"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm"
          >
            <span className="text-sm font-bold">VH</span>
          </span>
          <h1 className="text-lg font-semibold text-foreground">VoxHorizon Control Panel</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue.</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
