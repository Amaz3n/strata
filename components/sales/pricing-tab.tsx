"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Loader2, Plus } from "@/components/icons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { setCommunityAvailabilityAction } from "@/app/(app)/plans/actions"
import { endIncentiveAction, upsertIncentiveAction } from "@/app/(app)/sales/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"

import { formatDay, money } from "./sales-format"

interface PriceSheetRow {
  planId: string
  planName: string | null
  planCode: string | null
  elevationId: string | null
  elevationName: string
  basePriceCents: number
  fromPriceCents: number
  beds: number | null
  baths: number | null
  sqft: number | null
}
interface PriceSheet {
  asOfDate: string
  minPremiumCents: number
  maxPremiumCents: number
  rows: PriceSheetRow[]
}
export interface PricingIncentive {
  id: string
  name: string
  communityId: string | null
  incentiveType: string
  amountCents: number | null
  percent: number | null
  appliesTo: string
  status: string
  effectiveStart: string | null
  effectiveEnd: string | null
  maxUses: number | null
  requiresApproval: boolean
}

export function PricingTab({
  communityId,
  communities,
  priceSheet,
  incentives,
  canManage,
}: {
  communityId: string | null
  communities: { id: string; name: string }[]
  priceSheet: PriceSheet | null
  incentives: PricingIncentive[]
  canManage: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState<PricingIncentive | null>(null)
  const [creating, setCreating] = useState(false)
  const [ending, setEnding] = useState<PricingIncentive | null>(null)
  const [pending, startTransition] = useTransition()

  const endIncentive = () => {
    if (!ending) return
    startTransition(async () => {
      try {
        unwrapAction(await endIncentiveAction(ending.id))
        toast.success(`Ended “${ending.name}”`)
        setEnding(null)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not end incentive")
      }
    })
  }

  return (
    <div className="space-y-8">
      {/* Price sheet */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Price sheet</h2>
            {priceSheet ? (
              <p className="text-xs text-muted-foreground">
                As of {priceSheet.asOfDate}
                {priceSheet.maxPremiumCents > 0 ? ` · lot premiums ${money.format(priceSheet.minPremiumCents / 100)}–${money.format(priceSheet.maxPremiumCents / 100)}` : ""}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Choose a community to edit its base prices.</p>
            )}
          </div>
        </div>
        {!communityId ? (
          <div className="border p-8 text-center text-xs text-muted-foreground">Select a community above to load its price sheet.</div>
        ) : !priceSheet || priceSheet.rows.length === 0 ? (
          <div className="border p-8 text-center text-xs text-muted-foreground">
            No plans are offered here yet. <Link className="font-medium text-primary underline underline-offset-2" href="/plans">Make a plan available</Link> to set its price.
          </div>
        ) : (
          <div className="overflow-x-auto border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Elevation</th>
                  <th className="px-3 py-2 text-right font-medium">Bd / Ba / Sqft</th>
                  <th className="px-3 py-2 text-right font-medium">Base price</th>
                  <th className="px-4 py-2 text-right font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {priceSheet.rows.map((row) => (
                  <PriceRow key={`${row.planId}-${row.elevationId ?? "base"}`} communityId={communityId} row={row} canManage={canManage} onSaved={() => router.refresh()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Incentives */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Incentives</h2>
            <p className="text-xs text-muted-foreground">{communityId ? "Applies to this community and org-wide offers." : "Org-wide offers. Select a community to add a community-specific incentive."}</p>
          </div>
          {canManage ? (
            <Button size="sm" className="h-8 rounded-none" onClick={() => setCreating(true)}><Plus className="mr-1 size-3.5" /> New incentive</Button>
          ) : null}
        </div>
        {incentives.length === 0 ? (
          <div className="border p-8 text-center text-xs text-muted-foreground">No incentives yet. Create one to apply it on quotes and agreements.</div>
        ) : (
          <div className="overflow-x-auto border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Applies to</th>
                  <th className="px-3 py-2 font-medium">Window</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {incentives.map((incentive) => {
                  const endsSoon = incentive.status === "active" && incentive.effectiveEnd && Date.parse(incentive.effectiveEnd) - Date.now() < 7 * 86_400_000
                  return (
                    <tr key={incentive.id} className="border-t">
                      <td className="px-4 py-2.5 font-medium">{incentive.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{incentive.communityId ? "This community" : "Org-wide"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{incentive.incentiveType === "percent_of_base" ? "% of base" : "Fixed"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{incentive.incentiveType === "percent_of_base" ? `${incentive.percent ?? 0}%` : money.format((incentive.amountCents ?? 0) / 100)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{incentive.appliesTo === "design_credit" ? "Design credit" : "Price"}</td>
                      <td className={cn("px-3 py-2.5 tabular-nums", endsSoon ? "text-[var(--age-1)]" : "text-muted-foreground")}>
                        {incentive.effectiveStart || incentive.effectiveEnd ? `${incentive.effectiveStart ? formatDay(incentive.effectiveStart) : "—"} → ${incentive.effectiveEnd ? formatDay(incentive.effectiveEnd) : "—"}` : "Open"}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline" className={cn("rounded-none text-[10px] uppercase", incentive.status === "active" ? "border-success/40 bg-success/12 text-success" : "border-border bg-muted text-muted-foreground")}>{incentive.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canManage ? (
                          <div className="flex items-center justify-end gap-2">
                            <button type="button" className="text-primary hover:underline" onClick={() => setEditing(incentive)}>Edit</button>
                            {incentive.status === "active" ? <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => setEnding(incentive)}>End</button> : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(creating || editing) && canManage ? (
        <IncentiveDialog
          incentive={editing}
          communityId={communityId}
          communities={communities}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={() => {
            setCreating(false)
            setEditing(null)
            router.refresh()
          }}
        />
      ) : null}

      <AlertDialog open={Boolean(ending)} onOpenChange={(open) => !open && setEnding(null)}>
        <AlertDialogContent className="rounded-none">
          <AlertDialogHeader>
            <AlertDialogTitle>End “{ending?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>It stops applying to new quotes and agreements. Agreements already written keep it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-none">Cancel</AlertDialogCancel>
            <AlertDialogAction className="rounded-none" disabled={pending} onClick={endIncentive}>End incentive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PriceRow({ communityId, row, canManage, onSaved }: { communityId: string; row: PriceSheetRow; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(Math.round(row.basePriceCents / 100)))
  const [pending, startTransition] = useTransition()

  const save = () => {
    const cents = Math.round(Number(value) * 100)
    if (!Number.isFinite(cents) || cents < 0) return
    startTransition(async () => {
      try {
        unwrapAction(
          await setCommunityAvailabilityAction(row.planId, [
            { communityId, housePlanId: row.planId, elevationId: row.elevationId, basePriceCents: cents, isAvailable: true },
          ]),
        )
        toast.success(`${row.planName} base price set to ${money.format(cents / 100)}`)
        setEditing(false)
        onSaved()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save price")
      }
    })
  }

  return (
    <tr className="border-t">
      <td className="px-4 py-2.5 font-medium">{row.planName ?? "—"}{row.planCode ? <span className="ml-1 text-muted-foreground">{row.planCode}</span> : null}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.elevationName}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{row.beds ?? "—"} / {row.baths ?? "—"} / {row.sqft?.toLocaleString() ?? "—"}</td>
      <td className="px-3 py-2.5 text-right">
        {editing ? (
          <span className="inline-flex items-center gap-1">
            <Input
              autoFocus
              value={value}
              inputMode="decimal"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") save()
                if (event.key === "Escape") setEditing(false)
              }}
              className="h-7 w-28 rounded-none text-right text-xs"
            />
            <Button size="sm" variant="ghost" className="h-7 rounded-none px-2" disabled={pending} onClick={save}>{pending ? <Loader2 className="size-3 animate-spin" /> : "Save"}</Button>
          </span>
        ) : (
          <button type="button" disabled={!canManage} onClick={() => setEditing(true)} className={cn("font-mono tabular-nums", canManage && "hover:underline")}>{money.format(row.basePriceCents / 100)}</button>
        )}
      </td>
      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{money.format(row.fromPriceCents / 100)}</td>
    </tr>
  )
}

function IncentiveDialog({
  incentive,
  communityId,
  communities,
  onClose,
  onSaved,
}: {
  incentive: PricingIncentive | null
  communityId: string | null
  communities: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(incentive?.name ?? "")
  const [scope, setScope] = useState(incentive?.communityId ?? communityId ?? "org")
  const [type, setType] = useState<"fixed_amount" | "percent_of_base">((incentive?.incentiveType as "fixed_amount" | "percent_of_base") ?? "fixed_amount")
  const [amount, setAmount] = useState(incentive?.amountCents != null ? String(incentive.amountCents / 100) : "")
  const [percent, setPercent] = useState(incentive?.percent != null ? String(incentive.percent) : "")
  const [appliesTo, setAppliesTo] = useState<"price" | "design_credit">((incentive?.appliesTo as "price" | "design_credit") ?? "price")
  const [start, setStart] = useState(incentive?.effectiveStart ?? "")
  const [end, setEnd] = useState(incentive?.effectiveEnd ?? "")
  const [maxUses, setMaxUses] = useState(incentive?.maxUses != null ? String(incentive.maxUses) : "")
  const [requiresApproval, setRequiresApproval] = useState(incentive?.requiresApproval ?? false)
  const [notes, setNotes] = useState("")
  const [pending, startTransition] = useTransition()

  const save = () => {
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertIncentiveAction({
            id: incentive?.id,
            communityId: scope === "org" ? null : scope,
            name: name.trim(),
            incentiveType: type,
            amountCents: type === "fixed_amount" ? Math.round(Number(amount) * 100) : null,
            percent: type === "percent_of_base" ? Number(percent) : null,
            appliesTo,
            status: incentive?.status === "ended" ? "ended" : "active",
            effectiveStart: start || null,
            effectiveEnd: end || null,
            maxUses: maxUses ? Number(maxUses) : null,
            requiresApproval,
            notes: notes.trim() || null,
          }),
        )
        toast.success(incentive ? "Incentive updated" : "Incentive created")
        onSaved()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save incentive")
      }
    })
  }

  const valid = name.trim().length > 0 && (type === "fixed_amount" ? amount !== "" : percent !== "")

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader><DialogTitle>{incentive ? "Edit incentive" : "New incentive"}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label className="text-xs">Name</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Summer $10k" className="rounded-none" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="org">Org-wide</SelectItem>
                  {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={type} onValueChange={(value) => setType(value as "fixed_amount" | "percent_of_base")}>
                <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="fixed_amount">Fixed amount</SelectItem><SelectItem value="percent_of_base">% of base</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {type === "fixed_amount" ? (
              <div className="grid gap-1.5"><Label className="text-xs">Amount</Label><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="10000" className="rounded-none" /></div>
            ) : (
              <div className="grid gap-1.5"><Label className="text-xs">Percent</Label><Input inputMode="decimal" value={percent} onChange={(event) => setPercent(event.target.value)} placeholder="3" className="rounded-none" /></div>
            )}
            <div className="grid gap-1.5">
              <Label className="text-xs">Applies to</Label>
              <Select value={appliesTo} onValueChange={(value) => setAppliesTo(value as "price" | "design_credit")}>
                <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="price">Price</SelectItem><SelectItem value="design_credit">Design credit</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label className="text-xs">Effective start</Label><Input type="date" value={start} onChange={(event) => setStart(event.target.value)} className="rounded-none" /></div>
            <div className="grid gap-1.5"><Label className="text-xs">Effective end</Label><Input type="date" value={end} onChange={(event) => setEnd(event.target.value)} className="rounded-none" /></div>
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="grid gap-1.5"><Label className="text-xs">Max uses</Label><Input inputMode="numeric" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} placeholder="Unlimited" className="rounded-none" /></div>
            <label className="flex h-9 items-center gap-2 text-xs"><Switch checked={requiresApproval} onCheckedChange={setRequiresApproval} /> Requires approval</label>
          </div>
          <div className="grid gap-1.5"><Label className="text-xs">Notes</Label><Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} className="rounded-none" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button className="rounded-none" disabled={!valid || pending} onClick={save}>{pending ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{incentive ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
