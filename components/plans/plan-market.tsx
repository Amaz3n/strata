"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { ExternalLink, Plus } from "@/components/icons"
import { setCommunityAvailabilityAction } from "@/app/(app)/plans/actions"
import { centsToDollars } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUS_META } from "@/lib/land/lot-lifecycle"
import { MARGIN_BAND_META, marginBand } from "@/lib/plans/margin"
import type { OfferingRow } from "@/lib/plans/offering"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { HousePlanDto } from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

/**
 * Where the plan sells and where it stands, one row per community. Offering and
 * footprint were two sections at opposite ends of the page asking the same
 * question — a sales manager wants the price and the margin, a land manager wants
 * the lots, and both of them mean "how is this plan doing at Cypress Landing".
 *
 * Price is deliberately read-only here. Repricing is the sales manager's weekly
 * edit and belongs to the community Offering tab; this surface only decides which
 * communities may sell the plan at all.
 */
export function PlanMarket({
  plan,
  rows,
  communities,
  canWrite,
}: {
  plan: HousePlanDto
  rows: OfferingRow[]
  communities: CommunityListItemDTO[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [publishing, setPublishing] = useState(false)
  const [publishTargets, setPublishTargets] = useState<string[]>([])
  const [launchPrice, setLaunchPrice] = useState("")

  const elevations = useMemo(() => (plan.elevations ?? []).filter((elevation) => elevation.is_active), [plan.elevations])
  const columns = useMemo(() => [null, ...elevations.map((elevation) => elevation.id)], [elevations])
  const publishedIds = useMemo(() => new Set(rows.filter((row) => row.offered).map((row) => row.communityId)), [rows])
  const unpublished = useMemo(
    () => communities.filter((community) => !publishedIds.has(community.id)),
    [communities, publishedIds],
  )

  function publish() {
    if (publishTargets.length === 0) return
    const cents = Math.round((Number(launchPrice) || 0) * 100)
    startTransition(async () => {
      try {
        unwrapAction(
          await setCommunityAvailabilityAction(
            plan.id,
            publishTargets.flatMap((communityId) =>
              columns.map((elevationId) => ({
                communityId,
                housePlanId: plan.id,
                elevationId,
                isAvailable: true,
                basePriceCents: cents,
                effectiveStart: null,
                effectiveEnd: null,
              })),
            ),
          ),
        )
        toast.success(
          `${plan.code} published to ${publishTargets.length} ${publishTargets.length === 1 ? "community" : "communities"}`,
        )
        setPublishing(false)
        setPublishTargets([])
        setLaunchPrice("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to publish plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function withdraw(communityId: string, communityName: string) {
    startTransition(async () => {
      try {
        unwrapAction(
          await setCommunityAvailabilityAction(
            plan.id,
            columns.map((elevationId) => ({
              communityId,
              housePlanId: plan.id,
              elevationId,
              isAvailable: false,
              basePriceCents: 0,
              effectiveStart: null,
              effectiveEnd: null,
            })),
          ),
        )
        toast.success(`${plan.code} withdrawn from ${communityName}`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to withdraw plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-4 pb-2 pt-3.5">
        <div>
          <h3 className="text-sm font-medium">Where it sells and where it stands</h3>
          <p className="text-[11px] text-muted-foreground">
            Publishing decides which communities may sell this plan and sets the launch price once. Repricing after that
            is the sales manager&apos;s edit on the community Offering tab.
          </p>
        </div>
        {canWrite && unpublished.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 rounded-none px-2 text-[11px]"
            onClick={() => setPublishing(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Publish to a community
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {communities.length === 0
            ? "No communities yet. Create one before publishing this plan."
            : "This plan is not offered anywhere and no lot carries it. Publish it to a community to put it on a price sheet."}
        </p>
      ) : (
        <div className="divide-y border-t">
          {rows.map((row) => {
            const band = marginBand(row.marginPct)
            const offered = row.cells.filter((cell) => cell.offered)
            return (
              <div
                key={row.communityId}
                className="grid gap-x-4 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(140px,1.1fr)_130px_120px_70px_minmax(140px,1fr)_auto]"
              >
                <div className="min-w-0">
                  <Link href={`/communities/${row.communityId}`} className="text-xs font-medium hover:underline">
                    {row.communityName}
                  </Link>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {offered.length > 0
                      ? `${offered.map((cell) => cell.code).join(", ")} offered`
                      : "not offered — lots only"}
                  </p>
                </div>

                <div className="text-xs tabular-nums">
                  {row.priceCents == null ? (
                    <span className="text-warning">{row.offered ? "no price" : "—"}</span>
                  ) : (
                    <>
                      {centsToDollars(row.priceCents)}
                      {row.priceMaxCents != null && row.priceMaxCents !== row.priceCents ? (
                        <span className="block text-[10px] text-muted-foreground">
                          to {centsToDollars(row.priceMaxCents)}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="text-xs tabular-nums text-muted-foreground">
                  {row.buildCents != null ? `${centsToDollars(row.buildCents)} build` : "no build cost"}
                  <span className="block text-[10px]">
                    {row.lotBasisCents != null ? `${centsToDollars(row.lotBasisCents)} lot` : "no lot basis"}
                  </span>
                </div>

                <div className={cn("text-xs font-medium tabular-nums", MARGIN_BAND_META[band].text)}>
                  {row.marginPct != null ? `${Math.round(row.marginPct)}%` : "—"}
                </div>

                <div className="min-w-0">
                  {row.lotTotal > 0 ? (
                    <>
                      <div className="flex h-1.5 w-full overflow-hidden border">
                        {row.lotCounts.map((entry) => (
                          <span
                            key={entry.status}
                            className={LOT_STATUS_META[entry.status]?.barClass ?? "bg-muted"}
                            style={{ width: `${(entry.count / row.lotTotal) * 100}%` }}
                            title={`${LOT_STATUS_META[entry.status]?.label ?? entry.status}: ${entry.count}`}
                          />
                        ))}
                      </div>
                      <p className="mt-1 flex flex-wrap gap-x-2.5 text-[10px] tabular-nums text-muted-foreground">
                        {row.lotCounts.map((entry) => (
                          <span key={entry.status}>
                            {LOT_STATUS_META[entry.status]?.label ?? entry.status} {entry.count}
                          </span>
                        ))}
                      </p>
                    </>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">No lots carry this plan here yet.</p>
                  )}
                </div>

                <div className="flex items-start justify-end gap-1">
                  <Button asChild variant="ghost" size="sm" className="h-7 rounded-none px-2 text-[11px]">
                    <Link href={`/communities/${row.communityId}/offering`}>
                      Reprice
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Link>
                  </Button>
                  {canWrite && row.offered ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-none px-2 text-[11px] text-muted-foreground hover:text-destructive"
                      disabled={pending}
                      onClick={() => withdraw(row.communityId, row.communityName)}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={publishing} onOpenChange={setPublishing}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish {plan.code} to a community</DialogTitle>
            <DialogDescription>
              Adds this plan and every active elevation to the community price sheet at a launch price. Later changes to
              that price happen on the Offering tab.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Communities</Label>
              <div className="max-h-52 space-y-1 overflow-y-auto border p-2">
                {unpublished.map((community) => (
                  <label key={community.id} className="flex items-center gap-2 p-1 text-xs">
                    <Checkbox
                      checked={publishTargets.includes(community.id)}
                      onCheckedChange={(checked) =>
                        setPublishTargets((current) =>
                          checked ? [...current, community.id] : current.filter((id) => id !== community.id),
                        )
                      }
                    />
                    {community.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="launch-price" className="text-xs">
                Launch base price
              </Label>
              <Input
                id="launch-price"
                inputMode="decimal"
                className="h-8 rounded-none text-xs tabular-nums"
                value={launchPrice}
                onChange={(event) => setLaunchPrice(event.target.value)}
                placeholder="425000"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setPublishing(false)}>
              Cancel
            </Button>
            <Button
              className="rounded-none"
              disabled={pending || publishTargets.length === 0 || !launchPrice.trim()}
              onClick={publish}
            >
              {pending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
