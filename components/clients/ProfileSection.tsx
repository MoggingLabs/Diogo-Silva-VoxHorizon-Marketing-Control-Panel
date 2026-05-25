"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { z } from "zod";

import { CrudDrawer } from "@/components/shared/CrudDrawer";
import { Button } from "@/components/ui/button";
import { TextField, TextareaField } from "@/components/clients/fields";
import { saveProfile } from "@/lib/clients/api";
import { type ClientProfile } from "@/lib/clients/schemas";

/**
 * Profile tab (E2.4). Edits the most-used fields of the 1:1 `client_profiles`
 * row via a CrudDrawer that PUTs (upserts) to `/api/clients/:id/profile`. The
 * full profile has ~70 columns; the drawer exposes the brand-voice + key
 * company facts + contact subset the operator authors ads from, plus a
 * read-only summary card. Numeric fields are coerced from text on submit.
 */

const ProfileFormSchema = z.object({
  tone: z.string().max(20000).optional(),
  tagline: z.string().max(20000).optional(),
  voice_note: z.string().max(20000).optional(),
  legal_name: z.string().max(20000).optional(),
  years_in_business: z.string().optional(),
  warranty: z.string().max(20000).optional(),
  financing: z.string().max(20000).optional(),
  contact_primary: z.string().max(20000).optional(),
  contact_phone: z.string().max(20000).optional(),
  contact_email: z.string().max(20000).optional(),
  website: z.string().max(20000).optional(),
  primary_city: z.string().max(20000).optional(),
  background: z.string().max(20000).optional(),
});
type ProfileForm = z.infer<typeof ProfileFormSchema>;

const FIELD_KEYS = Object.keys(ProfileFormSchema.shape) as (keyof ProfileForm)[];

function toForm(profile: ClientProfile | null): ProfileForm {
  const out = {} as ProfileForm;
  for (const k of FIELD_KEYS) {
    const v = profile ? (profile as Record<string, unknown>)[k] : undefined;
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

function toBody(v: ProfileForm) {
  const trim = (s?: string) => (s && s.trim() ? s.trim() : null);
  return {
    tone: trim(v.tone),
    tagline: trim(v.tagline),
    voice_note: trim(v.voice_note),
    legal_name: trim(v.legal_name),
    years_in_business: v.years_in_business?.trim() ? Number(v.years_in_business) : null,
    warranty: trim(v.warranty),
    financing: trim(v.financing),
    contact_primary: trim(v.contact_primary),
    contact_phone: trim(v.contact_phone),
    contact_email: trim(v.contact_email),
    website: trim(v.website),
    primary_city: trim(v.primary_city),
    background: trim(v.background),
  };
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">
        {value || <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

export function ProfileSection({
  clientId,
  profile,
}: {
  clientId: string;
  profile: ClientProfile | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Profile</h2>
          <p className="text-sm text-muted-foreground">
            Brand voice, company facts, and contact the operator authors ads from.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          <span>{profile ? "Edit profile" : "Add profile"}</span>
        </Button>
      </div>

      <dl className="rounded-md border border-border bg-card px-4 py-2">
        <SummaryRow label="Tagline" value={profile?.tagline} />
        <SummaryRow label="Tone" value={profile?.tone} />
        <SummaryRow label="Voice note" value={profile?.voice_note} />
        <SummaryRow label="Legal name" value={profile?.legal_name} />
        <SummaryRow label="Years in business" value={profile?.years_in_business ?? ""} />
        <SummaryRow label="Warranty" value={profile?.warranty} />
        <SummaryRow label="Financing" value={profile?.financing} />
        <SummaryRow label="Primary contact" value={profile?.contact_primary} />
        <SummaryRow label="Contact phone" value={profile?.contact_phone} />
        <SummaryRow label="Contact email" value={profile?.contact_email} />
        <SummaryRow label="Website" value={profile?.website} />
        <SummaryRow label="Primary city" value={profile?.primary_city} />
        <SummaryRow label="Background" value={profile?.background} />
      </dl>

      <CrudDrawer<ProfileForm>
        open={open}
        onOpenChange={setOpen}
        title="Edit profile"
        description="Saved fields update the canonical client knowledge the operator authors ads from."
        schema={ProfileFormSchema}
        defaultValues={toForm(profile)}
        successMessage="Profile saved"
        onSubmit={async (values) => {
          await saveProfile(clientId, toBody(values));
        }}
        onSuccess={() => router.refresh()}
      >
        <TextField<ProfileForm> name="tagline" label="Tagline" />
        <TextField<ProfileForm> name="tone" label="Tone" />
        <TextareaField<ProfileForm> name="voice_note" label="Voice note" />
        <TextField<ProfileForm> name="legal_name" label="Legal name" />
        <TextField<ProfileForm> name="years_in_business" label="Years in business" type="number" />
        <TextField<ProfileForm> name="warranty" label="Warranty" />
        <TextField<ProfileForm> name="financing" label="Financing" />
        <TextField<ProfileForm> name="contact_primary" label="Primary contact" />
        <TextField<ProfileForm> name="contact_phone" label="Contact phone" />
        <TextField<ProfileForm> name="contact_email" label="Contact email" />
        <TextField<ProfileForm> name="website" label="Website" />
        <TextField<ProfileForm> name="primary_city" label="Primary city" />
        <TextareaField<ProfileForm> name="background" label="Background" rows={4} />
      </CrudDrawer>
    </section>
  );
}
