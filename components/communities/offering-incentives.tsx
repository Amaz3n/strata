"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { endIncentiveAction, upsertIncentiveAction } from "@/app/(app)/sales/actions"
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
import {
  EXPIRING_SOON_DAYS,
  daysRemaining,
  isIncentiveLive,
  isIncentiveScheduled,
  type OfferingIncentive,
} from "@/lib/sales/offering"
import { cn } from "@/lib/utils"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/** Dates a builder says out loud, not the ISO strings the table used to print. */
function readableDate(value: string | null) {
  if (!value) return null
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

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
  /** Carried through the edit so the dialog can state what it will touch. */
  isOrgWide?: boolean
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
  return incentive.percent != null ? `${incentive.percent}% of base` : "—"
}

/** Live now, starting later, or on its way out — the only three states that change a decision. */
function windowState(incentive: OfferingIncentive, asOfDate: string) {
  if (isIncentiveScheduled(incentive, asOfDate)) {
    return { label: `Starts ${readableDate(incentive.effectiveStart)}`, tone: "text-muted-foreground" }
  }
  if (!isIncentiveLive(incentive, asOfDate)) return { label: "Ended", tone: "text-muted-foreground" }
  const remaining = daysRemaining(incentive, asOfDate)
  if (remaining == null) return { label: "Open-ended", tone: "text-muted-foreground" }
  if (remaining <= EXPIRING_SOON_DAYS) {
    return { label: remaining <= 0 ? "Ends today" : `Ends in ${remaining}d`, tone: "text-warning" }
  }
  return { label: `Through ${readableDate(incentive.effectiveEnd)}`, tone: "text-muted-foreground" }
}

/**
 * What this community is giving away to move inventory, sitting directly under
 * the prices it moves. These used to be a table of their own at the bottom of
 * the page — readable, but disconnected from the only number they change.
 */
export function OfferingIncentives({
  communityId,
  incentives,
  asOfDate,
  averageGiveCents,
  givePercent,
  canManage,
}: {
  communityId: string
  incentives: OfferingIncentive[]
  asOfDate: string
  /** Dollars the live price incentives take off the average plan on the sheet. */
  averageGiveCents: number
  givePercent: number | null
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [draft, setDraft] = useState<IncentiveDraft | null>(null)

  const liveCount = incentives.filter((incentive) => isIncentiveLive(incentive, asOfDate)).length

  function save() {
    if (!draft || !draft.name.trim()) return
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertIncentiveAction({
            id: draft.id,
            // An org-wide incentive stays org-wide when it is edited here.
            communityId: draft.isOrgWide ? null : communityId,
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
    <section className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="microlabel">Incentives</h2>
          <p className="text-[11px] text-muted-foreground">
            {liveCount === 0
              ? "nothing is coming off the price today"
              : `${liveCount} live · ${money.format(averageGiveCents / 100)} off the average plan${
                  givePercent != null ? ` · ${givePercent.toFixed(1)}% of base` : ""
                }`}
          </p>
        </div>
        {canManage ? (
          <Button size="sm" className="h-7 rounded-none text-xs" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <Plus className="mr-1 size-3.5" />
            New incentive
          </Button>
        ) : null}
      </div>

      {incentives.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          No incentives. Every price on the sheet is what a buyer pays.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="microlabel hover:bg-transparent">
                <TableHead>Incentive</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Comes off</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>From</TableHead>
                {canManage ? <TableHead className="w-24" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {incentives.map((incentive) => {
                const live = isIncentiveLive(incentive, asOfDate)
                const state = windowState(incentive, asOfDate)
                return (
                  <TableRow key={incentive.id} className={cn("text-xs", !live && "text-muted-foreground")}>
                    <TableCell className="font-medium">{incentive.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{incentiveValue(incentive)}</TableCell>
                    <TableCell className={incentive.appliesTo === "price" ? "" : "text-muted-foreground"}>
                      {incentive.appliesTo === "price" ? "The price" : "Design selections"}
                    </TableCell>
                    <TableCell className={cn("tabular-nums", state.tone)}>{state.label}</TableCell>
                    <TableCell>
                      {incentive.isOrgWide ? (
                        <Badge variant="secondary" className="rounded-none text-[10px]">
                          Every community
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">This community</span>
                      )}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        {/* An org-wide incentive used to dead-end on the word
                            "Org-wide" — it was readable here and editable
                            nowhere. It is edited here, with the blast radius
                            stated in the dialog. */}
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
                                isOrgWide: incentive.isOrgWide,
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
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setDraft(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit incentive" : "New incentive"}</DialogTitle>
            <DialogDescription>
              {draft?.isOrgWide
                ? "This incentive runs in every community. Editing it here changes it everywhere."
                : "Applies to this community only. An incentive that should run everywhere is created on each community it applies to."}
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="incentive-name" className="microlabel">Name</Label>
                <Input
                  id="incentive-name"
                  autoFocus
                  className="h-8 rounded-none text-xs"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Spring closing credit"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="microlabel">Type</Label>
                  <Select
                    value={draft.incentiveType}
                    onValueChange={(value) => setDraft({ ...draft, incentiveType: value as IncentiveDraft["incentiveType"] })}
                  >
                    <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed_amount">Fixed amount</SelectItem>
                      <SelectItem value="percent_of_base">Percent of base</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.incentiveType === "fixed_amount" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="incentive-amount" className="microlabel">Amount</Label>
                    <Input
                      id="incentive-amount"
                      inputMode="decimal"
                      className="h-8 rounded-none text-xs tabular-nums"
                      value={draft.amount}
                      onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                      placeholder="10000"
                    />
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="incentive-percent" className="microlabel">Percent</Label>
                    <Input
                      id="incentive-percent"
                      inputMode="decimal"
                      className="h-8 rounded-none text-xs tabular-nums"
                      value={draft.percent}
                      onChange={(event) => setDraft({ ...draft, percent: event.target.value })}
                      placeholder="3"
                    />
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label className="microlabel">Comes off</Label>
                <Select
                  value={draft.appliesTo}
                  onValueChange={(value) => setDraft({ ...draft, appliesTo: value as IncentiveDraft["appliesTo"] })}
                >
                  <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="price">The price</SelectItem>
                    <SelectItem value="design_credit">Design selections</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {draft.appliesTo === "price"
                    ? "Lowers what the buyer pays, so it moves the net price on the sheet."
                    : "Spending money at the design studio. The price on the sheet does not move."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="incentive-start" className="microlabel">Starts</Label>
                  <Input
                    id="incentive-start"
                    type="date"
                    className="h-8 rounded-none text-xs"
                    value={draft.effectiveStart}
                    onChange={(event) => setDraft({ ...draft, effectiveStart: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="incentive-end" className="microlabel">Ends</Label>
                  <Input
                    id="incentive-end"
                    type="date"
                    className="h-8 rounded-none text-xs"
                    value={draft.effectiveEnd}
                    onChange={(event) => setDraft({ ...draft, effectiveEnd: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="incentive-notes" className="microlabel">Notes</Label>
                <Textarea
                  id="incentive-notes"
                  rows={2}
                  className="rounded-none text-xs"
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button className="rounded-none" disabled={!draft?.name.trim() || isPending} onClick={save}>
              {isPending ? "Saving…" : "Save incentive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
