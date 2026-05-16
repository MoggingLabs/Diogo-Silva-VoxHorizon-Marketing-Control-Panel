/**
 * Creative-filename naming convention helpers.
 *
 * Production launches require every uploaded file to match a strict pipe-
 * delimited shape so the upstream ``launch_package.py`` validator can
 * grep them and the operator can eyeball them in Drive.
 *
 * Image:  ``<Client Label> | <Concept> | <ratio> | v<X.Y>.png``
 * Video:  ``<Client Label> | <Concept> | <Ns> | v<X.Y>.mp4``
 *
 * Where:
 *   - ``<Client Label>``: human-readable label, letters / digits / dashes /
 *     spaces only. Pipes and other punctuation are NOT allowed (the parser
 *     uses ``|`` as the delimiter).
 *   - ``<Concept>``: free-text but cannot contain ``|``.
 *   - ratio: one of ``1x1`` / ``9x16`` / ``16x9``.
 *   - Ns:    duration in seconds (e.g. ``30s``).
 *   - vX.Y:  semver-style version, leading ``v`` required.
 *
 * Mirrors ``worker/src/services/drive.py::build_image_filename`` so the
 * pre-upload UI check and the worker write-side agree byte-for-byte.
 */

export const IMAGE_FILENAME_REGEX =
  /^[A-Za-z0-9- ]+ \| [^|]+ \| (1x1|9x16|16x9) \| v\d+\.\d+\.png$/;
export const VIDEO_FILENAME_REGEX = /^[A-Za-z0-9- ]+ \| [^|]+ \| \d+s \| v\d+\.\d+\.mp4$/;

export type ImageNamingRatio = "1x1" | "9x16" | "16x9";

export interface ImageFilenameParts {
  client_label: string;
  concept: string;
  ratio: ImageNamingRatio;
  version: string;
}

export interface VideoFilenameParts {
  client_label: string;
  concept: string;
  duration_s: number;
  version: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a candidate image filename against the launch convention.
 * Returns ``{ok: true, errors: []}`` on success; otherwise the errors list
 * spells out which segment(s) are malformed for the UI tooltip.
 */
export function validateImageFilename(name: string): ValidationResult {
  if (IMAGE_FILENAME_REGEX.test(name)) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  if (!name.endsWith(".png")) {
    errors.push("Image filename must end with .png");
  }
  const parts = name.replace(/\.png$/, "").split(" | ");
  if (parts.length !== 4) {
    errors.push("Image filename must have 4 ' | '-separated segments");
    return { ok: false, errors };
  }
  const [client = "", concept = "", ratio = "", version = ""] = parts;
  if (!/^[A-Za-z0-9- ]+$/.test(client)) {
    errors.push("Client label must be letters / digits / spaces / dashes");
  }
  if (!concept || concept.includes("|")) {
    errors.push("Concept must be non-empty and cannot contain '|'");
  }
  if (!/^(1x1|9x16|16x9)$/.test(ratio)) {
    errors.push("Ratio must be one of 1x1, 9x16, 16x9");
  }
  if (!/^v\d+\.\d+$/.test(version)) {
    errors.push("Version must look like 'v1.0'");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a candidate video filename. Symmetric with
 * :func:`validateImageFilename` but the third segment is a duration
 * (e.g. ``30s``) rather than an aspect ratio.
 */
export function validateVideoFilename(name: string): ValidationResult {
  if (VIDEO_FILENAME_REGEX.test(name)) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  if (!name.endsWith(".mp4")) {
    errors.push("Video filename must end with .mp4");
  }
  const parts = name.replace(/\.mp4$/, "").split(" | ");
  if (parts.length !== 4) {
    errors.push("Video filename must have 4 ' | '-separated segments");
    return { ok: false, errors };
  }
  const [client = "", concept = "", dur = "", version = ""] = parts;
  if (!/^[A-Za-z0-9- ]+$/.test(client)) {
    errors.push("Client label must be letters / digits / spaces / dashes");
  }
  if (!concept || concept.includes("|")) {
    errors.push("Concept must be non-empty and cannot contain '|'");
  }
  if (!/^\d+s$/.test(dur)) {
    errors.push("Duration must look like '30s'");
  }
  if (!/^v\d+\.\d+$/.test(version)) {
    errors.push("Version must look like 'v1.0'");
  }
  return { ok: errors.length === 0, errors };
}

/** Compose an image filename from typed parts. Symmetric with the worker. */
export function buildImageFilename(parts: ImageFilenameParts): string {
  const v = parts.version.replace(/^v/, "");
  const client = parts.client_label.replace(/\|/g, "/").trim();
  const concept = parts.concept.replace(/\|/g, "/").trim();
  return `${client} | ${concept} | ${parts.ratio} | v${v}.png`;
}

/** Compose a video filename from typed parts. */
export function buildVideoFilename(parts: VideoFilenameParts): string {
  const v = parts.version.replace(/^v/, "");
  const client = parts.client_label.replace(/\|/g, "/").trim();
  const concept = parts.concept.replace(/\|/g, "/").trim();
  return `${client} | ${concept} | ${parts.duration_s}s | v${v}.mp4`;
}

/**
 * Parse an image filename back into its parts. Returns ``null`` when the
 * input doesn't match the convention. Callers that only need a yes/no
 * answer should use :func:`validateImageFilename` instead.
 */
export function parseImageFilename(name: string): ImageFilenameParts | null {
  if (!validateImageFilename(name).ok) return null;
  const base = name.replace(/\.png$/, "");
  const [client_label = "", concept = "", ratio = "", version = ""] = base.split(" | ");
  return {
    client_label: client_label.trim(),
    concept: concept.trim(),
    ratio: ratio as ImageNamingRatio,
    version,
  };
}

/** Parse a video filename back into its parts, or ``null`` on mismatch. */
export function parseVideoFilename(name: string): VideoFilenameParts | null {
  if (!validateVideoFilename(name).ok) return null;
  const base = name.replace(/\.mp4$/, "");
  const [client_label = "", concept = "", dur = "", version = ""] = base.split(" | ");
  return {
    client_label: client_label.trim(),
    concept: concept.trim(),
    duration_s: parseInt(dur.replace(/s$/, ""), 10),
    version,
  };
}
