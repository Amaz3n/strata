// Stripped Midday form: no TRPC/draft autosave; submit handled upstream
import type React from "react";
import { useEffect } from "react";
import type { Contact, CostCode } from "@/lib/types";
import { useFormContext } from "react-hook-form";
import { Icons } from "@midday/ui/icons";
import { ScrollArea } from "@midday/ui/scroll-area";
import { CustomerDetails } from "./customer-details";
import { EditBlock } from "./edit-block";
import { FromDetails } from "./from-details";
import { LineItems } from "./line-items";
import { Logo } from "./logo";
import { Meta } from "./meta";
import { NoteDetails } from "./note-details";
import { PaymentDetails } from "./payment-details";
import { SubmitButton } from "./submit-button";
import { Summary } from "./summary";

type FormProps = {
  hideSubmit?: boolean;
  isSubmitting?: boolean;
  contacts?: Contact[];
  costCodes?: CostCode[];
};

export function Form({ hideSubmit = false, isSubmitting, contacts, costCodes }: FormProps) {
  const form = useFormContext();
  const token = form.watch("token");
  const issueDate = form.watch("issueDate");
  const paymentTermsDays = form.watch("template.paymentTermsDays");
  const dueDate = form.watch("dueDate");

  // Auto-update due date when issue date or payment terms change
  useEffect(() => {
    if (!issueDate || !paymentTermsDays) return;
    const base = new Date(issueDate);
    if (Number.isNaN(base.getTime())) return;
    const next = new Date(base);
    next.setDate(base.getDate() + Number(paymentTermsDays));
    const iso = next.toISOString().slice(0, 10);
    if (iso !== dueDate) {
      form.setValue("dueDate", iso, { shouldDirty: true, shouldValidate: true });
    }
  }, [issueDate, paymentTermsDays, dueDate, form]);

  // Prevent form from submitting when pressing enter; submit is handled upstream
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
  };

  return (
    <div className="relative h-full" onKeyDown={handleKeyDown}>
      <ScrollArea className="h-[calc(100vh-200px)] bg-[#fcfcfc] dark:bg-[#121212]">
        <div className="p-8 pb-4 h-full flex flex-col">
          <div className="flex justify-between">
            <Meta />
            <Logo />
          </div>

          <div className="grid grid-cols-2 gap-6 mt-8 mb-4">
            <div>
              <FromDetails />
            </div>
            <div>
              <CustomerDetails contacts={contacts} />
            </div>
          </div>

          <EditBlock name="topBlock" />

          <div className="mt-4">
            <LineItems costCodes={costCodes} />
          </div>

          <div className="mt-12 flex justify-end mb-8">
            <Summary />
          </div>

          <div className="flex flex-col mt-auto">
            <div className="grid grid-cols-2 gap-6 mb-4 overflow-hidden">
              <PaymentDetails />
              <NoteDetails />
            </div>

            <EditBlock name="bottomBlock" />
          </div>
        </div>
      </ScrollArea>

      {!hideSubmit && (
        <div className="absolute bottom-14 w-full h-9">
          <div className="flex justify-between items-center mt-auto">
            <div className="flex space-x-2 items-center text-xs text-[#808080]">
              {token && (
                <a
                  href={`/i/${token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1"
                >
                  <Icons.ExternalLink className="size-3" />
                  <span>Preview invoice</span>
                </a>
              )}
            </div>

            <SubmitButton isSubmitting={!!isSubmitting} disabled={!!isSubmitting} />
          </div>
        </div>
      )}
    </div>
  );
}
