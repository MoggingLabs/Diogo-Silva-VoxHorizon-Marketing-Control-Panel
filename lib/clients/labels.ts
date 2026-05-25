import type { ServiceTypeT } from "@/lib/clients/schemas";

/**
 * Human display labels + option lists shared by the Clients UI (E2.4). Kept in
 * one place so the list filters, the create form, and the detail view agree on
 * vocabulary.
 */

export const SERVICE_TYPE_LABEL: Record<ServiceTypeT, string> = {
  roofing: "Roofing",
  remodeling: "Remodeling",
  general_contracting: "General contracting",
  construction: "Construction",
  pools: "Pools",
};

export const SERVICE_TYPE_OPTIONS: { value: ServiceTypeT; label: string }[] = (
  Object.keys(SERVICE_TYPE_LABEL) as ServiceTypeT[]
).map((value) => ({ value, label: SERVICE_TYPE_LABEL[value] }));

/** Operator-facing client status vocabulary (status is free-text on the DB). */
export const CLIENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
];

export const VALUE_PROP_KIND_LABEL: Record<string, string> = {
  usp: "USP",
  differentiator: "Differentiator",
};

export const ASSET_KIND_OPTIONS = [
  { value: "logo", label: "Logo" },
  { value: "logo_alt", label: "Logo (alt)" },
  { value: "facebook_banner", label: "Facebook banner" },
  { value: "review", label: "Review" },
  { value: "team_photo", label: "Team photo" },
  { value: "project_photo", label: "Project photo" },
  { value: "external", label: "External" },
  { value: "existing_creative", label: "Existing creative" },
] as const;

export const ASSET_SOURCE_OPTIONS = [
  { value: "drive", label: "Drive" },
  { value: "local", label: "Local" },
  { value: "url", label: "URL" },
  { value: "filename", label: "Filename" },
  { value: "descriptor", label: "Descriptor" },
] as const;

export const INTEGRATION_PROVIDER_OPTIONS = [
  { value: "meta", label: "Meta" },
  { value: "ghl", label: "GoHighLevel" },
  { value: "drive", label: "Google Drive" },
] as const;

/** Format an ISO timestamp for the data tables; falls back to the raw value. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
