"use client";

import { Editor } from "@/components/midday/invoice/editor";
import { Controller, useFormContext } from "react-hook-form";
import { LabelInput } from "./label-input";

export function FromDetails() {
  const { control, watch } = useFormContext();
  const id = watch("id");

  const handleLabelSave = (_value: string) => {
    // no-op; template labels not persisted in this shim
  };

  return (
    <div>
      <LabelInput name="template.fromLabel" className="mb-2 block" onSave={handleLabelSave} />

      <Controller
        name="fromDetails"
        control={control}
        render={({ field }) => (
          <Editor
            key={id}
            initialContent={field.value}
            onChange={field.onChange}
            className="min-h-[90px] [&>div]:min-h-[90px]"
            placeholder="Your company details"
          />
        )}
      />
    </div>
  );
}
