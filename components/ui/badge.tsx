import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Canonical shadcn/ui `<Badge />`. The low-level chip primitive that
 * `StatusBadge` composes on top of. Variants map onto the design-system
 * status tokens (success/warning/info/destructive) so badges read
 * consistently in both themes.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        destructive:
          "border-transparent bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/30",
        success: "border-transparent bg-success/15 text-success ring-1 ring-inset ring-success/30",
        warning: "border-transparent bg-warning/15 text-warning ring-1 ring-inset ring-warning/30",
        info: "border-transparent bg-info/15 text-info ring-1 ring-inset ring-info/30",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
