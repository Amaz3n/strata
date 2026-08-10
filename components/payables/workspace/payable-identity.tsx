"use client"

import { useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, Check, ChevronsUpDown, X } from "lucide-react"

import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { Company } from "@/lib/types"
import { cn } from "@/lib/utils"
import { vendorLabel } from "../payables-ui"
import type { PayableStage, VendorBillStatus } from "./payable-form"

const VENDOR_TYPES = new Set(["subcontractor", "supplier", "other"])
const RESULT_CAP = 30

/**
 * The four positions a payable passes through on its way to the vendor holding
 * the money. Rendered as one object — segments for the position, a word for the
 * name — so the state is stated once instead of as a badge, a banner and a dot.
 */
const RAIL_STEPS = ["Received", "Approved", "Scheduled", "Paid"] as const

type StageDisplay = { label: string; railIndex: number | null; tone: string }

function stageDisplay(stage: PayableStage, status: VendorBillStatus): StageDisplay {
  switch (stage) {
    case "credit":
      return { label: "Vendor credit", railIndex: null, tone: "text-muted-foreground" }
    case "draft":
      return { label: "Draft", railIndex: null, tone: "text-muted-foreground" }
    case "rejected":
      return { label: "Rejected", railIndex: null, tone: "text-destructive" }
    case "review":
      return { label: "Needs approval", railIndex: 0, tone: "text-warning" }
    case "in_run":
      return { label: "In payment run", railIndex: 2, tone: "text-primary" }
    case "paid":
      return { label: "Paid", railIndex: 3, tone: "text-success" }
    case "payable":
      return status === "partial"
        ? { label: "Partly paid", railIndex: 1, tone: "text-primary" }
        : { label: "Approved", railIndex: 1, tone: "text-foreground" }
  }
}

const READINESS_DOTS: Record<CompanyPaymentReadinessStatus, { label: string; tone: string }> = {
  ready: { label: "ACH", tone: "text-success" },
  verifying: { label: "Verifying bank", tone: "text-warning" },
  invited: { label: "Invited", tone: "text-muted-foreground" },
  not_started: { label: "Check only", tone: "text-muted-foreground" },
  suspended: { label: "ACH suspended", tone: "text-warning" },
  revoked: { label: "ACH revoked", tone: "text-destructive" },
}

interface PayableIdentityProps {
  bill: VendorBillSummary
  stage: PayableStage
  status: VendorBillStatus
  /** Facts that sit under the vendor name, already resolved to display strings. */
  subtitleParts: string[]
  railOpen: boolean
  readiness?: CompanyPaymentReadinessStatus
  canChangeVendor: boolean
  onSelectCompany: (company: Company) => void
  accountingEnabled: boolean
  onBack: () => void
  onClose: () => void
  /** The overflow menu and any header actions, owned by the workspace. */
  actions?: ReactNode
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
  railOpen,
  readiness,
  canChangeVendor,
  onSelectCompany,
  accountingEnabled,
  onBack,
  onClose,
  actions,
}: PayableIdentityProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Company[]>([])
  const [searching, setSearching] = useState(false)

  // Debounced server search, only while the picker is open. The org directory is
  // never loaded wholesale just to power this one field.
  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    setSearching(true)
    const handle = setTimeout(() => {
      listCompaniesAction(query.trim() ? { search: query.trim() } : undefined)
        .then((rows) => {
          if (cancelled) return
          setResults(
            rows
              .filter((company) => VENDOR_TYPES.has(company.company_type ?? ""))
              .slice(0, RESULT_CAP),
          )
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [pickerOpen, query])

  const display = stageDisplay(stage, status)
  const railIndex = display.railIndex
  const readinessDot = railOpen && bill.company_id ? READINESS_DOTS[readiness ?? "not_started"] : null

  const title = (
    <span className="truncate text-xl font-semibold leading-tight tracking-tight">
      {vendorLabel(bill)}
    </span>
  )

  return (
    <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-3 pt-4 sm:px-8">
      <div className="flex min-w-0 items-start gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 size-8 shrink-0 md:hidden"
          onClick={onBack}
          title="Back to list"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
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
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput value={query} onValueChange={setQuery} placeholder="Search vendors…" />
                    <CommandList className="max-h-72 overflow-y-auto">
                      <CommandEmpty>{searching ? "Searching…" : "No matching vendors."}</CommandEmpty>
                      <CommandGroup>
                        {results.map((company) => (
                          <CommandItem
                            key={company.id}
                            value={company.id}
                            onSelect={() => {
                              setPickerOpen(false)
                              onSelectCompany(company)
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 size-4",
                                company.id === bill.company_id ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">{company.name}</span>
                              {accountingEnabled ? (
                                <span className="block truncate text-[10px] text-muted-foreground">
                                  {company.qbo_vendor_id
                                    ? `QuickBooks: ${company.qbo_vendor_name ?? "Linked"}`
                                    : "No QuickBooks vendor linked"}
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
            {readinessDot ? (
              <span className={cn("flex shrink-0 items-center gap-1 text-[11px]", readinessDot.tone)}>
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                {readinessDot.label}
              </span>
            ) : null}
          </div>
          {subtitleParts.length > 0 ? (
            <p className="mt-1 truncate text-[13px] text-muted-foreground">{subtitleParts.join("  ·  ")}</p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-2" title={display.label}>
          {railIndex !== null ? (
            <span aria-hidden className="hidden items-center gap-0.5 sm:flex">
              {RAIL_STEPS.map((step, index) => (
                <span
                  key={step}
                  className={cn(
                    "h-[3px] w-4",
                    index < railIndex && "bg-foreground/30",
                    index > railIndex && "bg-border",
                    index === railIndex && `bg-current ${display.tone}`,
                  )}
                />
              ))}
            </span>
          ) : null}
          <span className={cn("text-xs font-medium", display.tone)}>{display.label}</span>
        </div>
        {actions}
        <Button variant="ghost" size="icon" className="size-8" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
          <span className="sr-only">Close payable</span>
        </Button>
      </div>
    </div>
  )
}
