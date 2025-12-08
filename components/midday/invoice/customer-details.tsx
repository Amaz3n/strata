"use client";

import type { JSONContent } from "@tiptap/react";
import { useMemo, useState } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Icons } from "@midday/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/midday/ui/popover";
import { Editor } from "@/components/midday/invoice/editor";
import { LabelInput } from "./label-input";
import type { Contact } from "@/lib/types";

type Props = {
  contacts?: Contact[];
};

function buildContactContent(contact: Contact): JSONContent {
  const lines = [
    contact.full_name,
    contact.email ?? "",
    contact.phone ?? "",
    contact.role ?? "",
    contact.primary_company?.name ?? "",
  ].filter((line) => line && line.trim().length > 0);

  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    })),
  };
}

export function CustomerDetails({ contacts }: Props) {
  const { control, setValue, watch } = useFormContext();
  const [open, setOpen] = useState(false);
  const content = watch("customerDetails");
  const id = watch("id");

  const contactList = useMemo(() => contacts ?? [], [contacts]);

  const handleLabelSave = (_value: string) => {
    // no-op; template labels not persisted in this shim
  };

  const handleSelectContact = (contact: Contact) => {
    setValue("customerId", contact.id, { shouldValidate: true, shouldDirty: true });
    setValue("customerName", contact.full_name, { shouldValidate: true, shouldDirty: true });
    setValue("customerDetails", buildContactContent(contact), { shouldValidate: true, shouldDirty: true });
    setOpen(false);
  };

  const handleOnChange = (value?: JSONContent | null) => {
    setValue("customerDetails", value, {
      shouldValidate: true,
      shouldDirty: true,
    });
    if (!value) {
      setValue("customerName", null, { shouldValidate: true, shouldDirty: true });
      setValue("customerId", null, { shouldValidate: true, shouldDirty: true });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <LabelInput name="template.customerLabel" className="mb-0 block" onSave={handleLabelSave} />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>Select customer</span>
              <Icons.ChevronDown className="size-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[260px] p-1">
            <div className="max-h-64 overflow-y-auto">
              {contactList.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">No contacts found</div>
              ) : (
                contactList.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => handleSelectContact(contact)}
                    className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                  >
                    <div className="font-medium text-foreground">{contact.full_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[contact.email, contact.phone, contact.primary_company?.name].filter(Boolean).join(" • ")}
                    </div>
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Controller
        name="customerDetails"
        control={control}
        render={({ field }) => (
          <Editor
            key={id}
            initialContent={field.value}
            onChange={handleOnChange}
            className="min-h-[90px]"
            placeholder="Customer details"
          />
        )}
      />
    </div>
  );
}
