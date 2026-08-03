"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { Check, ChevronsUpDown, MoreHorizontal } from "lucide-react"

import { inviteCompanyToPaymentSetupAction, listCompaniesAction } from "@/app/(app)/companies/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { unwrapAction } from "@/lib/action-result"
import type { Company } from "@/lib/types"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { vendorLabel, vendorLinkBadge } from "../payables-ui"
import { cn } from "@/lib/utils"

const VENDOR_TYPES = new Set(["subcontractor", "supplier", "other"])
const RESULT_CAP = 30

const READINESS_BADGES: Record<CompanyPaymentReadinessStatus, { label: string; className: string }> = {
  ready: { label: "ACH ready", className: "border-success/25 bg-success/10 text-success" },
  verifying: { label: "Bank verification pending", className: "border-warning/25 bg-warning/10 text-warning" },
  invited: { label: "Invited to set up payments", className: "border-border bg-accent text-accent-foreground" },
  not_started: { label: "Paid by check", className: "border-border bg-muted text-muted-foreground" },
}

/**
 * Who gets paid, whether they can be paid electronically, and the controls to
 * change either. Vendor search hits the server on demand — the org directory is
 * never loaded wholesale just to power this picker.
 */
export function PayableVendorCard({
  bill,
  accountingEnabled,
  railOpen,
  readiness,
  onSelectCompany,
  onEditVendor,
  onInvited,
}: {
  bill: VendorBillSummary
  accountingEnabled: boolean
  railOpen: boolean
  readiness?: CompanyPaymentReadinessStatus
  onSelectCompany: (company: Company) => void
  onEditVendor: () => void
  onInvited: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Company[]>([])
  const [searching, setSearching] = useState(false)
  const [isInviting, startInviting] = useTransition()

  // Debounced server search, only while the picker is open.
  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    setSearching(true)
    const handle = setTimeout(() => {
      listCompaniesAction(query.trim() ? { search: query.trim() } : undefined)
        .then((rows) => {
          if (cancelled) return
          setResults(rows.filter((company) => VENDOR_TYPES.has(company.company_type ?? "")).slice(0, RESULT_CAP))
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

  const invite = () => {
    const companyId = bill.company_id
    if (!companyId) return
    startInviting(async () => {
      try {
        const result = unwrapAction(await inviteCompanyToPaymentSetupAction(companyId))
        toast.success(`Invitation sent to ${result.companyName}`)
        onInvited()
      } catch (error) {
        toast.error("Unable to send the invitation", { description: (error as Error).message })
      }
    })
  }

  const readinessBadge = railOpen && bill.company_id ? READINESS_BADGES[readiness ?? "not_started"] : null
  const showInvite = railOpen && bill.company_id && (readiness === "not_started" || readiness === "invited" || !readiness)

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label className="microlabel">Vendor</Label>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-base font-semibold">{vendorLabel(bill)}</span>
          {readinessBadge ? (
            <Badge variant="outline" className={cn("font-normal", readinessBadge.className)}>
              {readinessBadge.label}
            </Badge>
          ) : null}
          {accountingEnabled ? vendorLinkBadge(bill) : null}
        </div>
        {bill.commitment_title ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">Against {bill.commitment_title}</p>
        ) : null}
        {accountingEnabled && !bill.qbo_vendor_id ? (
          <p className="mt-1 text-xs text-muted-foreground">No QuickBooks vendor linked yet. Link or create one before syncing.</p>
        ) : null}
        {showInvite ? (
          <Button variant="link" size="sm" className="mt-0.5 h-auto p-0 text-xs" disabled={isInviting} onClick={invite}>
            {isInviting ? "Sending…" : readiness === "invited" ? "Remind vendor to set up electronic payments" : "Invite vendor to set up electronic payments"}
          </Button>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs text-muted-foreground">
              Change
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
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
                      <Check className={cn("mr-2 size-4", company.id === bill.company_id ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{company.name}</span>
                        {accountingEnabled ? (
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {company.qbo_vendor_id ? `QuickBooks: ${company.qbo_vendor_name ?? "Linked"}` : "No QuickBooks vendor linked"}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Vendor actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onEditVendor}>Edit vendor details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
