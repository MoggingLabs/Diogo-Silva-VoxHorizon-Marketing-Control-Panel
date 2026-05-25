import "server-only";

import type { ZodTypeAny } from "zod";

import {
  CreateAssetInput,
  CreateOfferConstraintInput,
  CreateOfferInput,
  CreatePastProjectInput,
  CreateServiceInput,
  CreateValuePropInput,
  UpdateAssetInput,
  UpdateOfferConstraintInput,
  UpdateOfferInput,
  UpdatePastProjectInput,
  UpdateServiceInput,
  UpdateValuePropInput,
} from "@/lib/clients/schemas";

/**
 * Registry for the 1:many client config children (E2.2 / #587).
 *
 * Every child shares the same CRUD shape (`client_id` FK, `sort_order`,
 * `deleted_at` tombstone), so the route factory (`lib/clients/child-routes.ts`)
 * is data-driven: one entry per child resource names the table, the audit event
 * resource prefix, and the create/update zod schemas. Adding a child is a
 * one-line registry entry plus the two thin route files that re-export the
 * factory handlers.
 *
 * `resource` is the event-kind prefix (`<resource>_created` etc); it is the
 * singular noun the operator-facing audit log uses.
 */

export type ChildKey =
  | "services"
  | "value_props"
  | "offers"
  | "offer_constraints"
  | "assets"
  | "past_projects";

export type ChildSpec = {
  /** DB table name. */
  table: string;
  /** Audit-event resource prefix (singular). */
  resource: string;
  /** zod schema validating a create body (client_id injected from the path). */
  create: ZodTypeAny;
  /** zod schema validating a partial edit body. */
  update: ZodTypeAny;
  /** Columns the list `?q=` free-text searches. */
  searchable: readonly string[];
  /** Columns a client may sort/filter by (always includes sort_order). */
  filterable: readonly string[];
};

export const CHILD_REGISTRY: Record<ChildKey, ChildSpec> = {
  services: {
    table: "client_services",
    resource: "client_service",
    create: CreateServiceInput,
    update: UpdateServiceInput,
    searchable: ["service_name"],
    filterable: ["sort_order", "created_at"],
  },
  value_props: {
    table: "client_value_props",
    resource: "client_value_prop",
    create: CreateValuePropInput,
    update: UpdateValuePropInput,
    searchable: ["prop_text"],
    filterable: ["kind", "sort_order", "created_at"],
  },
  offers: {
    table: "client_offers",
    resource: "client_offer",
    create: CreateOfferInput,
    update: UpdateOfferInput,
    searchable: ["offer_text"],
    filterable: ["active", "sort_order", "created_at"],
  },
  offer_constraints: {
    table: "client_offer_constraints",
    resource: "client_offer_constraint",
    create: CreateOfferConstraintInput,
    update: UpdateOfferConstraintInput,
    searchable: ["constraint_text"],
    filterable: ["sort_order", "created_at"],
  },
  assets: {
    table: "client_assets",
    resource: "client_asset",
    create: CreateAssetInput,
    update: UpdateAssetInput,
    searchable: ["ref", "label"],
    filterable: ["kind", "source", "sort_order", "created_at"],
  },
  past_projects: {
    table: "client_past_projects",
    resource: "client_past_project",
    create: CreatePastProjectInput,
    update: UpdatePastProjectInput,
    searchable: ["url"],
    filterable: ["sort_order", "created_at"],
  },
};
