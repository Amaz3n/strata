"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { bulkUpdateLotsAction, createLotRangeAction, listMatchingLotIdsAction } from "@/app/(app)/communities/actions"
import { LotInspector, type LotMoney } from "@/components/communities/lot-inspector"
import { LotPlatGrid } from "@/components/communities/lot-plat-grid"
import { ChevronDown, ChevronUp, Plus, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import { LAND_SETTABLE_LOT_STATUSES, LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { CommunityInventoryPage, InventoryLotDTO, InventorySort } from "@/lib/services/community-inventory"
import { cn } from "@/lib/utils"

const ALL = "all"
const NONE = "none"

/** Margin is ranked by the page rather than Postgres; everything else is a column. */
export type SortKey = InventorySort | "margin"

function SortableHead({
  label,
  sortKey,
  sort,
  direction,
  onSort,
  align = "left",
}: {
  label: string
  sortKey: SortKey
  sort: SortKey
  direction: "asc" | "desc"
  onSort: (key: SortKey) => void
  align?: "left" | "right"
}) {
  const active = sort === sortKey
  const Arrow = direction === "desc" ? ChevronDown : ChevronUp
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          align === "right" ? "flex-row-reverse" : "",
          active ? "text-foreground" : "",
        )}
      >
        {label}
        <Arrow className={cn("size-3", active ? "opacity-100" : "opacity-0")} />
      </button>
    </TableHead>
  )
}

/**
 * One edit for the whole selection. Status, phase, and takedown used to be three
 * placeholder Selects that each fired the moment they were touched — so setting
 * a release's phase and takedown was two round-trips, two toasts, and no way to
 * see what you were about to do before you did it.
 */
