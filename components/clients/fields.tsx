"use client";

import * as React from "react";
import { Controller, useFormContext, type FieldValues, type Path } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Thin form-field wrappers bound to the `react-hook-form` context that
 * `CrudDialog` / `CrudDrawer` provide. They keep the child-resource forms in
 * `ClientDetail` terse and consistent (label + control + inline error).
 */

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

export function TextField<T extends FieldValues>({
  name,
  label,
  placeholder,
  type = "text",
}: {
  name: Path<T>;
  label: string;
  placeholder?: string;
  type?: "text" | "number" | "url";
}) {
  const {
    register,
    formState: { errors },
  } = useFormContext<T>();
  const error = errors[name]?.message as string | undefined;
  const id = String(name);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        {...register(name)}
      />
      <FieldError message={error} />
    </div>
  );
}

export function TextareaField<T extends FieldValues>({
  name,
  label,
  placeholder,
  rows = 3,
}: {
  name: Path<T>;
  label: string;
  placeholder?: string;
  rows?: number;
}) {
  const {
    register,
    formState: { errors },
  } = useFormContext<T>();
  const error = errors[name]?.message as string | undefined;
  const id = String(name);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        {...register(name)}
      />
      <FieldError message={error} />
    </div>
  );
}

export function SelectField<T extends FieldValues>({
  name,
  label,
  options,
}: {
  name: Path<T>;
  label: string;
  options: readonly { value: string; label: string }[];
}) {
  const {
    control,
    formState: { errors },
  } = useFormContext<T>();
  const error = errors[name]?.message as string | undefined;
  const id = String(name);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <Select value={field.value || undefined} onValueChange={field.onChange}>
            <SelectTrigger id={id} aria-invalid={Boolean(error)}>
              <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      <FieldError message={error} />
    </div>
  );
}
