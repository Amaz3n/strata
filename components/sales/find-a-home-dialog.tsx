"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"

import { listSellableHomesAction } from "@/app/(app)/sales/actions"
import { ArrowLeft, Home, Search, X } from "@/components/icons"
import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation"
import { LotHoldForm, type HoldBuyer, type HoldLot } from "@/components/sales/lot-hold-form"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import { AGING_SPEC_DAYS, type SellableHome } from "@/lib/sales/inventory"
import { cn } from "@/lib/utils"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

const AVAILABILITY = [
  { value: "all", label: "Everything" },
  { value: "spec", label: "Specs only" },
  { value: "tbb", label: "To be built" },
] as const

const BEDS = [
  { value: "any", label: "Any beds" },
  { value: "2", label: "2+ beds" },
  { value: "3", label: "3+ beds" },
  { value: "4", label: "4+ beds" },
  { value: "5", label: "5+ beds" },
] as const

const PRICE_BANDS = [
  { value: "any", label: "Any price", min: 0, max: Number.POSITIVE_INFINITY },
  { value: "u300", label: "Under $300K", min: 0, max: 300_000_00 },
  { value: "300-400", label: "$300–400K", min: 300_000_00, max: 400_000_00 },
  { value: "400-500", label: "$400–500K", min: 400_000_00, max: 500_000_00 },
  { value: "500-650", label: "$500–650K", min: 500_000_00, max: 650_000_00 },
  { value: "650-800", label: "$650–800K", min: 650_000_00, max: 800_000_00 },
  { value: "o800", label: "Over $800K", min: 800_000_00, max: Number.POSITIVE_INFINITY },
] as const

const SORTS = [
  { value: "price_asc", label: "Price, low first" },
  { value: "price_desc", label: "Price, high first" },
  { value: "aging", label: "Longest standing" },
  { value: "lot", label: "Lot number" },
] as const

const COLUMNS = "grid grid-cols-[0.7fr_1.3fr_1fr_0.9fr_0.9fr_92px] gap-3"

