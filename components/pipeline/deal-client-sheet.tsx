"use client";

import { useEffect, useState, useTransition, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { updateDealClientAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import type { DealClientInput } from "@/lib/validation/deals";

export type DealClient = {
  name: string;
  email: string;
  phone: string;
  address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
};

/** Who the deal is for and where the work is. Asked when it first matters, edited here. */
export function DealClientSheet({
  open,
  onOpenChange,
  dealId,
  dealName,
  client,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  dealName: string;
  client: DealClient;
}) {
  const router = useRouter();
  const initial: DealClientInput = {
    name: dealName,
    client_name: client.name,
    email: client.email,
    phone: client.phone,
    street: client.street,
    city: client.city,
    state: client.state,
    postal_code: client.postal_code,
  };
  const [form, setForm] = useState(initial);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (open) setForm(initial);
    // Reset to the saved record each time the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const field = (key: keyof DealClientInput, label: string, props: ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`deal-client-${key}`}>{label}</Label>
      <Input
        id={`deal-client-${key}`}
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        {...props}
      />
    </div>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Client details</SheetTitle>
          <SheetDescription>The document goes to this email. The address prints on it.</SheetDescription>
        </SheetHeader>
        <form
          id="deal-client-form"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              try {
                unwrapAction(await updateDealClientAction(dealId, form));
                toast.success("Client details saved");
                onOpenChange(false);
                router.refresh();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Unable to save client details");
              }
            });
          }}
        >
          {field("name", "Deal name")}
          {field("client_name", "Client name", { autoComplete: "name" })}
          {field("email", "Email", { type: "email", autoComplete: "email" })}
          {field("phone", "Phone", { type: "tel", autoComplete: "tel" })}
          {field("street", "Job address", { autoComplete: "street-address" })}
          <div className="grid grid-cols-[1fr_5rem_6rem] gap-2">
            {field("city", "City")}
            {field("state", "State")}
            {field("postal_code", "ZIP")}
          </div>
        </form>
        <SheetFooter>
          <Button type="submit" form="deal-client-form" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
