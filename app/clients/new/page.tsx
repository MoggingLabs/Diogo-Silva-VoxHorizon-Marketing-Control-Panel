import Link from "next/link";

import { ClientForm } from "@/components/clients/ClientForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New client — VoxHorizon",
};

export default function NewClientPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header>
        <p className="text-sm text-muted-foreground">
          <Link href="/clients" className="underline-offset-4 hover:underline">
            Clients
          </Link>{" "}
          / new
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">New client</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create the client, then fill in its profile, services, offers, assets, and integrations
          from the detail page.
        </p>
      </header>
      <ClientForm />
    </main>
  );
}
