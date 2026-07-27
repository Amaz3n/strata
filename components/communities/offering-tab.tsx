"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { endIncentiveAction, setCommunityPlanPriceAction, upsertIncentiveAction } from "@/app/(app)/sales/actions"
import { Plus } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"

export interface OfferingPlanRow {
  key: string
  availabilityId: string
  planId: string
  planCode: string | null
  planName: string
  elevationName: string
  beds: number | null
  baths: number | null
  sqft: number | null
  basePriceCents: number
  fromPriceCents: number
}

export interface OfferingIncentive {
  id: string
  name: string
  incentiveType: "fixed_amount" | "percent_of_base"
  amountCents: number | null
  percent: number | null
  appliesTo: "price" | "design_credit"
  status: string
  effectiveStart: string | null
  effectiveEnd: string | null
  isOrgWide: boolean
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

type IncentiveDraft = {
  id?: string
  name: string
  incentiveType: "fixed_amount" | "percent_of_base"
  amount: string
  percent: string
  appliesTo: "price" | "design_credit"
  effectiveStart: string
  effectiveEnd: string
  notes: string
}

const EMPTY_DRAFT: IncentiveDraft = {
  name: "",
  incentiveType: "fixed_amount",
  amount: "",
  percent: "",
  appliesTo: "price",
  effectiveStart: "",
  effectiveEnd: "",
  notes: "",
}

function incentiveValue(incentive: OfferingIncentive) {
  if (incentive.incentiveType === "fixed_amount") {
    return incentive.amountCents != null ? money.format(incentive.amountCents / 100) : "—"
  }
  return incentive.percent != null ? `${incentive.percent}%` : "—"
}

/**
 * What this community sells and for how much. Plans and elevations are the org
 * library; the price, the premiums, and the incentives are set here — this is
 * the sales manager's weekly edit, and its only home.
 */
export function OfferingTab({
  communityId,
  rows,
  incentives,
  premiumRange,
  asOfDate,
  canManage,
}: {
  communityId: string
  rows: OfferingPlanRow[]
  incentives: OfferingIncentive[]
  premiumRange: { minCents: number; maxCents: number }
  asOfDate: string
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [draft, setDraft] = useState<IncentiveDraft | null>(null)
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({})

  function commitPrice(row: OfferingPlanRow) {
    const raw = priceEdits[row.availabilityId]
    if (raw === undefined) return
    const cents = Math.round((Number(raw) || 0) * 100)
    setPriceEdits((current) => {
      const next = { ...current }
      delete next[row.availabilityId]
      return next
    })
    if (cents === row.basePriceCents) return
    startTransition(async () => {
      try {
        unwrapAction(
          await setCommunityPlanPriceAction(communityId, {
            availabilityId: row.availabilityId,
            communityId,
            basePriceCents: cents,
          }),
        )
        toast.success(`${row.planName} repriced to ${money.format(cents / 100)}`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to reprice", { description: (error as Error).message })
      }
    })
  }

  function save() {
    if (!draft || !draft.name.trim()) return
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertIncentiveAction({
            id: draft.id,
            communityId,
            name: draft.name.trim(),
            incentiveType: draft.incentiveType,
            amountCents: draft.incentiveType === "fixed_amount" ? Math.round(Number(draft.amount || 0) * 100) : null,
            percent: draft.incentiveType === "percent_of_base" ? Number(draft.percent || 0) : null,
            appliesTo: draft.appliesTo,
            status: "active",
            effectiveStart: draft.effectiveStart || null,
            effectiveEnd: draft.effectiveEnd || null,
            requiresApproval: false,
            notes: draft.notes.trim() || null,
          }),
        )
        toast.success(draft.id ? "Incentive updated" : "Incentive added")
        setDraft(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save incentive", { description: (error as Error).message })
      }
    })
  }