interface FindAHomeDialogProps {
  /**
   * Always a real buyer. Browsing inventory with nobody to sell it to is the
   * community workbench's job — this picker exists to attach a lot to a deal,
   * and without one every row would be a dead end.
   */
  buyer: HoldBuyer
  communities: PipelineCommunityOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * What this buyer can be sold today. A dialog rather than a page because it is a
 * question asked mid-conversation — the deal stays on screen behind it, and
 * picking a lot holds it right here instead of routing the consultant through a
 * second surface to do the one thing they came for.
 */
export function FindAHomeDialog({ buyer, communities, open, onOpenChange }: FindAHomeDialogProps) {
  const [homes, setHomes] = useState<SellableHome[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [availability, setAvailability] = useState<string>("all")
  const [beds, setBeds] = useState<string>("any")
  const [band, setBand] = useState<string>("any")
  const [sort, setSort] = useState<string>("price_asc")
  const [holdLot, setHoldLot] = useState<HoldLot | null>(null)

  // Inventory moves — a lot held from another surface should not still be
  // offered here — so it reloads on every open rather than caching across them.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setHomes(null)
    setError(null)
    setHoldLot(null)
    listSellableHomesAction()
      .then((result) => {
        if (!cancelled) setHomes(unwrapAction(result))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError((cause as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const visible = useMemo(() => {
    if (!homes) return []
    const needle = search.trim().toLowerCase()
    const priceBand = PRICE_BANDS.find((option) => option.value === band) ?? PRICE_BANDS[0]
    const minBeds = beds === "any" ? 0 : Number(beds)

    return homes
      .filter((home) => {
        if (availability === "spec" && !home.isSpec) return false
        if (availability === "tbb" && home.isSpec) return false
        if (minBeds > 0 && (home.beds ?? 0) < minBeds) return false
        if (priceBand.value !== "any") {
          // An unpriced lot cannot satisfy a budget question, so a band excludes it.
          if (home.askingPriceCents <= 0) return false
          if (home.askingPriceCents < priceBand.min || home.askingPriceCents >= priceBand.max) return false
        }
        if (needle) {
          const haystack = [home.lotLabel, home.planLabel, home.communityName].filter(Boolean).join(" ").toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      })
      .sort((a, b) => {
        if (sort === "lot") return a.lotLabel.localeCompare(b.lotLabel, undefined, { numeric: true })
        if (sort === "aging") return b.agingDays - a.agingDays
        const left = a.askingPriceCents || Number.POSITIVE_INFINITY
        const right = b.askingPriceCents || Number.POSITIVE_INFINITY
        return sort === "price_desc" ? right - left : left - right
      })
  }, [homes, search, availability, beds, band, sort])

  const groups = useMemo(() => {
    const byCommunity = new Map<string, SellableHome[]>()
    for (const home of visible) {
      const key = home.communityName ?? "Unassigned community"
      const bucket = byCommunity.get(key)
      if (bucket) bucket.push(home)
      else byCommunity.set(key, [home])
    }
    return [...byCommunity.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visible])

  const narrowed = availability !== "all" || beds !== "any" || band !== "any" || search.trim().length > 0
  const specCount = visible.filter((home) => home.isSpec).length

  if (holdLot) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="overflow-hidden rounded-none p-0 sm:max-w-md">
          <DialogHeader className="space-y-1 px-5 pt-5 text-left">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <button
                type="button"
                onClick={() => setHoldLot(null)}
                aria-label="Back to available homes"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
              </button>
              Hold Lot {holdLot.label} for {buyer.name}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Puts a soft hold on the lot. Holds expire on their own; convert to a reservation from the
              community&apos;s Sales tab to invoice the earnest deposit.
            </DialogDescription>
          </DialogHeader>
          <LotHoldForm
            buyer={buyer}
            communities={communities}
            lot={holdLot}
            cancelLabel="Back"
            onCancel={() => setHoldLot(null)}
            onHeld={() => onOpenChange(false)}
          />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex max-h-[85vh] flex-col overflow-hidden rounded-none p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4 text-left">
          <DialogTitle className="text-base font-semibold">Find a home</DialogTitle>
          <DialogDescription className="text-xs">
            Everything <span className="font-medium text-foreground">{buyer.name}</span> can be sold into right now.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
          <div className="flex min-w-[10rem] flex-1 items-center gap-2 border px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Lot, plan, community…"
              aria-label="Search homes"
              autoFocus
              className="h-7 rounded-none border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Picker value={availability} onChange={setAvailability} options={AVAILABILITY} label="Availability" />
          <Picker value={beds} onChange={setBeds} options={BEDS} label="Beds" />
          <Picker value={band} onChange={setBand} options={PRICE_BANDS} label="Price" />
          <Picker value={sort} onChange={setSort} options={SORTS} label="Sort" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="px-5 py-12 text-center text-xs text-destructive">{error}</p>
          ) : homes === null ? (
            <div className="space-y-2 px-5 py-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-8 w-full rounded-none" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">{narrowed ? <Search /> : <Home />}</EmptyMedia>
                <EmptyTitle className="text-base">
                  {narrowed ? "Nothing matches those filters" : "Nothing available to sell"}
                </EmptyTitle>
                <EmptyDescription className="text-xs">
                  {narrowed
                    ? `${homes.length} home${homes.length === 1 ? "" : "s"} are available in this scope — widen the price band or bed count.`
                    : "Lots show up here once they are owned or developed, have a plan assigned, and are not already held or sold."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {narrowed ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("")
                      setAvailability("all")
                      setBeds("any")
                      setBand("any")
                    }}
                    className="text-xs font-medium underline underline-offset-2 hover:text-primary"
                  >
                    Clear filters
                  </button>
                ) : (
                  <Link href="/communities" className="text-xs font-medium underline underline-offset-2 hover:text-primary">
                    Go to Communities
                  </Link>
                )}
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div
                className={cn(
                  COLUMNS,
                  "sticky top-0 z-20 border-b bg-muted px-5 py-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase",
                )}
              >
                <span>Lot</span>
                <span>Plan</span>
                <span>Beds · baths · sq ft</span>
                <span>Availability</span>
                <span className="text-right">Price</span>
                <span />
              </div>
              {groups.map(([communityName, communityHomes]) => (
                <section key={communityName}>
                  <h3 className="sticky top-[26px] z-10 border-b bg-background/95 px-5 py-1.5 text-[11px] font-semibold backdrop-blur">
                    {communityName}
                    <span className="ml-2 font-normal text-muted-foreground tabular-nums">
                      {communityHomes.length} available
                    </span>
                  </h3>
                  <ul>
                    {communityHomes.map((home) => {
                      const aging = home.isSpec && home.agingDays > AGING_SPEC_DAYS
                      return (
                        <li
                          key={home.lotId}
                          className={cn(COLUMNS, "items-center border-b px-5 py-2 text-[13px] transition-colors hover:bg-muted/40")}
                        >
                          <span className="font-medium">Lot {home.lotLabel}</span>
                          <span className="truncate text-muted-foreground">{home.planLabel}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {[home.beds, home.baths, home.sqft ? home.sqft.toLocaleString() : null]
                              .filter((value) => value != null)
                              .join(" · ") || "—"}
                          </span>
                          <span className={cn("text-xs", aging && "font-medium text-warning")}>
                            {home.isSpec ? `Spec · ${home.agingDays}d` : "To be built"}
                          </span>
                          <span className="text-right font-medium tabular-nums">
                            {home.askingPriceCents > 0 ? (
                              money.format(home.askingPriceCents / 100)
                            ) : (
                              <span className="font-normal text-muted-foreground">—</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 rounded-none text-xs"
                            onClick={() =>
                              setHoldLot({
                                id: home.lotId,
                                label: home.lotLabel,
                                communityId: home.communityId,
                                communityName: home.communityName,
                                planLabel: home.planLabel,
                                askingPriceCents: home.askingPriceCents,
                              })
                            }
                          >
                            Hold
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-2.5">
          <p className="text-xs text-muted-foreground">
            {homes === null ? (
              "Loading inventory…"
            ) : (
              <>
                <span className="font-medium text-foreground tabular-nums">{visible.length}</span> available ·{" "}
                <span className="tabular-nums">{specCount}</span> ready or building
              </>
            )}
          </p>
          <Button variant="outline" size="sm" className="rounded-none" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  label: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="!h-8 w-auto min-w-[7.5rem] rounded-none text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-none">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
