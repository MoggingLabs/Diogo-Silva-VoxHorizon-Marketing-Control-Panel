import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <Button>Hello</Button>
      </header>
      <p className="text-muted-foreground">
        VoxHorizon Marketing Control Panel — scaffold ready. Modules land in
        later milestones.
      </p>
    </main>
  );
}
