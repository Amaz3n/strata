"use client";

import { useState } from "react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarDays } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { ComplianceDocument, ComplianceDocumentType } from "@/lib/types";

/**
 * What a compliance document says, and the controls that collect it.
 *
 * Shared by the builder's upload and review dialogs and by the vendor portal's
 * upload dialog. The portal used to keep its own copy that decided "is this
 * insurance" by looking for substrings in the type's CODE — `gl`, `wc`, `auto`
 * — while every other caller had already moved to the type's `kind`. A custom
 * insurance type whose code did not happen to contain one of those fragments
 * showed the vendor no carrier, no coverage and no endorsement checkboxes, so a
 * requirement demanding an endorsement could never be satisfied from the portal.
 */


export function parseMoneyToCents(value?: string | null) {
  const normalized = value?.replace(/[$,\s]/g, "") ?? "";
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100);
}

export function formatMoneyInput(cents?: number | null) {
  if (cents == null) return "";
  return (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function parseDateValue(value?: string | null) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateValue(date?: Date) {
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function DatePickerField({
  label,
  value,
  onChange,
  placeholder = "Pick a date",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateValue(value);

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="microlabel">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !selectedDate && "text-muted-foreground",
            )}
          >
            <CalendarDays className="mr-2 size-4" />
            {selectedDate ? format(selectedDate, "LLL dd, y") : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              onChange(formatDateValue(date));
              setOpen(false);
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The document facts a form collects, shared by the upload dialog and the review
 * dialog so a reviewer can correct exactly what an uploader could state.
 */
export interface DocumentFactValues {
  effective_date: string;
  expiry_date: string;
  policy_number: string;
  carrier_name: string;
  coverage_amount: string;
  additional_insured: boolean;
  primary_noncontributory: boolean;
  waiver_of_subrogation: boolean;
  license_number: string;
  license_jurisdiction: string;
  license_classification: string;
}

export const EMPTY_FACTS: DocumentFactValues = {
  effective_date: "",
  expiry_date: "",
  policy_number: "",
  carrier_name: "",
  coverage_amount: "",
  additional_insured: false,
  primary_noncontributory: false,
  waiver_of_subrogation: false,
  license_number: "",
  license_jurisdiction: "",
  license_classification: "",
};

export function factsToInput(facts: DocumentFactValues) {
  return {
    effective_date: facts.effective_date || undefined,
    expiry_date: facts.expiry_date || undefined,
    policy_number: facts.policy_number || undefined,
    carrier_name: facts.carrier_name || undefined,
    coverage_amount_cents: parseMoneyToCents(facts.coverage_amount),
    additional_insured: facts.additional_insured,
    primary_noncontributory: facts.primary_noncontributory,
    waiver_of_subrogation: facts.waiver_of_subrogation,
    license_number: facts.license_number || undefined,
    license_jurisdiction: facts.license_jurisdiction || undefined,
    license_classification: facts.license_classification || undefined,
  };
}

export function documentToFacts(document: ComplianceDocument): DocumentFactValues {
  return {
    effective_date: document.effective_date ?? "",
    expiry_date: document.expiry_date ?? "",
    policy_number: document.policy_number ?? "",
    carrier_name: document.carrier_name ?? "",
    coverage_amount: formatMoneyInput(document.coverage_amount_cents),
    additional_insured: document.additional_insured,
    primary_noncontributory: document.primary_noncontributory,
    waiver_of_subrogation: document.waiver_of_subrogation,
    license_number: document.license_number ?? "",
    license_jurisdiction: document.license_jurisdiction ?? "",
    license_classification: document.license_classification ?? "",
  };
}

/**
 * The fields a document of this kind actually has. An insurance certificate has
 * a carrier and limits; a license has a number and a jurisdiction. Deciding this
 * from the type's `kind` is what stopped a type named "Professional license"
 * being asked for its policy limits.
 */
export function DocumentFactFields({
  kind,
  hasExpiry,
  values,
  onChange,
}: {
  kind: ComplianceDocumentType["kind"];
  hasExpiry: boolean;
  values: DocumentFactValues;
  onChange: (next: Partial<DocumentFactValues>) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <DatePickerField
          label="Effective date"
          value={values.effective_date}
          onChange={(value) => onChange({ effective_date: value })}
          placeholder="Optional"
        />
        {hasExpiry ? (
          <DatePickerField
            label="Expiration date"
            value={values.expiry_date}
            onChange={(value) => onChange({ expiry_date: value })}
          />
        ) : null}
      </div>

      {kind === "insurance" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="microlabel">Policy #</Label>
              <Input
                value={values.policy_number}
                onChange={(event) => onChange({ policy_number: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="microlabel">Carrier</Label>
              <Input
                value={values.carrier_name}
                onChange={(event) => onChange({ carrier_name: event.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Coverage amount</Label>
            <InputGroup>
              <InputGroupAddon>$</InputGroupAddon>
              <InputGroupInput
                inputMode="decimal"
                placeholder="1,000,000"
                value={values.coverage_amount}
                onChange={(event) => onChange({ coverage_amount: event.target.value })}
                onBlur={() =>
                  onChange({ coverage_amount: formatMoneyInput(parseMoneyToCents(values.coverage_amount)) })
                }
              />
            </InputGroup>
          </div>
          <div className="flex flex-col gap-2 border p-3">
            <Label className="microlabel">Policy endorsements</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.additional_insured}
                onCheckedChange={(checked) => onChange({ additional_insured: checked === true })}
              />
              <span>Additional insured</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.primary_noncontributory}
                onCheckedChange={(checked) =>
                  onChange({ primary_noncontributory: checked === true })
                }
              />
              <span>Primary &amp; non-contributory</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.waiver_of_subrogation}
                onCheckedChange={(checked) => onChange({ waiver_of_subrogation: checked === true })}
              />
              <span>Waiver of subrogation</span>
            </label>
          </div>
        </>
      ) : null}

      {kind === "license" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">License #</Label>
            <Input
              value={values.license_number}
              onChange={(event) => onChange({ license_number: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Jurisdiction</Label>
            <Input
              placeholder="State or county"
              value={values.license_jurisdiction}
              onChange={(event) => onChange({ license_jurisdiction: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="microlabel">Classification</Label>
            <Input
              placeholder="e.g. CGC — certified general contractor"
              value={values.license_classification}
              onChange={(event) => onChange({ license_classification: event.target.value })}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
