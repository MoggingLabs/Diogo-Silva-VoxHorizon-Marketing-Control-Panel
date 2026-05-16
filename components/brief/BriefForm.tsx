"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";

import { BriefPayload, type BriefPayloadT } from "@/lib/briefs";
import { createClient as createBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Form-state shape — strings everywhere `<input>` returns strings, with
 * the typed payload constructed at submit time. Keeping form state stringy
 * avoids fighting `react-hook-form` with `valueAsNumber` quirks.
 */
type FormValues = {
  client_id: string;
  service: "roofing" | "remodeling";
  market: string;
  budget: string;
  budget_daily: string;
  landing_page_url: string;
  image_count: string;
  radius_km: string;
  zips: string;
  age_min: string;
  age_max: string;
  angles: string;
  offer_text: string;
  notes: string;
};

const DEFAULT_VALUES: FormValues = {
  client_id: "",
  service: "roofing",
  market: "",
  budget: "",
  budget_daily: "",
  landing_page_url: "",
  image_count: "3",
  radius_km: "",
  zips: "",
  age_min: "",
  age_max: "",
  angles: "",
  offer_text: "",
  notes: "",
};

type ClientOption = {
  id: string;
  name: string;
  slug: string;
  service_type: "roofing" | "remodeling";
};

/**
 * Builds a typed `BriefPayloadT` from raw form values. Strips blank
 * optionals so the payload doesn't end up with `""` / `NaN` cruft that
 * would round-trip badly through `jsonb`.
 */
function toPayload(v: FormValues): BriefPayloadT {
  const angles = v.angles
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const zips = v.zips
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const targeting: NonNullable<BriefPayloadT["targeting"]> = {};
  if (v.radius_km) targeting.radius_km = Number(v.radius_km);
  if (zips.length > 0) targeting.zips = zips;
  if (v.age_min) targeting.age_min = Number(v.age_min);
  if (v.age_max) targeting.age_max = Number(v.age_max);
  const hasTargeting = Object.keys(targeting).length > 0;

  const payload: BriefPayloadT = {
    service: v.service,
    market: v.market.trim(),
    budget: Number(v.budget),
  };
  if (v.budget_daily) payload.budget_daily = Number(v.budget_daily);
  if (v.landing_page_url.trim()) payload.landing_page_url = v.landing_page_url.trim();
  if (v.image_count) {
    payload.creative_plan = { image_count: Number(v.image_count) || 3 };
  }
  if (angles.length > 0) payload.angles = angles;
  if (v.offer_text.trim()) payload.offer_text = v.offer_text.trim();
  if (v.notes.trim()) payload.notes = v.notes.trim();
  if (hasTargeting) payload.targeting = targeting;
  return payload;
}

export function BriefForm({ initialClientId }: { initialClientId?: string } = {}) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // No zod resolver: form fields are stringy (HTML inputs always emit
  // strings), and the typed `BriefPayloadT` is built in `submit()` then
  // round-tripped through `BriefPayload.safeParse()` for canonical
  // validation against the same schema the server uses. Field-level errors
  // surface via `setError()` from the resolver result.
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormValues>({
    defaultValues: { ...DEFAULT_VALUES, client_id: initialClientId ?? "" },
  });

  // Fetch clients for the picker. Anon key + RLS-off in v1 makes this safe
  // from the browser. If RLS is ever turned on, this moves to a server-side
  // /api/clients endpoint.
  useEffect(() => {
    let cancelled = false;
    const supabase = createBrowserClient();
    (async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name, slug, service_type")
        .eq("status", "active")
        .order("name");
      if (cancelled) return;
      if (error) {
        setClientsError(error.message);
      } else {
        setClients((data ?? []) as ClientOption[]);
      }
      setClientsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (values: FormValues, post: boolean) => {
    setSubmitError(null);

    if (!values.client_id) {
      setError("client_id", { message: "Pick a client" });
      return;
    }
    if (!values.market.trim()) {
      setError("market", { message: "Market is required" });
      return;
    }
    if (!values.budget || Number.isNaN(Number(values.budget))) {
      setError("budget", { message: "Budget is required" });
      return;
    }

    const payload = toPayload(values);
    const parsed = BriefPayload.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && key in DEFAULT_VALUES) {
          setError(key as keyof FormValues, { message: issue.message });
        }
      }
      setSubmitError("Fix the highlighted fields and try again.");
      return;
    }

    const res = await fetch(`/api/briefs${post ? "?post=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: values.client_id, payload: parsed.data }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        issues?: { message: string; path: (string | number)[] }[];
      };
      if (Array.isArray(data.issues)) {
        for (const issue of data.issues) {
          const last = issue.path[issue.path.length - 1];
          if (typeof last === "string" && last in DEFAULT_VALUES) {
            setError(last as keyof FormValues, { message: issue.message });
          }
        }
      }
      setSubmitError(data.error ?? `Request failed (${res.status})`);
      return;
    }

    const { brief } = (await res.json()) as { brief: { id: string } };
    router.push(`/briefs/${brief.id}`);
  };

  const clientPlaceholder = useMemo(() => {
    if (clientsLoading) return "Loading clients…";
    if (clientsError) return "Failed to load clients";
    if (clients.length === 0) return "No active clients found";
    return "Select a client";
  }, [clientsLoading, clientsError, clients.length]);

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="client_id">Client</Label>
        <Controller
          control={control}
          name="client_id"
          render={({ field }) => (
            <Select
              value={field.value || undefined}
              onValueChange={field.onChange}
              disabled={clientsLoading || clients.length === 0}
            >
              <SelectTrigger id="client_id" aria-invalid={Boolean(errors.client_id)}>
                <SelectValue placeholder={clientPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="text-muted-foreground">({c.slug})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {clientsError ? <p className="text-xs text-destructive">{clientsError}</p> : null}
        {errors.client_id ? (
          <p className="text-xs text-destructive">{errors.client_id.message}</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label>Service</Label>
        <Controller
          control={control}
          name="service"
          render={({ field }) => (
            <RadioGroup value={field.value} onValueChange={field.onChange} className="flex gap-6">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="service-roofing" value="roofing" />
                <Label htmlFor="service-roofing" className="font-normal">
                  Roofing
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="service-remodeling" value="remodeling" />
                <Label htmlFor="service-remodeling" className="font-normal">
                  Remodeling
                </Label>
              </div>
            </RadioGroup>
          )}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="market">Market</Label>
        <Input
          id="market"
          placeholder="e.g. Tampa, FL"
          aria-invalid={Boolean(errors.market)}
          {...register("market")}
        />
        {errors.market ? <p className="text-xs text-destructive">{errors.market.message}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="budget">Total budget (USD)</Label>
          <Input
            id="budget"
            type="number"
            min={1}
            step="0.01"
            placeholder="5000"
            aria-invalid={Boolean(errors.budget)}
            {...register("budget")}
          />
          {errors.budget ? (
            <p className="text-xs text-destructive">{errors.budget.message}</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="budget_daily">Daily budget (USD)</Label>
          <Input
            id="budget_daily"
            type="number"
            min={1}
            step="0.01"
            placeholder="100"
            aria-invalid={Boolean(errors.budget_daily)}
            {...register("budget_daily")}
          />
          {errors.budget_daily ? (
            <p className="text-xs text-destructive">{errors.budget_daily.message}</p>
          ) : null}
        </div>
      </div>

      <fieldset className="rounded-md border p-4">
        <legend className="px-2 text-sm font-medium">Targeting (optional)</legend>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="radius_km">Radius (km)</Label>
            <Input id="radius_km" type="number" min={1} {...register("radius_km")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="zips">ZIPs (comma- or space-separated)</Label>
            <Input id="zips" placeholder="33601 33602 33603" {...register("zips")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="age_min">Age min</Label>
            <Input id="age_min" type="number" min={13} max={90} {...register("age_min")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="age_max">Age max</Label>
            <Input
              id="age_max"
              type="number"
              min={13}
              max={90}
              aria-invalid={Boolean(errors.age_max)}
              {...register("age_max")}
            />
            {errors.age_max ? (
              <p className="text-xs text-destructive">{errors.age_max.message}</p>
            ) : null}
          </div>
        </div>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor="landing_page_url">Landing page URL</Label>
        <Input
          id="landing_page_url"
          type="url"
          placeholder="https://example.com/lp"
          aria-invalid={Boolean(errors.landing_page_url)}
          {...register("landing_page_url")}
        />
        {errors.landing_page_url ? (
          <p className="text-xs text-destructive">{errors.landing_page_url.message}</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="image_count">Image count</Label>
        <Input id="image_count" type="number" min={1} max={20} {...register("image_count")} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="angles">Angles (one per line)</Label>
        <Textarea
          id="angles"
          rows={4}
          placeholder={"Free roof inspection\nHurricane-ready in 48 hours\nLifetime warranty"}
          {...register("angles")}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="offer_text">Offer</Label>
        <Input
          id="offer_text"
          placeholder="Limited time: 0% financing for 24 months"
          {...register("offer_text")}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="notes">Internal notes</Label>
        <Textarea
          id="notes"
          rows={3}
          placeholder="Anything the AI / next operator should know."
          {...register("notes")}
        />
      </div>

      {submitError ? (
        <div
          role="alert"
          className={cn(
            "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          )}
        >
          {submitError}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={isSubmitting}
          onClick={handleSubmit((v) => submit(v, false))}
        >
          Save draft
        </Button>
        <Button
          type="button"
          disabled={isSubmitting}
          onClick={handleSubmit((v) => submit(v, true))}
        >
          Post for approval
        </Button>
      </div>
    </form>
  );
}
