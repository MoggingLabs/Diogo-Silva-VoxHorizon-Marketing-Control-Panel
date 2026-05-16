import Link from "next/link";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Not found — VoxHorizon",
};

/**
 * Catch-all 404. Rendered by Next when a route doesn't match or when a server
 * component calls `notFound()` and no closer `not-found.tsx` is defined.
 */
export default function NotFoundPage() {
  return (
    <div className="container mx-auto flex min-h-dvh max-w-xl flex-col items-start gap-4 py-16">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Compass className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-2xl font-semibold text-foreground">Page not found</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t find what you were looking for. It may have been moved, or the URL is off.
      </p>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/">Go to dashboard</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/briefs">View briefs</Link>
        </Button>
      </div>
    </div>
  );
}
