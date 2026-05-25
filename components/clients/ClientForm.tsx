"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/clients/api";
import { CLIENT_STATUS_OPTIONS, SERVICE_TYPE_OPTIONS } from "@/lib/clients/labels";
import { CreateClientInput, type ServiceTypeT } from "@/lib/clients/schemas";

type FormValues = {
  name: string;
  slug: string;
  service_type: ServiceTypeT;
  status: string;
  cpl_target: string;
  ghl_location_id: string;
  meta_account_id: string;
  drive_root_folder_id: string;
};

const DEFAULTS: FormValues = {
  name: "",
  slug: "",
  service_type: "roofing",
  status: "active",
  cpl_target: "",
  ghl_location_id: "",
  meta_account_id: "",
  drive_root_folder_id: "",
};

/** Lowercase, hyphenate, strip junk -> a url-safe slug suggestion. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create-client form (E2.4). Identity fields plus the optional integration
 * identifiers from `clients`. The slug auto-suggests from the name until the
 * operator edits it. Validates client-side against the same zod schema the
 * server uses, then POSTs and routes to the new client's detail page.
 */
export function ClientForm() {
  const router = useRouter();
  const [slugEdited, setSlugEdited] = React.useState(false);
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: DEFAULTS });

  const name = watch("name");
  React.useEffect(() => {
    if (!slugEdited) setValue("slug", slugify(name));
  }, [name, slugEdited, setValue]);

  const submit = handleSubmit(async (v) => {
    const candidate = {
      name: v.name.trim(),
      slug: v.slug.trim(),
      service_type: v.service_type,
      status: v.status,
      ...(v.cpl_target ? { cpl_target: Number(v.cpl_target) } : {}),
      ...(v.ghl_location_id.trim() ? { ghl_location_id: v.ghl_location_id.trim() } : {}),
      ...(v.meta_account_id.trim() ? { meta_account_id: v.meta_account_id.trim() } : {}),
      ...(v.drive_root_folder_id.trim()
        ? { drive_root_folder_id: v.drive_root_folder_id.trim() }
        : {}),
    };

    const parsed = CreateClientInput.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && key in DEFAULTS) {
          setError(key as keyof FormValues, { message: issue.message });
        }
      }
      toast.error("Fix the highlighted fields and try again.");
      return;
    }

    try {
      const { client } = await createClient(parsed.data);
      toast.success("Client created");
      router.push(`/clients/${client.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create client");
    }
  });

  return (
    <form className="space-y-6" onSubmit={submit}>
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          placeholder="Acme Roofing Co"
          aria-invalid={Boolean(errors.name)}
          {...register("name")}
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="slug">Slug</Label>
        <Input
          id="slug"
          placeholder="acme-roofing"
          aria-invalid={Boolean(errors.slug)}
          {...register("slug", { onChange: () => setSlugEdited(true) })}
        />
        <p className="text-xs text-muted-foreground">
          Lowercase, hyphenated. Used to mint brief ids; must be unique.
        </p>
        {errors.slug ? <p className="text-xs text-destructive">{errors.slug.message}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="service_type">Service type</Label>
          <Controller
            control={control}
            name="service_type"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="service_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="status">Status</Label>
          <Controller
            control={control}
            name="status"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>

      <fieldset className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
        <legend className="px-2 text-sm font-medium">Integrations (optional)</legend>
        <div className="grid gap-2">
          <Label htmlFor="cpl_target">CPL target (USD)</Label>
          <Input
            id="cpl_target"
            type="number"
            min={0}
            step="0.01"
            placeholder="75"
            aria-invalid={Boolean(errors.cpl_target)}
            {...register("cpl_target")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="meta_account_id">Meta ad account id</Label>
          <Input
            id="meta_account_id"
            placeholder="act_123456789"
            {...register("meta_account_id")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ghl_location_id">GHL location id</Label>
          <Input id="ghl_location_id" {...register("ghl_location_id")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="drive_root_folder_id">Drive root folder id</Label>
          <Input id="drive_root_folder_id" {...register("drive_root_folder_id")} />
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" onClick={() => router.push("/clients")}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Creating...</span>
            </>
          ) : (
            "Create client"
          )}
        </Button>
      </div>
    </form>
  );
}
