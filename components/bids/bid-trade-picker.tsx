"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import type { BidVendorChoice } from "@/lib/services/production-bid-vendors"
import type { Company } from "@/lib/types"
import { bulkCreateBidInvitesAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { ProductionBidVendorPicker } from "@/components/bids/production-bid-vendor-picker"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

const VISIBLE_CAP = 60
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Adds trades to a package. On a draft they are lined up and hear nothing
 * until the package is sent; once bidding is open they are sent right away.
 */
export function BidTradePicker({
  open,
  onOpenChange,
  context,
  bidPackage,
  companies,
  invitedCompanyIds,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext
  bidPackage: BidPackage
  companies: Company[]
  invitedCompanyIds: Set<string>
  onAdded: () => Promise<void>
}) {
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [remote, setRemote] = useState<BidVendorChoice[]>([])
  const [email, setEmail] = useState("")
  const [emails, setEmails] = useState<string[]>([])
  const [isSaving, startSaving] = useTransition()
  const draft = bidPackage.status === "draft"
  const priceBook = bidPackage.award_target === "price_agreement"

  const trade = bidPackage.trade?.trim().toLowerCase() ?? ""
  const { matches, others, total } = useMemo(() => {
    const term = search.trim().toLowerCase()
    const visible = companies.filter(
      (company) => !term || company.name.toLowerCase().includes(term) || (company.trade ?? "").toLowerCase().includes(term),
    )
    const byName = (a: Company, b: Company) => a.name.localeCompare(b.name)
    const isMatch = (company: Company) => Boolean(trade) && (company.trade ?? "").trim().toLowerCase() === trade
    return {
      matches: visible.filter(isMatch).sort(byName),
      others: visible.filter((company) => !isMatch(company)).sort(byName),
      total: visible.length,
    }
  }, [companies, search, trade])
  const othersShown = others.slice(0, Math.max(0, VISIBLE_CAP - matches.length))

  function reset() {
    setSearch("")
    setSelected(new Set())
    setRemote([])
    setEmail("")
    setEmails([])
  }

  function addEmail() {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    if (!EMAIL.test(trimmed)) {
      toast.error("Enter a valid email")
      return
    }
    setEmails((current) => (current.includes(trimmed) ? current : [...current, trimmed]))
    setEmail("")
  }

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const count = selected.size + emails.length
  function submit() {
    if (count === 0) return
    startSaving(async () => {
      try {
        const result = unwrapAction(
          await bulkCreateBidInvitesAction(
            { ...context, bidPackageId: bidPackage.id },
            {
              bid_package_id: bidPackage.id,
              invites: [
                ...Array.from(selected).map((companyId) => ({ company_id: companyId })),
                ...emails.map((address) => ({ invite_email: address })),
              ],
              send_emails: !draft,
            },
          ),
        )
        await onAdded()
        if (result.failed.length) {
          toast.error(`${result.failed.length} could not be added`, {
            description: result.failed.map((entry) => entry.error).join(" · "),
          })
        } else {
          toast.success(draft ? `${result.created.length} lined up. They hear nothing until you send.` : `Sent to ${result.created.length}`)
        }
        reset()
        onOpenChange(false)
      } catch (error) {
        toast.error("Unable to add trades", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function row(company: Company) {
    const already = invitedCompanyIds.has(company.id)
    return (
      <label
        key={company.id}
        className={cn(
          "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50",
          already && "cursor-default opacity-50 hover:bg-transparent",
        )}
      >
        <Checkbox
          checked={already || selected.has(company.id)}
          disabled={already}
          onCheckedChange={(value) => toggle(company.id, value === true)}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{company.name}</span>
        {company.prequalified ? <span className="text-xs text-success">Prequalified</span> : null}
        <span className="w-28 truncate text-right text-xs text-muted-foreground">{already ? "On this package" : company.trade ?? ""}</span>
      </label>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) reset()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Add trades</DialogTitle>
          <DialogDescription>
            {draft
              ? "They're lined up on the board and hear nothing until you send the package."
              : "Each trade gets a private link by email as soon as you add them."}
          </DialogDescription>
        </DialogHeader>

        {priceBook ? (
          <ProductionBidVendorPicker
            packageId={bidPackage.id}
            value={remote}
            disabled={isSaving}
            excludedIds={[...invitedCompanyIds]}
            onChange={(items) => {
              setRemote(items)
              setSelected(new Set(items.map((item) => item.id)))
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Input autoFocus placeholder="Search your directory" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="min-h-0 flex-1 overflow-y-auto border">
              {total === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">No companies match. Invite them by email below.</p>
              ) : (
                <>
                  {matches.length ? (
                    <>
                      <p className="microlabel border-b bg-muted/40 px-3 py-1.5">{bidPackage.trade}</p>
                      <div className="divide-y">{matches.map(row)}</div>
                    </>
                  ) : null}
                  {othersShown.length ? (
                    <>
                      <p className="microlabel border-y bg-muted/40 px-3 py-1.5">{matches.length ? "Everyone else" : "Directory"}</p>
                      <div className="divide-y">{othersShown.map(row)}</div>
                    </>
                  ) : null}
                  {total > matches.length + othersShown.length ? (
                    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                      Showing {matches.length + othersShown.length} of {total}. Search to narrow.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="trade-email" className="text-xs">Not in your directory? Invite by email</Label>
          <div className="flex gap-2">
            <Input
              id="trade-email"
              type="email"
              value={email}
              placeholder="estimating@company.com"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addEmail()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addEmail}>Add</Button>
          </div>
          {emails.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {emails.map((address) => (
                <Button
                  key={address}
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2 text-xs"
                  aria-label={`Remove ${address}`}
                  onClick={() => setEmails((current) => current.filter((entry) => entry !== address))}
                >
                  {address} ×
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={isSaving || count === 0}>
            {isSaving ? "Adding…" : count === 0 ? "Add trades" : draft ? `Line up ${count}` : `Send to ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
