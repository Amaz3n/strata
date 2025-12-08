"use client";

import type React from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Icons } from "@midday/ui/icons";
import { useFormContext } from "react-hook-form";

type MenuOption<T = string | boolean | number> = { value: T; label: string };
type MenuItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  options: MenuOption[];
  key: string;
};

const invoiceSizes: MenuOption<string>[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
];

const booleanOptions: MenuOption<boolean>[] = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
];

const menuItems: MenuItem[] = [
  {
    icon: Icons.CropFree,
    label: "Invoice size",
    options: invoiceSizes,
    key: "size",
  },
  {
    icon: Icons.DateFormat,
    label: "Payment terms",
    options: [
      { value: 7, label: "Net 7" },
      { value: 15, label: "Net 15" },
      { value: 30, label: "Net 30" },
      { value: 45, label: "Net 45" },
      { value: 60, label: "Net 60" },
    ],
    key: "paymentTermsDays",
  },
  {
    icon: Icons.Tax,
    label: "Add sales tax",
    options: booleanOptions,
    key: "includeTax",
  },
  {
    icon: Icons.ConfirmationNumber,
    label: "Add discount",
    options: booleanOptions,
    key: "includeDiscount",
  },
  {
    icon: Icons.AttachEmail,
    label: "Attach PDF in email",
    options: booleanOptions,
    key: "includePdf",
  },
  {
    icon: Icons.OutgoingMail,
    label: "Send copy (BCC)",
    options: booleanOptions,
    key: "sendCopy",
  },
  {
    icon: Icons.QrCode,
    label: "Add QR code",
    options: booleanOptions,
    key: "includeQr",
  },
];

export function SettingsMenu() {
  const { watch, setValue } = useFormContext();
  const updateTemplateMutation = { mutate: (_: any) => {} };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button">
          <Icons.MoreVertical className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {menuItems.map((item, index) => {
          const watchKey = `template.${item.key}`;

          return (
            <DropdownMenuSub key={index.toString()}>
              <DropdownMenuSubTrigger>
                <item.icon className="mr-2 size-4" />
                <span className="text-xs">{item.label}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent
                  className="p-0 max-h-48 overflow-y-auto"
                  sideOffset={8}
                >
                  {item.options.map((option, optionIndex) => (
                    <DropdownMenuCheckboxItem
                      key={optionIndex.toString()}
                      className="text-xs"
                      checked={watch(watchKey) === option.value}
                      onCheckedChange={() => {
                        setValue(watchKey, option.value, {
                          shouldValidate: true,
                          shouldDirty: true,
                        });

                        updateTemplateMutation.mutate({
                          [item.key]: option.value,
                        });
                      }}
                    >
                      {option.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
