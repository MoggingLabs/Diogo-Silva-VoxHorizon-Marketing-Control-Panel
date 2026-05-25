/**
 * Tests for the reusable CrudDrawer.
 *
 * Covers: rendering title/description + children, zod validation blocking
 * submit, the submit -> toast.success -> onSuccess -> close lifecycle, the
 * error path (onSubmit throws -> toast.error, stays open), and the Cancel
 * affordance.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFormContext } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { CrudDrawer } from "./CrudDrawer";

const schema = z.object({ name: z.string().min(1, "Name is required") });
type Values = z.infer<typeof schema>;

function NameField() {
  const {
    register,
    formState: { errors },
  } = useFormContext<Values>();
  return (
    <div>
      <input aria-label="Name" {...register("name")} />
      {errors.name ? <p role="alert">{errors.name.message}</p> : null}
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

function setup(props: Partial<React.ComponentProps<typeof CrudDrawer<Values>>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn().mockResolvedValue(undefined);
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const onSuccess = props.onSuccess ?? vi.fn();
  render(
    <CrudDrawer<Values>
      open
      onOpenChange={onOpenChange}
      title="New widget"
      description="Create a widget"
      schema={schema}
      defaultValues={{ name: "" }}
      onSubmit={onSubmit}
      onSuccess={onSuccess}
      successMessage="Widget saved"
      {...props}
    >
      <NameField />
    </CrudDrawer>,
  );
  return { onSubmit, onOpenChange, onSuccess };
}

describe("CrudDrawer", () => {
  it("renders the title, description and children", () => {
    setup();
    expect(screen.getByText("New widget")).toBeInTheDocument();
    expect(screen.getByText("Create a widget")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("blocks submit when zod validation fails", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Name is required");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits, toasts success, calls onSuccess and closes", async () => {
    const user = userEvent.setup();
    const { onSubmit, onSuccess, onOpenChange } = setup();
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: "Acme" }));
    expect(toastSuccess).toHaveBeenCalledWith("Widget saved");
    expect(onSuccess).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toasts an error and stays open when onSubmit throws", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("boom"));
    const onOpenChange = vi.fn();
    setup({ onSubmit, onOpenChange });
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes via Cancel without submitting", async () => {
    const user = userEvent.setup();
    const { onSubmit, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for non-Error throws", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue("oops");
    setup({ onSubmit });
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Something went wrong"));
  });

  it("renders the left-side variant when requested", () => {
    setup({ side: "left", submitLabel: "Create" });
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });
});
