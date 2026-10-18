"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidInvite, BidPackage, BidScopeItem } from "@/lib/services/bids"
import type { BidVendorChoice } from "@/lib/services/production-bid-vendors"
import type { Company } from "@/lib/types"
import type { BidSubmissionItemResponse } from "@/lib/validation/bids"
import { createManualBidSubmissionAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { ProductionBidVendorPicker } from "@/components/bids/production-bid-vendor-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Plus } from "@/components/icons"
import { parseCurrencyToCents, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

/** Records a bid that arrived outside the portal — by email, phone or paper. */
interface ManualRow {
  key: string
  scopeId: string | null
  description: string
  response: BidSubmissionItemResponse
  amount: string
}

let manualSeq = 0
function newManualRow(): ManualRow {
  manualSeq += 1
  return { key: `m-${manualSeq}`, scopeId: null, description: "", response: "priced", amount: "" }
}

export function ManualBidDialog({
  open,
  onOpenChange,
  context,
  bidPackage,
  invites,
  companies,
  scopeItems,
  locked,
  initialInviteId = null,
  onEntered,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext & { bidPackageId?: string | null }
  bidPackage: BidPackage
  invites: BidInvite[]
  companies: Company[]
  scopeItems: BidScopeItem[]
  locked: boolean
  /** Preselects the trade when entering a price from its column. Remount (key) to change it. */
  initialInviteId?: string | null
  onEntered: () => Promise<void>
}) {
  const hasScope = scopeItems.length > 0
  const [remoteVendor, setRemoteVendor] = useState<BidVendorChoice[]>([])
  const [target, setTarget] = useState(initialInviteId ? `invite:${initialInviteId}` : "")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [exclusions, setExclusions] = useState("")
  const [notes, setNotes] = useState("")
  const [scopeRows, setScopeRows] = useState<Record<string, { response: BidSubmissionItemResponse; amount: string }>>({})
  const [freeRows, setFreeRows] = useState<ManualRow[]>([newManualRow()])
  const [isSaving, startSaving] = useTransition()

  const targetOptions = useMemo(() => {
    const invited = invites.map((invite) => ({
      value: `invite:${invite.id}`,
      label: invite.company?.name ?? invite.invite_email ?? "Vendor",
    }))
    const others = companies
      .filter((company) => !invites.some((invite) => invite.company_id === company.id))
      .map((company) => ({ value: `company:${company.id}`, label: company.name }))
    return [...invited, ...others]
  }, [invites, companies])

  function reset() {
    setRemoteVendor([])
    setTarget("")
    setName("")
    setEmail("")
    setExclusions("")
    setNotes("")
    setScopeRows({})
    setFreeRows([newManualRow()])
  }

  function buildItems() {
    if (hasScope) {
      return scopeItems.map((scope) => {
        const row = scopeRows[scope.id] ?? { response: "priced" as BidSubmissionItemResponse, amount: "" }
        return {
          bid_scope_item_id: scope.id,
          description: scope.description,
          response: row.response,
          amount_cents: row.response === "priced" && row.amount.trim() ? parseCurrencyToCents(row.amount) : null,
        }
      })
    }
    return freeRows
      .filter((row) => row.description.trim())
      .map((row) => ({
        description: row.description.trim(),
        response: "priced" as BidSubmissionItemResponse,
        amount_cents: row.amount.trim() ? parseCurrencyToCents(row.amount) : null,
      }))
  }

  function handleSubmit() {
    if (!target) {
      toast.error("Select a vendor")
      return
    }
    const items = buildItems()
    const total = items
      .filter((item) => item.response === "priced")
      .reduce((sum, item) => sum + (item.amount_cents ?? 0), 0)
    if (total <= 0) {
      toast.error("Enter at least one priced amount")
      return
    }
    const [kind, id] = target.split(":")
    startSaving(async () => {
      try {
        unwrapAction(
          await createManualBidSubmissionAction(context, {
            bid_package_id: bidPackage.id,
            bid_invite_id: kind === "invite" ? id : null,
            company_id: kind === "company" ? id : null,
            total_cents: total,
            currency: "usd",
            submitted_by_name: name.trim() || null,
            submitted_by_email: email.trim() || null,
            exclusions: exclusions.trim() || null,
            notes: notes.trim() || null,
            items,
          }),
        )
        await onEntered()
        toast.success("Bid entered")
        reset()
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to enter bid", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) reset()
      }}
    >
      <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enter a bid</DialogTitle>
          <DialogDescription>Record a bid received outside the portal.</DialogDescription>
        </DialogHeader>
        {locked ? (
          <p className="text-sm text-muted-foreground">This package is awarded — bids can no longer be entered.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Vendor</Label>
                <Select value={target.startsWith("company:") && remoteVendor.length ? "" : target} onValueChange={(value) => { setRemoteVendor([]); setTarget(value) }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Submitted by</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
              </div>
            </div>

            {bidPackage.award_target === "price_agreement" && <div className="space-y-1.5">
              <Label className="text-xs">Or find another vendor</Label>
              <ProductionBidVendorPicker packageId={bidPackage.id} value={remoteVendor} single disabled={isSaving}
                excludedIds={invites.flatMap((invite) => invite.company_id ? [invite.company_id] : [])}
                onChange={(items) => { setRemoteVendor(items); setTarget(items[0] ? `company:${items[0].id}` : "") }} />
            </div>}

            {hasScope ? (
              <div className="overflow-hidden border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-2 py-1.5">Scope</TableHead>
                      <TableHead className="w-32 px-2 py-1.5">Response</TableHead>
                      <TableHead className="w-28 px-2 py-1.5 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scopeItems.map((scope) => {
                      const row = scopeRows[scope.id] ?? { response: "priced" as BidSubmissionItemResponse, amount: "" }
                      return (
                        <TableRow key={scope.id}>
                          <TableCell className="px-2 py-1.5">{scope.description}</TableCell>
                          <TableCell className="px-2 py-1.5">
                            <Select
                              value={row.response}
                              onValueChange={(value) =>
                                setScopeRows((prev) => ({
                                  ...prev,
                                  [scope.id]: { ...row, response: value as BidSubmissionItemResponse },
                                }))
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="priced">Priced</SelectItem>
                                <SelectItem value="excluded">Excluded</SelectItem>
                                <SelectItem value="no_bid">No bid</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="px-2 py-1.5">
                            <Input
                              className="h-8 text-right tabular-nums"
                              value={row.amount}
                              inputMode="decimal"
                              disabled={row.response !== "priced"}
                              onChange={(event) =>
                                setScopeRows((prev) => ({
                                  ...prev,
                                  [scope.id]: { ...row, amount: event.target.value },
                                }))
                              }
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="space-y-2">
                {freeRows.map((row) => (
                  <div key={row.key} className="flex gap-2">
                    <Input
                      className="flex-1"
                      value={row.description}
                      placeholder="Line description"
                      onChange={(event) =>
                        setFreeRows((prev) =>
                          prev.map((entry) => (entry.key === row.key ? { ...entry, description: event.target.value } : entry)),
                        )
                      }
                    />
                    <Input
                      className="w-32 text-right tabular-nums"
                      value={row.amount}
                      inputMode="decimal"
                      placeholder="$0"
                      onChange={(event) =>
                        setFreeRows((prev) =>
                          prev.map((entry) => (entry.key === row.key ? { ...entry, amount: event.target.value } : entry)),
                        )
                      }
                    />
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setFreeRows((prev) => [...prev, newManualRow()])}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add line
                </Button>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input value={email} type="email" onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Exclusions</Label>
              <Textarea value={exclusions} rows={2} onChange={(event) => setExclusions(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving || locked}>
            {isSaving ? "Saving…" : "Enter bid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
