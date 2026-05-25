import { z } from "zod";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Zod schemas + DB passthroughs for the Clients CRUD surface (Makeover M2,
 * E2.1 / E2.2 / E2.3). Covers `clients`, the 1:1 `client_profiles`, the 1:many
 * config children (services / value props / offers / offer constraints / assets
 * / past projects) and `client_integrations`.
 *
 * The route handlers (`app/api/clients`) validate every write body through a
 * Create / Update schema here, then write the corresponding Insert / Update Row
 * type. Soft-delete + restore reuse `lib/crud`.
 *
 * Schema source of truth: `db/migrations/0012_client_data_layer.sql`,
 * `0023_supporting_tables_and_extends.sql` (client_integrations), and
 * `0047_soft_delete_safe_tables.sql` (deleted_at on every client table).
 */

// ---------------------------------------------------------------------------
// shared enums
// ---------------------------------------------------------------------------

/** Verticals after 0012 extended the `service_type` enum. */
export const ServiceTypeEnum = z.enum([
  "roofing",
  "remodeling",
  "general_contracting",
  "construction",
  "pools",
]);
export type ServiceTypeT = z.infer<typeof ServiceTypeEnum>;

export const ValuePropKindEnum = z.enum(["usp", "differentiator"]);
export type ValuePropKindT = z.infer<typeof ValuePropKindEnum>;

export const AssetKindEnum = z.enum([
  "logo",
  "logo_alt",
  "facebook_banner",
  "review",
  "team_photo",
  "project_photo",
  "external",
  "existing_creative",
]);
export type AssetKindT = z.infer<typeof AssetKindEnum>;

export const AssetSourceEnum = z.enum(["drive", "local", "url", "filename", "descriptor"]);
export type AssetSourceT = z.infer<typeof AssetSourceEnum>;

/** `client_integrations.provider` is a CHECK-constrained text column (0023). */
export const IntegrationProviderEnum = z.enum(["meta", "ghl", "drive"]);
export type IntegrationProviderT = z.infer<typeof IntegrationProviderEnum>;

// A slug is the human key used to mint brief ids etc; keep it url-safe.
const slugSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be lowercase alphanumeric with single hyphens",
  });

// brand_colors is free-shape jsonb; accept any JSON object/array/scalar.
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
) as z.ZodType<Json>;

// ---------------------------------------------------------------------------
// clients (E2.1)
// ---------------------------------------------------------------------------

/**
 * `POST /api/clients` body. `status` is free-text on the DB (default
 * 'active'); we constrain the UI vocabulary to the operator-meaningful set but
 * keep it a plain string column write.
 */
export const CreateClientInput = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  service_type: ServiceTypeEnum,
  status: z.string().min(1).max(40).default("active"),
  brand_colors: jsonValue.optional(),
  cpl_target: z.number().nonnegative().max(100000).nullable().optional(),
  ghl_location_id: z.string().max(200).nullable().optional(),
  meta_account_id: z.string().max(200).nullable().optional(),
  drive_root_folder_id: z.string().max(200).nullable().optional(),
});
export type CreateClientInputT = z.infer<typeof CreateClientInput>;

/**
 * `PATCH /api/clients/:id` body. Every field optional; the route rejects an
 * empty patch with 400. Slug is editable but must stay url-safe + unique
 * (the DB unique index is the final arbiter; a collision returns 409).
 */
export const UpdateClientInput = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    service_type: ServiceTypeEnum.optional(),
    status: z.string().min(1).max(40).optional(),
    brand_colors: jsonValue.nullable().optional(),
    cpl_target: z.number().nonnegative().max(100000).nullable().optional(),
    ghl_location_id: z.string().max(200).nullable().optional(),
    meta_account_id: z.string().max(200).nullable().optional(),
    drive_root_folder_id: z.string().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });
export type UpdateClientInputT = z.infer<typeof UpdateClientInput>;

// ---------------------------------------------------------------------------
// client_profiles (1:1, E2.2) — upsert
// ---------------------------------------------------------------------------

const optText = z.string().max(20000).nullable().optional();
const optInt = z.number().int().nullable().optional();
const optNum = z.number().nullable().optional();
const optBool = z.boolean().nullable().optional();
// dates accept ISO date (YYYY-MM-DD) or full timestamp; stored as `date`.
const optDate = z.string().max(40).nullable().optional();

/**
 * `PUT /api/clients/:id/profile` body — upsert the 1:1 profile. Every column
 * from 0012 is optional so the operator fills the profile incrementally. The
 * route injects `client_id` from the path, so it is not accepted in the body.
 */
