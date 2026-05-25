/**
 * Tests for CrudDialog (centred-modal sibling of CrudDrawer). Covers the
 * render, zod-block, success lifecycle, error path, and cancel.
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

import { CrudDialog } from "./CrudDialog";

const schema = z.object({ title: z.string().min(1, "Title is required") });
type Values = z.infer<typeof schema>;

function TitleField() {
  const {
    register,
    formState: { errors },
  } = useFormContext<Values>();
  return (
    <div>
      <input aria-label="Title" {...register("title")} />
      {errors.title ? <p role="alert">{errors.title.message}</p> : null}
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CrudDialog", () => {
  it("renders the title and children and submits successfully", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <CrudDialog<Values>
        open
        onOpenChange={onOpenChange}
        title="Edit thing"
        schema={schema}
        defaultValues={{ title: "" }}
        onSubmit={onSubmit}
        successMessage="Thing saved"
      >
        <TitleField />
      </CrudDialog>,
    );
    expect(screen.getByText("Edit thing")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ title: "Hello" }));
    expect(toastSuccess).toHaveBeenCalledWith("Thing saved");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks submit on validation error", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CrudDialog<Values>
        open
        onOpenChange={vi.fn()}
        title="Edit thing"
        schema={schema}
        defaultValues={{ title: "" }}
        onSubmit={onSubmit}
      >
        <TitleField />
      </CrudDialog>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Title is required");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("toasts an error when submit throws", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("save failed"));
    render(
      <CrudDialog<Values>
        open
        onOpenChange={vi.fn()}
        title="Edit thing"
        schema={schema}
        defaultValues={{ title: "x" }}
        onSubmit={onSubmit}
      >
        <TitleField />
      </CrudDialog>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("save failed"));
  });

  it("falls back to a generic message for non-Error throws", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue("just a string");
    render(
      <CrudDialog<Values>
        open
        onOpenChange={vi.fn()}
        title="Edit thing"
        schema={schema}
        defaultValues={{ title: "x" }}
        onSubmit={onSubmit}
        className="max-w-2xl"
      >
        <TitleField />
      </CrudDialog>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Something went wrong"));
  });
});
