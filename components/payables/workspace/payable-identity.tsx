"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { listCompaniesAction } from "@/app/(app)/companies/actions";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import type { Company } from "@/lib/types";
import { cn } from "@/lib/utils";
import { vendorLabel } from "../payables-ui";
import type { PayableStage, VendorBillStatus } from "./payable-form";

const VENDOR_TYPES = new Set(["subcontractor", "supplier", "other"]);
const RESULT_CAP = 30;

type StageDisplay = { label: string; tone: string };

function stageDisplay(
  stage: PayableStage,
  status: VendorBillStatus,
): StageDisplay {
  switch (stage) {
    case "credit":
      return {
        label: "Vendor credit",
        tone: "text-muted-foreground",
      };
    case "draft":
      return { label: "Draft", tone: "text-muted-foreground" };
    case "rejected":
      return { label: "Rejected", tone: "text-destructive" };
    case "review":
      return { label: "Needs approval", tone: "text-warning" };
    case "in_run":
      return { label: "In payment run", tone: "text-primary" };
    case "paid":
      return { label: "Paid", tone: "text-success" };
    case "payable":
      return status === "partial"
        ? { label: "Partly paid", tone: "text-primary" }
        : { label: "Approved", tone: "text-foreground" };
  }
}

interface PayableIdentityProps {
  bill: VendorBillSummary;
  stage: PayableStage;
  status: VendorBillStatus;
  /** Facts that sit under the vendor name, already resolved to display strings. */
  subtitleParts: string[];
  canChangeVendor: boolean;
  pendingVendorName?: string;
  onSelectCompany: (company: Company) => void;
  accountingEnabled: boolean;
  /** The overflow menu and any header actions, owned by the workspace. */
  actions?: ReactNode;
}

/**
 * Who is owed, what this record is, and where it stands — the three things that
 * stay true no matter which body tab is open. The vendor is the title because
 * that is how the payable is remembered; the bill number is a reference, not a
 * name.
 */
export function PayableIdentity({
  bill,
  stage,
  status,
  subtitleParts,
  canChangeVendor,
  pendingVendorName,
  onSelectCompany,
  accountingEnabled,
  actions,
}: PayableIdentityProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Company[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced server search, only while the picker is open. The org directory is
  // never loaded wholesale just to power this one field.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      listCompaniesAction(query.trim() ? { search: query.trim() } : undefined)
        .then((rows) => {
          if (cancelled) return;
          setResults(
            rows
              .filter((company) => VENDOR_TYPES.has(company.company_type ?? ""))
              .slice(0, RESULT_CAP),
          );
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [pickerOpen, query]);

  const display = stageDisplay(stage, status);

  const title = (
    <span className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
      {pendingVendorName ?? vendorLabel(bill)}
    </span>
  );

  return (
    <div className="flex items-start justify-between gap-4 pb-7">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0">
          <p className={cn("mb-3 text-xs font-medium", display.tone)}>
            {display.label}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            {canChangeVendor ? (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group flex min-w-0 items-center gap-1.5 text-left"
                    title="Change vendor"
                  >
                    {title}
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      value={query}
                      onValueChange={setQuery}
                      placeholder="Search vendors…"
                    />
                    <CommandList className="max-h-72 overflow-y-auto">
                      <CommandEmpty>
                        {searching ? "Searching…" : "No matching vendors."}
                      </CommandEmpty>
                      <CommandGroup>
                        {results.map((company) => (
                          <CommandItem
                            key={company.id}
                            value={company.id}
                            onSelect={() => {
                              setPickerOpen(false);
                              onSelectCompany(company);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 size-4",
                                company.id === bill.company_id
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">
                                {company.name}
                              </span>
                              {accountingEnabled ? (
                                <span className="block truncate text-[10px] text-muted-foreground">
                                  {company.qbo_vendor_id
                                    ? `Accounting vendor: ${company.qbo_vendor_name ?? "Linked"}`
                                    : "No accounting vendor linked"}
                                </span>
                              ) : null}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              title
            )}
          </div>
          {subtitleParts.length > 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {subtitleParts.join("  ·  ")}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 pt-6">{actions}</div>
    </div>
  );
}