export const UpsertProfileInput = z.object({
  tone: optText,
  tagline: optText,
  voice_note: optText,
  brand_fonts: jsonValue.nullable().optional(),
  logo_drive_id: optText,
  logo_alt_drive_id: optText,

  legal_name: optText,
  business_type: optText,
  ein: optText,
  license_number: optText,
  years_in_business: optInt,
  owner_experience_years: optInt,
  family_owned: optBool,
  background: optText,
  google_reviews: optText,
  google_rating: optNum,
  bbb_rating: optText,
  average_project_value: optText,
  minimum_project_size: optText,
  residential_projects: optInt,
  commercial_projects: optInt,
  total_work_orders: optInt,
  projects_completed: optText,
  warranty: optText,
  warranty_details: jsonValue.nullable().optional(),
  financing: optText,
  business_hours: optText,
  appointment_availability: optText,
  licensed_insured: optBool,

  contact_primary: optText,
  contact_secondary: optText,
  contact_role: optText,
  contact_phone: optText,
  contact_email: optText,
  company_email: optText,

  owner_name: optText,
  annual_revenue: optText,
  company_size: optText,

  address: optText,
  business_address: optText,
  city: optText,
  state: optText,
  primary_city: optText,
  primary_zip: optText,
  targeting: optText,
  targeting_detail: optText,
  timezone: optText,

  crm: optText,
  integration: optText,
  website: optText,
  booking_flow: optText,
  closebot_role: optText,
  sales_rep: optText,

  campaign_name: optText,
  campaign_status: optText,
  launch_date: optDate,
  relaunch_date: optDate,
  targeting_type: optText,
  daily_budget: optNum,
  monthly_budget: optNum,
  funnel: jsonValue.nullable().optional(),

  drive_docs_folder_id: optText,
  drive_assets_folder_id: optText,
  drive_creatives_folder_id: optText,
  drive_performance_folder_id: optText,
  drive_resources_folder_id: optText,
  drive_meeting_notes_folder_id: optText,
  client_profile_doc_id: optText,
  stat_sheet_url: optText,

  needs_input: jsonValue.optional(),
  raw_profile: jsonValue.optional(),
});
export type UpsertProfileInputT = z.infer<typeof UpsertProfileInput>;

// ---------------------------------------------------------------------------
// 1:many config children (E2.2)
// ---------------------------------------------------------------------------

export const CreateServiceInput = z.object({
  service_name: z.string().min(1).max(500),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdateServiceInput = z
  .object({
    service_name: z.string().min(1).max(500).optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const CreateValuePropInput = z.object({
  kind: ValuePropKindEnum,
  prop_text: z.string().min(1).max(2000),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdateValuePropInput = z
  .object({
    kind: ValuePropKindEnum.optional(),
    prop_text: z.string().min(1).max(2000).optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const CreateOfferInput = z.object({
  offer_text: z.string().min(1).max(2000),
  active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdateOfferInput = z
  .object({
    offer_text: z.string().min(1).max(2000).optional(),
    active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const CreateOfferConstraintInput = z.object({
  constraint_text: z.string().min(1).max(2000),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdateOfferConstraintInput = z
  .object({
    constraint_text: z.string().min(1).max(2000).optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const CreateAssetInput = z.object({
  kind: AssetKindEnum,
  source: AssetSourceEnum,
  ref: z.string().min(1).max(4000),
  formats: z.string().max(200).nullable().optional(),
  label: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdateAssetInput = z
  .object({
    kind: AssetKindEnum.optional(),
    source: AssetSourceEnum.optional(),
    ref: z.string().min(1).max(4000).optional(),
    formats: z.string().max(200).nullable().optional(),
    label: z.string().max(500).nullable().optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const CreatePastProjectInput = z.object({
  url: z.string().url().max(2048),
  sort_order: z.number().int().min(0).max(100000).optional(),
});
export const UpdatePastProjectInput = z
  .object({
    url: z.string().url().max(2048).optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

// ---------------------------------------------------------------------------
// client_integrations (E2.3)
// ---------------------------------------------------------------------------

export const CreateIntegrationInput = z.object({
  provider: IntegrationProviderEnum,
  external_id: z.string().max(500).nullable().optional(),
  config: jsonValue.optional(),
  active: z.boolean().optional(),
});
export const UpdateIntegrationInput = z
  .object({
    provider: IntegrationProviderEnum.optional(),
    external_id: z.string().max(500).nullable().optional(),
    config: jsonValue.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

// ---------------------------------------------------------------------------
// DB passthrough types
// ---------------------------------------------------------------------------

type T = Database["public"]["Tables"];

export type Client = T["clients"]["Row"];
export type ClientInsert = T["clients"]["Insert"];
export type ClientUpdate = T["clients"]["Update"];

export type ClientProfile = T["client_profiles"]["Row"];
export type ClientProfileInsert = T["client_profiles"]["Insert"];

export type ClientService = T["client_services"]["Row"];
export type ClientValueProp = T["client_value_props"]["Row"];
export type ClientOffer = T["client_offers"]["Row"];
export type ClientOfferConstraint = T["client_offer_constraints"]["Row"];
export type ClientAsset = T["client_assets"]["Row"];
export type ClientPastProject = T["client_past_projects"]["Row"];
export type ClientIntegration = T["client_integrations"]["Row"];