  function end(incentive: OfferingIncentive) {
    startTransition(async () => {
      try {
        unwrapAction(await endIncentiveAction(incentive.id))
        toast.success(`${incentive.name} ended`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to end incentive", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-8 p-4">
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Price sheet</h2>
            <p className="text-xs text-muted-foreground">
              Plans released to this community, as of {asOfDate}
              {premiumRange.maxCents > 0
                ? ` · lot premiums ${money.format(premiumRange.minCents / 100)}–${money.format(premiumRange.maxCents / 100)}`
                : ""}
            </p>
            {canManage ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Base price is edited here. Which plans are offered in this community is decided in the plan library.
              </p>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm" className="rounded-none">
            <Link href="/plans">Manage plan library</Link>
          </Button>
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Plan</TableHead>
                <TableHead>Elevation</TableHead>
                <TableHead>Beds / baths</TableHead>
                <TableHead className="text-right">Sq ft</TableHead>
                <TableHead className="text-right">Base price</TableHead>
                <TableHead className="text-right">From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-xs text-muted-foreground">
                    No plans are released for this community yet. Publish plan availability in the plan library to
                    generate a price sheet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.key} className="text-xs">
                    <TableCell className="font-medium">
                      <Link className="hover:underline" href={`/plans/${row.planId}`}>
                        {row.planCode ? `${row.planCode} · ` : ""}
                        {row.planName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.elevationName}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {row.beds ?? "—"} / {row.baths ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.sqft?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {canManage ? (
                        <Input
                          inputMode="decimal"
                          aria-label={`Base price for ${row.planName} ${row.elevationName}`}
                          className="ml-auto h-8 w-32 rounded-none text-right text-xs tabular-nums"
                          disabled={isPending}
                          value={priceEdits[row.availabilityId] ?? (row.basePriceCents / 100).toFixed(2)}
                          onChange={(event) =>
                            setPriceEdits((current) => ({ ...current, [row.availabilityId]: event.target.value }))
                          }
                          onBlur={() => commitPrice(row)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur()
                          }}
                        />
                      ) : (
                        money.format(row.basePriceCents / 100)
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money.format(row.fromPriceCents / 100)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Incentives</h2>
            <p className="text-xs text-muted-foreground">What this community is currently giving away to move inventory.</p>
          </div>
          {canManage ? (
            <Button size="sm" className="rounded-none" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="mr-1.5 h-4 w-4" />
              New incentive
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Incentive</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Applies to</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Status</TableHead>
                {canManage ? <TableHead className="w-24" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {incentives.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 6 : 5} className="py-10 text-center text-xs text-muted-foreground">
                    No active incentives.
                  </TableCell>
                </TableRow>
              ) : (
                incentives.map((incentive) => (
                  <TableRow key={incentive.id} className="text-xs">
                    <TableCell className="font-medium">
                      {incentive.name}
                      {incentive.isOrgWide ? (
                        <Badge variant="secondary" className="ml-2 rounded-none text-[10px]">
                          All communities
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{incentiveValue(incentive)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {incentive.appliesTo === "price" ? "Price" : "Design credit"}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {incentive.effectiveStart ?? "—"} → {incentive.effectiveEnd ?? "open"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-none text-[10px] uppercase tracking-wide">
                        {incentive.status}
                      </Badge>
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        {incentive.isOrgWide ? (
                          <span className="text-[11px] text-muted-foreground">Org-wide</span>
                        ) : (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 rounded-none px-2 text-[11px]"
                              onClick={() =>
                                setDraft({
                                  id: incentive.id,
                                  name: incentive.name,
                                  incentiveType: incentive.incentiveType,
                                  amount: incentive.amountCents != null ? String(incentive.amountCents / 100) : "",
                                  percent: incentive.percent != null ? String(incentive.percent) : "",
                                  appliesTo: incentive.appliesTo,
                                  effectiveStart: incentive.effectiveStart ?? "",
                                  effectiveEnd: incentive.effectiveEnd ?? "",
                                  notes: "",
                                })
                              }
                            >
                              Edit
                            </Button>
                            {incentive.status !== "ended" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 rounded-none px-2 text-[11px]"
                                disabled={isPending}
                                onClick={() => end(incentive)}
                              >
                                End
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setDraft(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit incentive" : "New incentive"}</DialogTitle>
            <DialogDescription>Applies to this community only. Org-wide incentives are managed on the Sales desk.</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="incentive-name">Name</Label>
                <Input
                  id="incentive-name"
                  autoFocus
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Spring closing credit"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Type</Label>
                  <Select
                    value={draft.incentiveType}
                    onValueChange={(value) => setDraft({ ...draft, incentiveType: value as IncentiveDraft["incentiveType"] })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed_amount">Fixed amount</SelectItem>
                      <SelectItem value="percent_of_base">Percent of base</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.incentiveType === "fixed_amount" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="incentive-amount">Amount</Label>
                    <Input
                      id="incentive-amount"
                      inputMode="decimal"
                      value={draft.amount}
                      onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                      placeholder="10000"
                    />
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="incentive-percent">Percent</Label>
                    <Input
                      id="incentive-percent"
                      inputMode="decimal"
                      value={draft.percent}
                      onChange={(event) => setDraft({ ...draft, percent: event.target.value })}
                      placeholder="3"
                    />
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label>Applies to</Label>
                <Select
                  value={draft.appliesTo}
                  onValueChange={(value) => setDraft({ ...draft, appliesTo: value as IncentiveDraft["appliesTo"] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="price">Price</SelectItem>
                    <SelectItem value="design_credit">Design credit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="incentive-start">Starts</Label>
                  <Input
                    id="incentive-start"
                    type="date"
                    value={draft.effectiveStart}
                    onChange={(event) => setDraft({ ...draft, effectiveStart: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="incentive-end">Ends</Label>
                  <Input
                    id="incentive-end"
                    type="date"
                    value={draft.effectiveEnd}
                    onChange={(event) => setDraft({ ...draft, effectiveEnd: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="incentive-notes">Notes</Label>
                <Textarea
                  id="incentive-notes"
                  rows={2}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={!draft?.name.trim() || isPending} onClick={save}>
              {isPending ? "Saving…" : "Save incentive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
