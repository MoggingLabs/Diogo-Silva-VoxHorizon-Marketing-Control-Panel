/**
 * Drive folder routing for finished creatives.
 *
 * Mirrors ``worker/src/services/drive.py`` so the Next.js side can
 * preview where a creative will land before the worker actually uploads.
 *
 * The marketing-dept Drive tree has stable folder IDs for v1; we hardcode
 * them rather than reading from ``clients.drive_root_folder_id`` (reserved
 * for future per-client overrides).
 */

export type ServiceType = "roofing" | "remodeling";
export type CreativeFormat = "image" | "video";

/** Stable Drive folder IDs. Mirrors `FOLDER_IDS` in the worker. */
export const FOLDER_IDS = {
  "60.2_marketing_dept": "15WwyDWgVOxoqqj5QxjXR8tS354WQZ0go",
  "0_sourcing": "1vKm9eg9tGtxZMJTjw_rwYnXQD33DH9o-",
  "1_radar": "1LHQz0GiFSQ6mnxvLI0ZHWSb617MMTsp_",
  "2_strategy": "1V5cnU-6-UKLf2prpXgIZoZ7pKCmWWi8Z",
  "3_image_ads": "1C3KA10R1vH39bTPWXoey-tub8bajd7FQ",
  "4.1_video_input": "1w4vtJB32CVkco-RctyH84XIvnD7lCGSL",
  "4.2_video_output": "17HZ41N0-uKyTRg1fVM5phd5oe0TPRpvq",
  "5_copy": "17ZFnZVULxkwbCszX1r_S1IEIQZmxxt15",
  "6_launch": "1_bS6gNQ8M-Ve5zFBPgR68DXXQlzvaY4a",
  "7_ops": "1fk4fJrGhM03grRsCI-YTh4rOBACKdf_z",
} as const;

export type FolderKey = keyof typeof FOLDER_IDS;

export interface RouteInputs {
  service_type: ServiceType;
  state: string | null;
  client_slug: string | null;
  branded: boolean;
  fmt: CreativeFormat;
}

export interface RouteOutput {
  parent_folder_id: string;
  parent_folder_key: FolderKey;
  subpath: string;
}

/**
 * Pick the parent folder for a creative.
 *
 * Rules (parent-level):
 *   - Image → ``3 Image Ads``
 *   - Video → ``4.2 Video Output``
 *
 * The sub-path (state/client vs. _Universal/) is computed separately —
 * see :func:`routeSubpath`.
 */
export function routeParentFolder(inputs: Pick<RouteInputs, "fmt">): FolderKey {
  return inputs.fmt === "image" ? "3_image_ads" : "4.2_video_output";
}

/**
 * Compute the sub-path within the parent folder.
 *
 * - roofing + branded → ``<state>/<client_slug>/`` when both are present,
 *   else best-effort with whichever fields exist.
 * - roofing + unbranded → ``_Universal/``
 * - remodeling → ``_Universal/`` (no branded carve-out per v1 spec)
 */
export function routeSubpath(
  inputs: Pick<RouteInputs, "service_type" | "branded" | "state" | "client_slug">,
): string {
  const { service_type, branded, state, client_slug } = inputs;
  if (service_type === "roofing" && branded) {
    if (state && client_slug) return `${state}/${client_slug}/`;
    if (state) return `${state}/`;
    if (client_slug) return `${client_slug}/`;
    return "_Universal/";
  }
  return "_Universal/";
}

/**
 * One-shot router: returns the parent folder + sub-path together.
 */
export function routeCreative(inputs: RouteInputs): RouteOutput {
  const parent_folder_key = routeParentFolder(inputs);
  const parent_folder_id = FOLDER_IDS[parent_folder_key];
  const subpath = routeSubpath(inputs);
  return { parent_folder_id, parent_folder_key, subpath };
}