function BulkEditPopover({
  community,
  count,
  disabled,
  onApply,
}: {
  community: CommunityDetailDTO
  count: number
  disabled: boolean
  onApply: (patch: Record<string, unknown>, summary: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(NONE)
  const [phaseId, setPhaseId] = useState(NONE)
  const [takedownId, setTakedownId] = useState(NONE)

  const patch: Record<string, unknown> = {}
  const changes: string[] = []
  if (status !== NONE) {
    patch.status = status
    changes.push(LOT_STATUS_META[status as LotStatus].label.toLowerCase())
  }
  if (phaseId !== NONE) {
    patch.phaseId = phaseId === "unphased" ? null : phaseId
    changes.push(phaseId === "unphased" ? "unphased" : (community.phases.find((phase) => phase.id === phaseId)?.name ?? "phased"))
  }
  if (takedownId !== NONE) {
    patch.takedownId = takedownId === "unassigned" ? null : takedownId
    changes.push(
      takedownId === "unassigned"
        ? "unassigned from a takedown"
        : (community.takedowns.find((takedown) => takedown.id === takedownId)?.name ?? "reassigned"),
    )
  }

  function apply() {
    onApply(patch, `${count} ${count === 1 ? "lot" : "lots"} set to ${changes.join(", ")}`)
    setStatus(NONE)
    setPhaseId(NONE)
    setTakedownId(NONE)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="h-7 rounded-none text-xs" disabled={disabled}>
          Edit {count} {count === 1 ? "lot" : "lots"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 rounded-none p-3">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="microlabel">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-8 rounded-none text-xs">
                <SelectValue placeholder="Leave as is" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Leave as is</SelectItem>
                {LOT_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {LOT_STATUS_META[value].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {community.phases.length > 0 ? (
            <div className="grid gap-1.5">
              <Label className="microlabel">Phase</Label>
              <Select value={phaseId} onValueChange={setPhaseId}>
                <SelectTrigger className="h-8 rounded-none text-xs">
                  <SelectValue placeholder="Leave as is" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Leave as is</SelectItem>
                  <SelectItem value="unphased">Unphased</SelectItem>
                  {community.phases.map((phase) => (
                    <SelectItem key={phase.id} value={phase.id}>
                      {phase.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {community.takedowns.length > 0 ? (
            <div className="grid gap-1.5">
              <Label className="microlabel">Takedown</Label>
              <Select value={takedownId} onValueChange={setTakedownId}>
                <SelectTrigger className="h-8 rounded-none text-xs">
                  <SelectValue placeholder="Leave as is" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Leave as is</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {community.takedowns.map((takedown) => (
                    <SelectItem key={takedown.id} value={takedown.id}>
                      {takedown.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Button size="sm" className="h-8 rounded-none text-xs" disabled={changes.length === 0 || disabled} onClick={apply}>
            {changes.length === 0 ? "Nothing to apply" : `Apply to ${count} ${count === 1 ? "lot" : "lots"}`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: cents >= 1_000_000 ? "compact" : "standard",
  }).format(cents / 100)
}

function lotLabel(lot: InventoryLotDTO) {
  return lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber
}

/** What the lot is worth to a buyer today, when anything has priced it. */
function listPriceCents(lot: InventoryLotDTO) {
  return lot.askingPriceOverrideCents ?? lot.buyer?.askingPriceCents ?? null
}

/**
 * Every lot in the community, as a table first and a plat second.
 *
 * The table is primary because these users scan: address, plan, buyer, price,
 * and margin for four hundred lots at once beats one colour per tile and a click
 * per lot. The plat stays for the questions only a map answers.
 *
 * Filtering and paging are server-side and live in the URL, so both views show
 * the same set and a filtered inventory is a link somebody can send.
 */
export function CommunityInventory({
  community,
  inventory,
  statusCounts,
  marginSortCap,
  money: moneyByProject,
  marginTargetPercent,
  projects,
  canWrite,
  canReadMoney,
  view,
  sort,
  direction,
}: {
  community: CommunityDetailDTO
  inventory: CommunityInventoryPage
  statusCounts: Record<LotStatus, number> | null
  /** Set when a margin sort could only rank the first N lots, so the cap is said out loud. */
  marginSortCap: number | null
  money: Record<string, LotMoney>
  marginTargetPercent: number | null
  projects: Array<{ id: string; name: string }>
  canWrite: boolean
  canReadMoney: boolean
  view: "table" | "map"
  sort: SortKey
  direction: "asc" | "desc"
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionScope, setSelectionScope] = useState<"page" | "matching">("page")
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [search, setSearch] = useState(params.get("q") ?? "")

  const status = params.get("status") ?? ALL
  const phaseId = params.get("phase") ?? ALL
  const query = params.get("q") ?? ""

  function pushParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === ALL || value === "") next.delete(key)
      else next.set(key, value)
    }
    // Any change to the filter set invalidates the page cursor and the selection.
    if (!("page" in patch)) next.delete("page")
    setSelected(new Set())
    setSelectionScope("page")
    startTransition(() => router.push(`/communities/${community.id}?${next}`))
  }

  /** Clicking the sorted column flips it; clicking another takes it, ascending. */
  function sortBy(key: SortKey) {
    pushParams({
      sort: key === "lot" && !(sort === "lot" && direction === "asc") ? null : key,
      dir: sort === key && direction === "asc" ? "desc" : null,
    })
  }

  /**
   * Reaches past the page for the ids behind the current filters, so re-phasing
   * a whole release is one edit rather than one per hundred rows.
   */
  function selectAllMatching() {
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await listMatchingLotIdsAction(community.id, {
            status: status === ALL ? undefined : status,
            phaseId: phaseId === ALL ? undefined : phaseId,
            search: query || undefined,
          }),
        )
        setSelected(new Set(result.ids))
        setSelectionScope("matching")
        if (result.capped) {
          toast.warning(`Selected the first ${result.ids.length} of ${result.total} lots`, {
            description: "A bulk edit carries its lots in one request. Narrow the filters to reach the rest.",
          })
        }
      } catch (error) {
        toast.error("Unable to select the matching lots", { description: (error as Error).message })
      }
    })
  }

  // The search box types locally and commits on a pause, so a 400-lot community
  // is not queried once per keystroke.
  useEffect(() => {
    if (search === query) return
    const timer = setTimeout(() => pushParams({ q: search || null }), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function bulkPatch(patch: Record<string, unknown>, success: string) {
    startTransition(async () => {
      try {
        unwrapAction(await bulkUpdateLotsAction(community.id, { lotIds: [...selected], patch }))
        toast.success(success)
        setSelected(new Set())
        setSelectionScope("page")
        router.refresh()
      } catch (error) {
        toast.error("Unable to update the lots", { description: (error as Error).message })
      }
    })
  }

  function toggleSelect(lotId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(lotId)) next.delete(lotId)
      else next.add(lotId)
      return next
    })
  }

  const lots = inventory.lots
  const allSelected = lots.length > 0 && lots.every((lot) => selected.has(lot.id))
  const inspectedLot = lots.find((lot) => lot.id === inspecting) ?? null
  const filtered = status !== ALL || phaseId !== ALL || query !== ""

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex border" role="group" aria-label="View">
            {(["table", "map"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => pushParams({ view: value === "table" ? null : value })}
                className={cn(
                  "h-8 border-l px-2.5 text-[11px] capitalize transition-colors first:border-l-0",
                  view === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-8 w-48 rounded-none pl-8 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Lot, block, or address"
              aria-label="Find a lot by number, block, or address"
            />
          </div>
          {community.phases.length > 0 ? (
            <Select value={phaseId} onValueChange={(value) => pushParams({ phase: value })}>
              <SelectTrigger className="h-8 w-32 rounded-none text-xs" aria-label="Phase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All phases</SelectItem>
                {community.phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    {phase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {inventory.total} {inventory.total === 1 ? "lot" : "lots"}
          </span>
          {canWrite ? <AddLotsDialog community={community} /> : null}
        </div>
      </div>

      {marginSortCap != null ? (
        <p className="border-b px-4 py-1.5 text-[11px] text-warning">
          Margin is computed per home rather than stored on the lot, so this ranking covers the first {marginSortCap} of{" "}
          {inventory.total} lots. Filter by phase or status to rank the rest.
        </p>
      ) : null}

      {statusCounts ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5">
          {/* The status filter and the lot mix are the same information, so they
              are the same control: what is there, and one click to see only it. */}
          <button
            type="button"
            aria-pressed={status === ALL}
            onClick={() => pushParams({ status: null })}
            className={cn(
              "border px-1.5 py-0.5 text-[11px] transition-colors",
              status === ALL ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            All <span className="tabular-nums">{LOT_STATUSES.reduce((sum, value) => sum + statusCounts[value], 0)}</span>
          </button>
          {LOT_STATUSES.filter((value) => statusCounts[value] > 0 || status === value).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => pushParams({ status: status === value ? null : value })}
              className={cn(
                "flex items-center gap-1.5 border px-1.5 py-0.5 text-[11px] transition-colors",
                status === value
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span className={cn("size-2 shrink-0", LOT_STATUS_META[value].barClass)} />
              {LOT_STATUS_META[value].label} <span className="tabular-nums">{statusCounts[value]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {lots.length === 0 ? (
        <div className="flex flex-1 flex-col p-4">
          <Empty className="flex-1 rounded-none border">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{filtered ? "No matching lots" : "No lots platted yet"}</EmptyTitle>
              <EmptyDescription className="text-xs">
                {filtered
                  ? "Nothing in this community matches the current filters."
                  : "Add a numbered range and every lot appears here, ready to address, price, and work."}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <Button
                variant="outline"
                size="sm"
                className="rounded-none"
                onClick={() => {
                  setSearch("")
                  startTransition(() => router.push(`/communities/${community.id}`))
                }}
              >
                Clear filters
              </Button>
            ) : canWrite ? (
              <AddLotsDialog community={community} />
            ) : null}
          </Empty>
        </div>
      ) : view === "map" ? (
        <LotPlatGrid
          community={community}
          lots={lots}
          money={moneyByProject}
          marginTargetPercent={marginTargetPercent}
          selected={selected}
          onToggleSelect={toggleSelect}
          onInspect={setInspecting}
          canWrite={canWrite}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="microlabel">
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select every lot on this page"
                    checked={allSelected}
                    onCheckedChange={(checked) =>
                      setSelected(checked ? new Set(lots.map((lot) => lot.id)) : new Set())
                    }
                  />
                </TableHead>
                <SortableHead label="Lot" sortKey="lot" sort={sort} direction={direction} onSort={sortBy} />
                <SortableHead label="Address" sortKey="address" sort={sort} direction={direction} onSort={sortBy} />
                <TableHead>Phase</TableHead>
                <SortableHead label="Status" sortKey="status" sort={sort} direction={direction} onSort={sortBy} />
                <TableHead>Plan</TableHead>
                <TableHead>Buyer</TableHead>
                <SortableHead label="Price" sortKey="price" sort={sort} direction={direction} onSort={sortBy} align="right" />
                {canReadMoney ? (
                  <SortableHead label="Margin" sortKey="margin" sort={sort} direction={direction} onSort={sortBy} align="right" />
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lots.map((lot) => {
                const lotMoney = lot.projectId ? moneyByProject[lot.projectId] : undefined
                const price = listPriceCents(lot)
                return (
                  <TableRow
                    key={lot.id}
                    className="cursor-pointer text-xs"
                    onClick={() => setInspecting(lot.id)}
                  >
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select lot ${lotLabel(lot)}`}
                        checked={selected.has(lot.id)}
                        onCheckedChange={() => toggleSelect(lot.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">{lotLabel(lot)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {lot.address ?? <span className="text-muted-foreground/60">No address</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{lot.phaseName ?? "—"}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className={cn("size-2 shrink-0", LOT_STATUS_META[lot.status].barClass)} />
                        {LOT_STATUS_META[lot.status].label}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lot.planName ? (
                        <>
                          {lot.planName}
                          {lot.elevationName ? ` · ${lot.elevationName}` : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      {lot.buyer ? (
                        lot.buyer.prospectId ? (
                          <Link href={`/sales/${lot.buyer.prospectId}`} className="hover:underline">
                            {lot.buyer.name ?? "Buyer"}
                          </Link>
                        ) : (
                          (lot.buyer.name ?? "Buyer")
                        )
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price != null ? money(price) : "—"}
                      {/* The premium modifies the price rather than competing with
                          it, so it reads as one number with a qualifier. */}
                      {lot.premiumCents > 0 ? (
                        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                          +{money(lot.premiumCents)} prem
                        </span>
                      ) : null}
                    </TableCell>
                    {canReadMoney ? (
                      <TableCell className="text-right tabular-nums">
                        {lotMoney ? `${lotMoney.projectedMarginPercent.toFixed(1)}%` : "—"}
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

        </div>
      )}

      {/* One pager for both views. The plat used to page silently against a
          different size than the table, so the two showed different sets and
          apologised for it in a footnote. */}
      {lots.length > 0 && inventory.total > inventory.pageSize ? (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs">
          <span className="tabular-nums text-muted-foreground">
            {(inventory.page - 1) * inventory.pageSize + 1}–{(inventory.page - 1) * inventory.pageSize + lots.length} of{" "}
            {inventory.total}
            {view === "map" ? " lots drawn" : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-none text-xs"
              disabled={inventory.page <= 1 || isPending}
              onClick={() => pushParams({ page: String(inventory.page - 1) })}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-none text-xs"
              disabled={!inventory.truncated || isPending}
              onClick={() => pushParams({ page: String(inventory.page + 1) })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-3 border-t bg-background px-4 py-2">
          <span className="text-xs tabular-nums">
            {selected.size} {selected.size === 1 ? "lot" : "lots"} selected
          </span>
          {selectionScope === "page" && allSelected && inventory.total > lots.length ? (
            <button
              type="button"
              className="text-xs underline underline-offset-2 hover:text-foreground"
              disabled={isPending}
              onClick={selectAllMatching}
            >
              Select all {inventory.total} matching
            </button>
          ) : null}
          <BulkEditPopover
            community={community}
            count={selected.size}
            disabled={isPending}
            onApply={(patch, summary) => bulkPatch(patch, summary)}
          />
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 rounded-none text-xs"
            onClick={() => {
              setSelected(new Set())
              setSelectionScope("page")
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <LotInspector
        lot={inspectedLot}
        community={community}
        money={inspectedLot?.projectId ? (moneyByProject[inspectedLot.projectId] ?? null) : null}
        projects={projects}
        canWrite={canWrite}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
      />
    </div>
  )
}

const EMPTY_RANGE = {
  block: "",
  fromNumber: "",
  toNumber: "",
  phaseId: NONE,
  takedownId: NONE,
  status: "controlled" as LotStatus,
  street: "",
  addressFrom: "",
  addressStep: "1",
  widthFt: "",
  depthFt: "",
  costBasis: "",
}

/**
 * Platting a range is the one moment when every lot in it shares its facts —
 * same block, same phase, same takedown, same street, same depth. Capturing
 * them here is the difference between a community that is ready to sell and
 * forty-eight rows that each need opening.
 */
function AddLotsDialog({ community }: { community: CommunityDetailDTO }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [draft, setDraft] = useState(EMPTY_RANGE)

  const set = (patch: Partial<typeof EMPTY_RANGE>) => setDraft((current) => ({ ...current, ...patch }))

  const count = Number(draft.toNumber) - Number(draft.fromNumber) + 1
  const valid =
    Number.isFinite(count) && count > 0 && count <= 500 && draft.fromNumber !== "" && draft.toNumber !== ""

  /**
   * Both ends of the range. The first lot alone never catches a wrong step —
   * "4100 Cypress" looks right whether the last house is 4147 or 4194.
   */
  function previewLot(number: number, index: number) {
    const label = draft.block.trim() ? `${draft.block.trim()}-${number}` : String(number)
    const step = Number(draft.addressStep) || 1
    const address =
      draft.street.trim() && draft.addressFrom ? `${Number(draft.addressFrom) + index * step} ${draft.street.trim()}` : null
    return [label, address].filter(Boolean).join(" · ")
  }

  const preview = valid
    ? count === 1
      ? previewLot(Number(draft.fromNumber), 0)
      : `${previewLot(Number(draft.fromNumber), 0)} → ${previewLot(Number(draft.toNumber), count - 1)}`
    : null

  function chooseTakedown(value: string) {
    const takedown = community.takedowns.find((entry) => entry.id === value)
    // The takedown already knows what the dirt cost; carrying it over beats
    // retyping it onto every lot.
    set({
      takedownId: value,
      costBasis:
        takedown?.pricePerLotCents != null && !draft.costBasis
          ? String(takedown.pricePerLotCents / 100)
          : draft.costBasis,
    })
  }

  function submit() {
    startTransition(async () => {
      try {
        unwrapAction(
          await createLotRangeAction(community.id, {
            fromNumber: Number(draft.fromNumber),
            toNumber: Number(draft.toNumber),
            block: draft.block.trim() || null,
            phaseId: draft.phaseId === NONE ? null : draft.phaseId,
            takedownId: draft.takedownId === NONE ? null : draft.takedownId,
            status: draft.status,
            street: draft.street.trim() || null,
            addressFrom: draft.addressFrom ? Number(draft.addressFrom) : null,
            addressStep: Number(draft.addressStep) || 1,
            widthFt: draft.widthFt ? Number(draft.widthFt) : null,
            depthFt: draft.depthFt ? Number(draft.depthFt) : null,
            costBasisCents: draft.costBasis ? Math.round(Number(draft.costBasis) * 100) : null,
          }),
        )
        toast.success(`${count} lots added`)
        setOpen(false)
        setDraft(EMPTY_RANGE)
        router.refresh()
      } catch (error) {
        toast.error("Unable to add lots", { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 rounded-none text-xs">
          <Plus className="mr-1.5 size-3.5" />
          Add lots
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add lots</DialogTitle>
          <DialogDescription>
            Up to 500 lots at once. Everything below applies to the whole range — premium and garage swing vary lot to
            lot, so they are set afterwards.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-lots"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !isPending) submit()
          }}
          className="grid gap-5 py-2"
        >
          <section className="grid gap-3">
            <h3 className="microlabel">Numbering</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lot-block">
                  Block <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="lot-block"
                  value={draft.block}
                  onChange={(event) => set({ block: event.target.value })}
                  placeholder="A"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-from">From</Label>
                <Input
                  id="lot-from"
                  type="number"
                  min={0}
                  autoFocus
                  value={draft.fromNumber}
                  onChange={(event) => set({ fromNumber: event.target.value })}
                  placeholder="1"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-to">To</Label>
                <Input
                  id="lot-to"
                  type="number"
                  min={0}
                  value={draft.toNumber}
                  onChange={(event) => set({ toNumber: event.target.value })}
                  placeholder="48"
                />
              </div>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="microlabel">Land</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={draft.status} onValueChange={(value) => set({ status: value as LotStatus })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LAND_SETTABLE_LOT_STATUSES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {LOT_STATUS_META[value].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {community.phases.length > 0 ? (
                <div className="grid gap-1.5">
                  <Label>Phase</Label>
                  <Select value={draft.phaseId} onValueChange={(value) => set({ phaseId: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Unphased</SelectItem>
                      {community.phases.map((phase) => (
                        <SelectItem key={phase.id} value={phase.id}>
                          {phase.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {community.takedowns.length > 0 ? (
                <div className="grid gap-1.5">
                  <Label>Takedown</Label>
                  <Select value={draft.takedownId} onValueChange={chooseTakedown}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Unassigned</SelectItem>
                      {community.takedowns.map((takedown) => (
                        <SelectItem key={takedown.id} value={takedown.id}>
                          {takedown.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lot-width">Width ft</Label>
                <Input
                  id="lot-width"
                  inputMode="decimal"
                  value={draft.widthFt}
                  onChange={(event) => set({ widthFt: event.target.value })}
                  placeholder="52"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-depth">Depth ft</Label>
                <Input
                  id="lot-depth"
                  inputMode="decimal"
                  value={draft.depthFt}
                  onChange={(event) => set({ depthFt: event.target.value })}
                  placeholder="115"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-cost">Land cost each</Label>
                <Input
                  id="lot-cost"
                  inputMode="decimal"
                  value={draft.costBasis}
                  onChange={(event) => set({ costBasis: event.target.value })}
                  placeholder="76500"
                />
              </div>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="microlabel">Addresses</h3>
            <div className="grid grid-cols-[1fr_7rem_5rem] gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lot-street">
                  Street <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="lot-street"
                  value={draft.street}
                  onChange={(event) => set({ street: event.target.value })}
                  placeholder="Cypress Landing Way"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-address-from">First number</Label>
                <Input
                  id="lot-address-from"
                  type="number"
                  min={0}
                  value={draft.addressFrom}
                  onChange={(event) => set({ addressFrom: event.target.value })}
                  placeholder="4100"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lot-address-step">Step</Label>
                <Input
                  id="lot-address-step"
                  type="number"
                  min={1}
                  value={draft.addressStep}
                  onChange={(event) => set({ addressStep: event.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave the street empty to add lots without addresses. Step 2 numbers one side of a street.
            </p>
          </section>
        </form>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {preview ? (
              <>
                Range: <span className="text-foreground">{preview}</span>
              </>
            ) : null}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button form="add-lots" type="submit" disabled={!valid || isPending}>
              {isPending ? "Adding…" : valid ? `Add ${count} lots` : "Add lots"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
