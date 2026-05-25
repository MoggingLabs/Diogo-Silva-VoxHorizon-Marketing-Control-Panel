"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useTheme } from "@/components/ThemeProvider";

/**
 * Toast host. Wraps `sonner`'s `<Toaster />`, binding its theme to the app
 * ThemeProvider so toasts match light/dark, and styling toast surfaces with
 * the design-system tokens. Mounted once in `app/layout.tsx`. Emit toasts
 * anywhere with `import { toast } from "sonner"`.
 */
export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          error: "group-[.toaster]:text-destructive",
          success: "group-[.toaster]:text-success",
          warning: "group-[.toaster]:text-warning",
          info: "group-[.toaster]:text-info",
        },
      }}
      {...props}
    />
  );
}
