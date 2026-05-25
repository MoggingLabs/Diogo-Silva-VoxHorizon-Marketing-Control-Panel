"use client";

import * as React from "react";
import {
  FormProvider,
  useForm,
  type DefaultValues,
  type FieldValues,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ZodType } from "zod";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export type CrudDrawerProps<TValues extends FieldValues> = {
  /** Controlled open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;

  title: React.ReactNode;
  description?: React.ReactNode;

  /** Zod schema validating the form values (react-hook-form resolver). */
  schema: ZodType<TValues>;
  defaultValues: DefaultValues<TValues>;

  /**
   * Submit handler. Resolve to close + toast success; throw (or reject) to
   * show the error toast and keep the drawer open so the operator can retry.
   */
  onSubmit: (values: TValues) => Promise<void> | void;

  /** Render the form fields. Receives the react-hook-form context implicitly via FormProvider. */
  children: React.ReactNode;

  submitLabel?: string;
  /** Toast shown on a successful submit. */
  successMessage?: string;
  /** Called after a successful submit (e.g. `router.refresh()`). */
  onSuccess?: () => void;
  /** Sheet side. */
  side?: "left" | "right" | "top" | "bottom";
};

/**
 * Reusable create/edit drawer. Wraps the `Sheet` slide-over with a
 * react-hook-form context (zod-validated) and standard submit lifecycle:
 * submit -> onSubmit -> toast -> onSuccess (caller refresh) -> close.
 *
 * The caller renders the actual fields as `children`; bind them with
 * `useFormContext()` from react-hook-form. The drawer owns the submit button,
 * loading state, success toast, and error handling.
 */
export function CrudDrawer<TValues extends FieldValues>({
  open,
  onOpenChange,
  title,
  description,
  schema,
  defaultValues,
  onSubmit,
  children,
  submitLabel = "Save",
  successMessage = "Saved",
  onSuccess,
  side = "right",
}: CrudDrawerProps<TValues>) {
  const form = useForm<TValues>({
    // The generic zod resolver can't narrow `TValues` through zod 4's
    // `unknown` input type, so cast at this boundary. Callers pass a concrete
    // schema, so runtime validation is still fully typed for them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema as any) as unknown as Resolver<TValues>,
    defaultValues,
  });
  const {
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = form;

  // Reseed the form whenever the drawer (re)opens so editing different rows
  // doesn't leak the previous row's values.
  React.useEffect(() => {
    if (open) reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(values);
      toast.success(successMessage);
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <FormProvider {...form}>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">{children}</div>
            <SheetFooter className="gap-2 border-t border-border px-6 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>Saving...</span>
                  </>
                ) : (
                  submitLabel
                )}
              </Button>
            </SheetFooter>
          </form>
        </FormProvider>
      </SheetContent>
    </Sheet>
  );
}
