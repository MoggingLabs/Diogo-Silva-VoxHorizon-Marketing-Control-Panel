import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

import { expect, test } from "./_fixtures";

/**
 * Clients CRUD happy path (Makeover M2 / #586-589).
 *
 * Drives the real routes + UI end to end:
 *   1. Create a client from /clients/new (identity form -> POST /api/clients).
 *   2. Land on the detail page; edit identity (PATCH /api/clients/:id).
 *   3. Add a Services child (POST /api/clients/:id/services).
 *   4. Archive the client (DELETE /api/clients/:id) -> status reads Archived.
 *   5. Restore the client (POST /api/clients/:id/restore) -> editable again.
 *
 * Self-contained: it creates its own uniquely-slugged client and deletes it
 * (cascading the child) in an afterEach, so it does not depend on the shared
 * test-client fixture and leaves no residue in the shared dev DB.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;

function admin(): SupabaseClient<Database> {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for the clients-crud e2e.",
    );
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Unique slug per run so parallel-ish reruns never collide on the unique index.
const SLUG = `e2e-crud-${Date.now()}`;
const NAME = `E2E CRUD ${Date.now()}`;

test.afterEach(async () => {
  // Delete by slug (cascades the service child via the FK ON DELETE CASCADE).
  await admin().from("clients").delete().eq("slug", SLUG);
});

test.describe("clients CRUD", () => {
  test("create -> edit -> add child -> archive -> restore", async ({ page }) => {
    // 1) Create -----------------------------------------------------------
    await page.goto("/clients/new");
    await page.getByLabel("Name").fill(NAME);
    // The slug auto-fills from the name; overwrite with our unique test slug.
    const slug = page.getByLabel("Slug");
    await slug.fill(SLUG);
    await page.getByRole("button", { name: /create client/i }).click();

    // Routes to the new client's detail page.
    await expect(page).toHaveURL(/\/clients\/[a-f0-9-]{36}$/);
    await expect(page.getByRole("heading", { name: NAME })).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    // 2) Edit identity ----------------------------------------------------
    await page.getByRole("button", { name: /^edit$/i }).click();
    const editDialog = page.getByRole("dialog");
    const nameField = editDialog.getByLabel("Name");
    await nameField.fill(`${NAME} LLC`);
    await editDialog.getByRole("button", { name: /save/i }).click();
    await expect(page.getByRole("heading", { name: `${NAME} LLC` })).toBeVisible();

    // 3) Add a Services child --------------------------------------------
    await page.getByRole("tab", { name: /services/i }).click();
    // The Services section's Add button (first "Add" on the panel).
    await page.getByRole("button", { name: /^add$/i }).first().click();
    const addDialog = page.getByRole("dialog");
    await addDialog.getByLabel("Service name").fill("Roof replacement");
    await addDialog.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText("Roof replacement")).toBeVisible();

    // 4) Archive ----------------------------------------------------------
    await page.getByRole("button", { name: /^archive$/i }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "Archive" }).click();
    // Detail re-renders archived: status badge reads Archived, Restore appears.
    await expect(page.getByText("Archived", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /restore/i })).toBeVisible();

    // 5) Restore ----------------------------------------------------------
    await page.getByRole("button", { name: /restore/i }).click();
    await expect(page.getByRole("button", { name: /^edit$/i })).toBeVisible({ timeout: 15_000 });
  });
});
