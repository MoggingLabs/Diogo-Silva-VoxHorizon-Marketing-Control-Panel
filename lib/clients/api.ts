/**
 * Browser-side fetch wrappers for the Clients CRUD API (E2.4). These run in
 * client components, so they never import the admin client or `server-only`
 * modules; they call the same `/api/clients` routes the server uses.
 *
 * Each call throws an `Error` with the server's error string on a non-2xx
 * response so the shared CrudDrawer / ConfirmArchive lifecycle (which toasts on
 * a thrown error and keeps the dialog open) works without per-call try/catch.
 */

type ApiErrorBody = {
  error?: string;
  issues?: { message: string; path: (string | number)[] }[];
};

/** Map the API's machine error codes to operator-friendly sentences. */
const ERROR_COPY: Record<string, string> = {
  slug_taken: "That slug is already in use. Pick a different one.",
  provider_taken: "An integration for that provider already exists.",
  validation_failed: "Some fields are invalid. Check your input and try again.",
  not_found: "That record no longer exists.",
  client_not_found: "That client no longer exists.",
  already_archived: "That record is already archived.",
  not_archived: "That record is already active.",
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    const code = body.error ?? `request_failed_${res.status}`;
    const first = body.issues?.[0]?.message;
    throw new Error(ERROR_COPY[code] ?? first ?? code);
  }
  // 204-less routes always return JSON; tolerate an empty body just in case.
  return (await res.json().catch(() => ({}))) as T;
}

const json = (body: unknown) => JSON.stringify(body);

// --- clients ----------------------------------------------------------------

export function createClient(body: unknown) {
  return request<{ client: { id: string } }>("/api/clients", {
    method: "POST",
    body: json(body),
  });
}
export function updateClient(id: string, body: unknown) {
  return request<{ client: unknown }>(`/api/clients/${id}`, { method: "PATCH", body: json(body) });
}
export function archiveClient(id: string) {
  return request(`/api/clients/${id}`, { method: "DELETE" });
}
export function restoreClient(id: string) {
  return request(`/api/clients/${id}/restore`, { method: "POST" });
}

// --- profile ----------------------------------------------------------------

export function saveProfile(clientId: string, body: unknown) {
  return request(`/api/clients/${clientId}/profile`, { method: "PUT", body: json(body) });
}

// --- 1:many children --------------------------------------------------------

export function createChild(clientId: string, child: string, body: unknown) {
  return request<{ item: { id: string } }>(`/api/clients/${clientId}/${child}`, {
    method: "POST",
    body: json(body),
  });
}
export function updateChild(clientId: string, child: string, childId: string, body: unknown) {
  return request(`/api/clients/${clientId}/${child}/${childId}`, {
    method: "PATCH",
    body: json(body),
  });
}
export function archiveChild(clientId: string, child: string, childId: string) {
  return request(`/api/clients/${clientId}/${child}/${childId}`, { method: "DELETE" });
}
export function restoreChild(clientId: string, child: string, childId: string) {
  return request(`/api/clients/${clientId}/${child}/${childId}/restore`, { method: "POST" });
}

// --- integrations -----------------------------------------------------------

export function createIntegration(clientId: string, body: unknown) {
  return request(`/api/clients/${clientId}/integrations`, { method: "POST", body: json(body) });
}
export function updateIntegration(clientId: string, integrationId: string, body: unknown) {
  return request(`/api/clients/${clientId}/integrations/${integrationId}`, {
    method: "PATCH",
    body: json(body),
  });
}
export function archiveIntegration(clientId: string, integrationId: string) {
  return request(`/api/clients/${clientId}/integrations/${integrationId}`, { method: "DELETE" });
}
