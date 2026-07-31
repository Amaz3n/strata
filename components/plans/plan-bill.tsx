"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Download,
  Plus,
  Save,
  Search,
  Upload,
  X,
} from "@/components/icons"
import { replaceTakeoffLinesAction } from "@/app/(app)/plans/actions"
import { centsToDollars, signedDollars } from "@/components/plans/plan-badges"
import { TakeoffCodePicker } from "@/components/plans/takeoff-code-picker"
import { TakeoffImportDialog } from "@/components/plans/takeoff-import-dialog"
import { MeasureFromDrawingsButton } from "@/components/plans/measure-from-drawings-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { CostType } from "@/lib/cost-types"
import { downloadCsv } from "@/lib/csv"
import type { PlanPricingSource } from "@/lib/financials/plan-pricing"
import { buildBill, type BillRow } from "@/lib/plans/bill"
import { marginBand, MARGIN_BAND_META } from "@/lib/plans/margin"
import type { OfferingRow } from "@/lib/plans/offering"
import type { TakeoffImportLine } from "@/lib/plans/takeoff-import"
import type {
  HousePlanDto,
  HousePlanVersionDto,
  PlanVersionPricingDto,
  ResolvedTakeoffLinePricing,
  TakeoffLineDto,
} from "@/lib/services/house-plans"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"

type TakeoffDraft = {
  /** Identity of the row in the editor, stable across every edit to its contents. */
  uid: string
  lineId: string | null
  costCodeId: string
  costType: CostType | null
  description: string
  quantity: string
  uom: string
  unitCostDollars: string
  elevationId: string
}

let draftSequence = 0
const nextUid = () => `draft:${(draftSequence += 1)}`

function linesToDrafts(lines: TakeoffLineDto[], fresh = false): TakeoffDraft[] {
  return lines.map((line) => ({
    uid: fresh ? nextUid() : line.id,
    lineId: fresh ? null : line.id,
    costCodeId: line.cost_code_id,
    costType: line.cost_type,
    description: line.description,
    quantity: String(line.quantity),
    uom: line.uom,
    unitCostDollars: line.unit_cost_cents == null ? "" : (line.unit_cost_cents / 100).toFixed(2),
    elevationId: line.elevation_id ?? "base",
  }))
}

function toDrafts(version: HousePlanVersionDto): TakeoffDraft[] {
  return linesToDrafts(version.takeoff_lines ?? [])
}

/** Row identity is an editor concern; two drafts differing only by uid are the same takeoff. */
function fingerprint(drafts: TakeoffDraft[]): string {
  return JSON.stringify(
    drafts.map((draft) => [
      draft.costCodeId,
      draft.description,
      draft.quantity,
      draft.uom,
      draft.unitCostDollars,
      draft.elevationId,
    ]),
  )
}

function parseMoneyCents(value: string): number | null {
  if (value.trim() === "") return null
  const parsed = Number(value.replace(/[$,\s]/g, ""))
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null
}

function parseQuantity(value: string): number | null {
  if (value.trim() === "") return null
  const parsed = Number(value.replace(/[,\s]/g, ""))
  return Number.isFinite(parsed) ? parsed : null
}

function validate(draft: TakeoffDraft): string | null {
  if (!draft.costCodeId) return "needs a cost code"
  if (!draft.description.trim()) return "needs a description"
  if (!draft.uom.trim()) return "needs a unit of measure"
  const quantity = parseQuantity(draft.quantity)
  if (quantity == null || quantity < 0) return "has an unreadable quantity"
  if (draft.unitCostDollars.trim() !== "") {
    const unit = parseMoneyCents(draft.unitCostDollars)
    if (unit == null || unit < 0) return "has an unreadable unit cost"
  }
  return null
}

type DraftPricing = {
  unitCostCents: number | null
  amountCents: number
  source: PlanPricingSource
  vendorName: string | null
  lumpSum: boolean
  /** An active agreement owns this price — a typed unit cost would be ignored. */
  locked: boolean
}

/**
 * Mirrors the server's precedence — agreement, then a typed cost, then the cost
 * code default — locally, so the document stays truthful while it is being
 * edited instead of quietly changing meaning between reading and typing.
 */
function priceDraft(
  draft: TakeoffDraft,
  resolved: ResolvedTakeoffLinePricing | undefined,
  costCode: CostCode | undefined,
): DraftPricing {
  const quantity = parseQuantity(draft.quantity) ?? 0
  if (resolved?.source === "price_agreement") {
    const unit = resolved.resolved_unit_cost_cents
    return {
      unitCostCents: unit,
      amountCents: resolved.lump_sum ? unit : Math.round(quantity * unit),
      source: "price_agreement",
      vendorName: resolved.vendor_name,
      lumpSum: resolved.lump_sum,
      locked: true,
    }
  }
  const manual = parseMoneyCents(draft.unitCostDollars)
  if (manual != null) {
    return {
      unitCostCents: manual,
      amountCents: Math.round(quantity * manual),
      source: "takeoff_manual",
      vendorName: null,
      lumpSum: false,
      locked: false,
    }
  }
  const fallback = costCode?.default_unit_cost_cents
  if (fallback != null) {
    return {
      unitCostCents: fallback,
      amountCents: Math.round(quantity * fallback),
      source: "cost_code_default",
      vendorName: null,
      lumpSum: false,
      locked: false,
    }
  }
  return { unitCostCents: null, amountCents: 0, source: "unpriced", vendorName: null, lumpSum: false, locked: false }
}

/**
 * The takeoff as a cost document rather than a form: grouped into the divisions an
 * estimator argues in, always positioned against the edition currently being
 * built, and — on a draft — typed into directly. Approving a release is then an
 * act of reading a diff instead of an act of faith, which is the whole reason the
 * numbers on this page can be trusted.
 */
export function PlanBill({
  plan,
  version,
  comparisonVersion,
  costCodes,
  pricing,
  offering,
  editable,
  onDirtyChange,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  comparisonVersion: HousePlanVersionDto | null
  costCodes: CostCode[]
  pricing: PlanVersionPricingDto | null
  offering: OfferingRow[]
  editable: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [takeoff, setTakeoff] = useState<TakeoffDraft[]>(() => toDrafts(version))
  const [expanded, setExpanded] = useState(true)
  const [search, setSearch] = useState("")
  const [changedOnly, setChangedOnly] = useState(false)
  const [unpricedOnly, setUnpricedOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [elevationFilter, setElevationFilter] = useState("all")
  const [importing, setImporting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addDivision, setAddDivision] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ uid: string; field: "description" | "quantity" } | null>(null)

  const codeById = useMemo(() => new Map(costCodes.map((code) => [code.id, code])), [costCodes])
  const elevations = useMemo(() => plan.elevations ?? [], [plan.elevations])
  const pricingByLine = useMemo(
    () => new Map((pricing?.lines ?? []).map((line) => [line.line_id, line])),
    [pricing],
  )
  // What the server currently holds, which a save updates immediately rather than
  // waiting on the router refresh — otherwise the unsaved-changes bar survives a
  // successful save and reads as a failure.
  const [serverLines, setServerLines] = useState<TakeoffLineDto[]>(() => version.takeoff_lines ?? [])
  useEffect(() => {
    setServerLines(version.takeoff_lines ?? [])
  }, [version.takeoff_lines])

  const serverLineById = useMemo(() => new Map(serverLines.map((line) => [line.id, line])), [serverLines])
  const baseline = useMemo(() => fingerprint(linesToDrafts(serverLines)), [serverLines])
  const dirty = useMemo(() => fingerprint(takeoff) !== baseline, [takeoff, baseline])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const bill = useMemo(
    () =>
      buildBill({
        lines: takeoff.map((draft, index) => {
          const server = draft.lineId ? serverLineById.get(draft.lineId) : undefined
          // Price-book resolution belongs to the saved shape of the line; re-coding
          // a row invalidates it until the next save.
          const stillResolved =
            server && server.cost_code_id === draft.costCodeId && server.uom === draft.uom
              ? pricingByLine.get(server.id)
              : undefined
          const priced = priceDraft(draft, stillResolved, codeById.get(draft.costCodeId))
          return {
            uid: draft.uid,
            index,
            costCodeId: draft.costCodeId,
            description: draft.description,
            uom: draft.uom,
            quantity: parseQuantity(draft.quantity) ?? 0,
            elevationId: draft.elevationId === "base" ? null : draft.elevationId,
            unitCostCents: priced.unitCostCents,
            amountCents: priced.amountCents,
            pricingSource: priced.source,
            vendorName: priced.vendorName,
            lumpSum: priced.lumpSum,
            invalid: validate(draft) !== null,
          }
        }),
        comparisonLines: comparisonVersion?.takeoff_lines ?? null,
        costCodes,
      }),
    [takeoff, pricingByLine, serverLineById, comparisonVersion, costCodes, codeById],
  )

  const lockedByUid = useMemo(() => {
    const locked = new Set<string>()
    for (const draft of takeoff) {
      const server = draft.lineId ? serverLineById.get(draft.lineId) : undefined
      if (!server || server.cost_code_id !== draft.costCodeId || server.uom !== draft.uom) continue
      if (pricingByLine.get(server.id)?.source === "price_agreement") locked.add(draft.uid)
    }
    return locked
  }, [takeoff, serverLineById, pricingByLine])

  const elevationLabel = useCallback(
    (elevationId: string | null) =>
      elevationId == null ? "Base" : elevations.find((item) => item.id === elevationId)?.code ?? "—",
    [elevations],
  )

  const filtersActive = Boolean(search.trim()) || changedOnly || unpricedOnly || elevationFilter !== "all"

  const visibleDivisions = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return bill.divisions
      .map((division) => ({
        ...division,
        rows: division.rows.filter((row) => {
          if (changedOnly && row.status === "same") return false
          if (unpricedOnly && !row.unpriced) return false
          if (elevationFilter === "base" && row.elevationId !== null) return false
          if (elevationFilter !== "all" && elevationFilter !== "base" && row.elevationId !== elevationFilter) {
            return false
          }
          if (!needle) return true
          return (
            row.description.toLowerCase().includes(needle) ||
            row.costCode.toLowerCase().includes(needle) ||
            row.costCodeName.toLowerCase().includes(needle)
          )
        }),
      }))
      .filter((division) => division.rows.length > 0)
  }, [bill, search, changedOnly, unpricedOnly, elevationFilter])

  const heatedSqft = plan.heated_sqft
  const costPerSqft = heatedSqft ? Math.round(bill.amountCents / 100 / heatedSqft) : null

  function patch(uid: string, patchValue: Partial<TakeoffDraft>) {
    setTakeoff((current) => current.map((item) => (item.uid === uid ? { ...item, ...patchValue } : item)))
  }

  function clearFilters() {
    setSearch("")
    setChangedOnly(false)
    setUnpricedOnly(false)
    setElevationFilter("all")
    setCollapsed(new Set())
  }

  /** A new line has to land where the estimator is looking, so anything hiding it gives way. */
  function insert(draft: TakeoffDraft, afterUid?: string, field: "description" | "quantity" = "quantity") {
    setTakeoff((current) => {
      if (!afterUid) return [...current, draft]
      const at = current.findIndex((item) => item.uid === afterUid)
      if (at === -1) return [...current, draft]
      return [...current.slice(0, at + 1), draft, ...current.slice(at + 1)]
    })
    if (changedOnly || unpricedOnly || search.trim()) clearFilters()
    const division = codeById.get(draft.costCodeId)?.division?.trim()
    if (division) {
      setCollapsed((current) => {
        if (!current.has(division)) return current
        const next = new Set(current)
        next.delete(division)
        return next
      })
    }
    setFocus({ uid: draft.uid, field })
  }

  /**
   * Enter carries on down the column the way it does in a spreadsheet: a fresh
   * line directly below, inheriting the code, elevation and unit so only the
   * scope and the quantity are left to type. Sending focus to a control at the
   * far end of a two-hundred-line table instead would be useless.
   */
  function continueBelow(uid: string) {
    const source = takeoff.find((item) => item.uid === uid)
    if (!source) return
    insert(
      { ...source, uid: nextUid(), lineId: null, description: "", quantity: "1", unitCostDollars: "" },
      uid,
      "description",
    )
  }

  function addFromCode(code: CostCode) {
    insert({
      uid: nextUid(),
      lineId: null,
      costCodeId: code.id,
      costType: code.cost_type ?? null,
      description: code.name,
      quantity: "1",
      uom: code.unit ?? "ea",
      // Left blank so the code's own default keeps pricing the line — and keeps
      // saying so — instead of being frozen into a manual cost on creation.
      unitCostDollars: "",
      elevationId: elevationFilter === "all" || elevationFilter === "base" ? "base" : elevationFilter,
    })
  }

  function duplicate(uid: string) {
    const source = takeoff.find((item) => item.uid === uid)
    if (!source) return
    insert({ ...source, uid: nextUid(), lineId: null }, uid)
  }

  function remove(uid: string) {
    const snapshot = takeoff
    const removed = takeoff.find((item) => item.uid === uid)
    setTakeoff((current) => current.filter((item) => item.uid !== uid))
    toast(`Removed ${removed?.description || "line"}`, {
      action: { label: "Undo", onClick: () => setTakeoff(snapshot) },
    })
  }

  function copyFromComparison() {
    if (!comparisonVersion) return
    const copied = linesToDrafts(comparisonVersion.takeoff_lines ?? [], true)
    setTakeoff((current) => [...current, ...copied])
    toast.success(`${copied.length} lines copied from v${comparisonVersion.version_number} — save to keep them`)
  }

  function applyImport(lines: TakeoffImportLine[], mode: "append" | "replace") {
    const drafts = lines.map((line) => ({ ...line, uid: nextUid(), lineId: null }))
    setTakeoff((current) => (mode === "replace" ? drafts : [...current, ...drafts]))
    clearFilters()
    toast.success(
      `${drafts.length} ${drafts.length === 1 ? "line" : "lines"} ${mode === "replace" ? "loaded" : "added"} — save to keep them`,
    )
  }

  function exportCsv() {
    downloadCsv(
      `${plan.code}-v${version.version_number}-takeoff.csv`,
      takeoff.map((draft) => ({
        elevation: draft.elevationId === "base" ? "base" : elevationLabel(draft.elevationId),
        "cost code": codeById.get(draft.costCodeId)?.code ?? "",
        description: draft.description,
        quantity: draft.quantity,
        uom: draft.uom,
        "unit cost": draft.unitCostDollars,
      })),
      [
        { key: "elevation", header: "elevation" },
        { key: "cost code", header: "cost code" },
        { key: "description", header: "description" },
        { key: "quantity", header: "quantity" },
        { key: "uom", header: "uom" },
        { key: "unit cost", header: "unit cost" },
      ],
    )
  }

  const save = useCallback(() => {
    const broken = takeoff.map((draft) => validate(draft)).filter((error): error is string => error !== null)
    if (broken.length > 0) {
      // Reveal the offending rows rather than dropping them the way saving used to.
      setSearch("")
      setChangedOnly(false)
      setUnpricedOnly(false)
      setElevationFilter("all")
      setCollapsed(new Set())
      toast.error(`${broken.length} ${broken.length === 1 ? "line" : "lines"} can't be saved`, {
        description: `The first one ${broken[0]}.`,
      })
      return
    }
    startTransition(async () => {
      try {
        const saved = unwrapAction(
          await replaceTakeoffLinesAction(
            plan.id,
            version.id,
            takeoff.map((draft) => ({
              costCodeId: draft.costCodeId,
              costType: draft.costType,
              description: draft.description.trim(),
              quantity: parseQuantity(draft.quantity) ?? 0,
              uom: draft.uom.trim(),
              unitCostCents: parseMoneyCents(draft.unitCostDollars),
              elevationId: draft.elevationId === "base" ? null : draft.elevationId,
            })),
          ),
        )
        // Saving replaces every row server-side, so the drafts have to re-adopt the
        // new line ids or price-book resolution goes dark until the next remount.
        setServerLines(saved)
        setTakeoff(linesToDrafts(saved))
        toast.success("Takeoff saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save takeoff", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }, [takeoff, plan.id, version.id, router])

  useEffect(() => {
    if (!editable) return
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (dirty && !pending) save()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [editable, dirty, pending, save])

  function toggleDivision(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const leadColumns = 6
  const totalColumns = leadColumns + (comparisonVersion ? 3 : 1) + (editable ? 1 : 0)

  return (
    <section id="plan-bill" className="scroll-mt-10 border-b">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">Build cost</h3>
          <p className="text-[11px] text-muted-foreground">
            {bill.lineCount} {bill.lineCount === 1 ? "takeoff line" : "takeoff lines"} across {bill.divisions.length}{" "}
            {bill.divisions.length === 1 ? "division" : "divisions"}
            {bill.unpricedCount > 0 ? <span className="ml-1.5 text-destructive">{bill.unpricedCount} unpriced</span> : null}
            {editable ? null : <span className="ml-1.5">· v{version.version_number} is locked</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <Figure label="Direct cost" value={centsToDollars(bill.amountCents)} />
          {costPerSqft != null ? <Figure label="Per heated sf" value={`$${costPerSqft.toLocaleString()}`} /> : null}
          {bill.deltaCents != null && comparisonVersion ? (
            <Figure
              label={`vs v${comparisonVersion.version_number}`}
              value={bill.deltaCents === 0 ? "no change" : signedDollars(bill.deltaCents)}
              tone={bill.deltaCents > 0 ? "text-warning" : bill.deltaCents < 0 ? "text-success" : "text-muted-foreground"}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-none px-2 text-[11px]"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Collapse" : "Open takeoff"}
          </Button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-y bg-muted/30 px-4 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search lines"
                  aria-label="Search takeoff lines"
                  className="h-7 w-44 rounded-none pl-7 text-[11px]"
                />
              </div>
              {comparisonVersion ? (
                <FilterChip
                  active={changedOnly}
                  onClick={() => setChangedOnly((current) => !current)}
                  count={bill.changedCount}
                >
                  Changed vs v{comparisonVersion.version_number}
                </FilterChip>
              ) : null}
              {bill.unpricedCount > 0 ? (
                <FilterChip
                  active={unpricedOnly}
                  onClick={() => setUnpricedOnly((current) => !current)}
                  count={bill.unpricedCount}
                  tone="destructive"
                >
                  Unpriced
                </FilterChip>
              ) : null}
              {elevations.length > 0 ? (
                <Select value={elevationFilter} onValueChange={setElevationFilter}>
                  <SelectTrigger className="h-7 w-32 rounded-none text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All elevations</SelectItem>
                    <SelectItem value="base">Base only</SelectItem>
                    {elevations.map((elevation) => (
                      <SelectItem key={elevation.id} value={elevation.id}>
                        {elevation.code} deltas
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {filtersActive ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-none px-2 text-[11px] text-muted-foreground"
                  onClick={clearFilters}
                >
                  Clear
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-none px-2 text-[11px]"
                onClick={() =>
                  setCollapsed((current) =>
                    current.size > 0 ? new Set() : new Set(bill.divisions.map((division) => division.key)),
                  )
                }
              >
                {collapsed.size > 0 ? "Expand all" : "Collapse all"}
              </Button>
              {takeoff.length > 0 ? (
                <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]" onClick={exportCsv}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  Export
                </Button>
              ) : null}
              {editable ? (
                <>
                  <MeasureFromDrawingsButton
                    housePlanId={plan.id}
                    housePlanVersionId={version.id}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-none px-2 text-[11px]"
                    onClick={() => setImporting(true)}
                  >
                    <Upload className="mr-1 h-3.5 w-3.5" />
                    Paste
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {bill.lineCount === 0 && bill.divisions.length === 0 ? (
            <EmptyTakeoff
              editable={editable}
              comparisonVersion={comparisonVersion}
              costCodes={costCodes}
              onCopy={copyFromComparison}
              onPaste={() => setImporting(true)}
              onAdd={addFromCode}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-xs">
                <thead>
                  <tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="w-24 px-4 py-1.5 text-left font-medium">Code</th>
                    <th className="px-2 py-1.5 text-left font-medium">Description</th>
                    <th className="w-16 px-2 py-1.5 text-left font-medium">Elev</th>
                    <th className="w-20 px-2 py-1.5 text-right font-medium">Qty</th>
                    <th className="w-14 px-2 py-1.5 text-left font-medium">UOM</th>
                    <th className="w-32 px-2 py-1.5 text-right font-medium">Unit cost</th>
                    {comparisonVersion ? (
                      <th className="w-24 px-2 py-1.5 text-right font-medium">v{comparisonVersion.version_number}</th>
                    ) : null}
                    <th className="w-28 px-2 py-1.5 text-right font-medium">
                      {comparisonVersion ? `v${version.version_number}` : "Amount"}
                    </th>
                    {comparisonVersion ? <th className="w-24 px-2 py-1.5 text-right font-medium">Δ</th> : null}
                    {editable ? <th className="w-14 px-2 py-1.5" /> : null}
                  </tr>
                </thead>

                {visibleDivisions.length === 0 ? (
                  <tbody>
                    <tr>
                      <td colSpan={totalColumns} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        No lines match these filters.
                        <button type="button" className="ml-1.5 underline underline-offset-2" onClick={clearFilters}>
                          Clear them
                        </button>
                      </td>
                    </tr>
                  </tbody>
                ) : (
                  visibleDivisions.map((division) => {
                    const isCollapsed = collapsed.has(division.key)
                    return (
                      <tbody key={division.key}>
                        <tr className="border-y bg-muted/40">
                          <td className="px-4 py-1.5" colSpan={leadColumns}>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleDivision(division.key)}
                                className="flex items-center gap-1.5 text-left"
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <span className="text-[11px] font-medium">{division.label}</span>
                                <span
                                  aria-hidden
                                  className="ml-1 hidden h-1 w-16 bg-muted-foreground/20 sm:inline-block"
                                  title={`${Math.round(division.sharePct)}% of direct cost`}
                                >
                                  <span
                                    className="block h-full bg-primary/60"
                                    style={{ width: `${division.sharePct}%` }}
                                  />
                                </span>
                                {division.unpricedCount > 0 ? (
                                  <span className="ml-1 text-[10px] text-destructive">
                                    {division.unpricedCount} unpriced
                                  </span>
                                ) : null}
                              </button>
                              {editable ? (
                                <TakeoffCodePicker
                                  costCodes={costCodes}
                                  value={null}
                                  preferDivision={division.key}
                                  open={addDivision === division.key}
                                  onOpenChange={(open) => setAddDivision(open ? division.key : null)}
                                  onSelect={addFromCode}
                                >
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 rounded-none px-1 text-[10px] text-muted-foreground"
                                    aria-label={`Add a line to ${division.label}`}
                                  >
                                    <Plus className="h-3 w-3" />
                                  </Button>
                                </TakeoffCodePicker>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right text-[11px] font-medium tabular-nums">
                            {comparisonVersion ? centsToDollars(division.comparisonAmountCents ?? 0) : centsToDollars(division.amountCents)}
                          </td>
                          {comparisonVersion ? (
                            <td className="px-2 py-1.5 text-right text-[11px] font-medium tabular-nums">
                              {centsToDollars(division.amountCents)}
                            </td>
                          ) : null}
                          {comparisonVersion ? (
                            <td
                              className={cn(
                                "px-2 py-1.5 text-right text-[11px] font-medium tabular-nums",
                                (division.deltaCents ?? 0) > 0
                                  ? "text-warning"
                                  : (division.deltaCents ?? 0) < 0
                                    ? "text-success"
                                    : "text-muted-foreground",
                              )}
                            >
                              {division.deltaCents ? signedDollars(division.deltaCents) : "—"}
                            </td>
                          ) : null}
                          {editable ? <td /> : null}
                        </tr>

                        {isCollapsed
                          ? null
                          : division.rows.map((row) => (
                              <BillTableRow
                                key={row.key}
                                row={row}
                                draft={takeoff.find((item) => item.uid === row.key) ?? null}
                                costCodes={costCodes}
                                elevations={elevations}
                                elevationLabel={elevationLabel(row.elevationId)}
                                comparison={Boolean(comparisonVersion)}
                                editable={editable}
                                locked={lockedByUid.has(row.key)}
                                focusField={focus?.uid === row.key ? focus.field : null}
                                onFocused={() => setFocus(null)}
                                onPatch={(value) => patch(row.key, value)}
                                onDuplicate={() => duplicate(row.key)}
                                onRemove={() => remove(row.key)}
                                onEnter={() => continueBelow(row.key)}
                              />
                            ))}
                      </tbody>
                    )
                  })
                )}

                {editable ? (
                  <tbody>
                    <tr className="border-b border-dashed">
                      <td colSpan={leadColumns} className="px-4 py-1">
                        <div className="flex items-center gap-2">
                          <TakeoffCodePicker
                            costCodes={costCodes}
                            value={null}
                            open={addOpen}
                            onOpenChange={setAddOpen}
                            onSelect={addFromCode}
                          >
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 rounded-none px-2 text-[11px] text-muted-foreground"
                            >
                              <Plus className="mr-1 h-3.5 w-3.5" />
                              Add a line
                            </Button>
                          </TakeoffCodePicker>
                          <span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex">
                            search by code or name ·
                            <CornerDownLeft className="h-3 w-3" />
                            on any line adds another under it
                          </span>
                        </div>
                      </td>
                      <td colSpan={comparisonVersion ? 4 : 2} />
                    </tr>
                  </tbody>
                ) : null}

                <tfoot>
                  <tr className="border-t font-medium">
                    <td className="px-4 py-2" colSpan={leadColumns}>
                      <span className="text-muted-foreground">
                        {bill.lineCount} {bill.lineCount === 1 ? "line" : "lines"}
                        {filtersActive ? (
                          <span className="ml-1.5 text-[11px]">
                            (totals cover the whole takeoff, not just the filter)
                          </span>
                        ) : null}
                      </span>
                    </td>
                    {comparisonVersion ? (
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {centsToDollars(bill.comparisonAmountCents ?? 0)}
                      </td>
                    ) : null}
                    <td className="px-2 py-2 text-right tabular-nums">{centsToDollars(bill.amountCents)}</td>
                    {comparisonVersion ? (
                      <td
                        className={cn(
                          "px-2 py-2 text-right tabular-nums",
                          (bill.deltaCents ?? 0) > 0
                            ? "text-warning"
                            : (bill.deltaCents ?? 0) < 0
                              ? "text-success"
                              : "text-muted-foreground",
                        )}
                      >
                        {bill.deltaCents ? signedDollars(bill.deltaCents) : "—"}
                      </td>
                    ) : null}
                    {editable ? <td /> : null}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <CostOfSales offering={offering} buildCents={bill.amountCents} />

          {editable && dirty ? (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background px-4 py-2">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {bill.invalidCount > 0 ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                    <span className="text-destructive">
                      {bill.invalidCount} {bill.invalidCount === 1 ? "line needs" : "lines need"} attention
                    </span>
                  </>
                ) : (
                  <span className="tabular-nums">
                    Unsaved changes · {takeoff.length} {takeoff.length === 1 ? "line" : "lines"} ·{" "}
                    {centsToDollars(bill.amountCents)}
                  </span>
                )}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-none px-2 text-[11px]"
                  disabled={pending}
                  onClick={() => setTakeoff(linesToDrafts(serverLines))}
                >
                  Discard
                </Button>
                <Button size="sm" className="h-7 rounded-none px-2 text-[11px]" onClick={save} disabled={pending}>
                  <Save className="mr-1 h-3.5 w-3.5" />
                  {pending ? "Saving…" : "Save takeoff"}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <TakeoffImportDialog
        open={importing}
        onOpenChange={setImporting}
        costCodes={costCodes}
        elevations={elevations.map((elevation) => ({ id: elevation.id, code: elevation.code }))}
        hasExistingLines={takeoff.length > 0}
        onImport={applyImport}
      />
    </section>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-medium tabular-nums", tone)}>{value}</p>
    </div>
  )
}

function FilterChip({
  active,
  count,
  tone,
  onClick,
  children,
}: {
  active: boolean
  count?: number
  tone?: "destructive"
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 rounded-none border px-2 text-[11px]",
        active
          ? tone === "destructive"
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-primary/40 bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground",
      )}
    >
      {children}
      {count ? <span className="ml-1.5 tabular-nums">{count}</span> : null}
    </Button>
  )
}

const CELL_INPUT =
  "h-7 rounded-none border-transparent bg-transparent px-1.5 text-[11px] shadow-none hover:border-input focus-visible:border-ring"

function SourceMark({ row }: { row: BillRow }) {
  if (row.pricingSource === "price_agreement") {
    return (
      <span
        className="shrink-0 border border-primary/30 px-1 text-[9px] uppercase tracking-wide text-primary"
        title={
          row.vendorName
            ? `Priced from ${row.vendorName}'s agreement${row.lumpSum ? " as a lump sum" : ""} — the price book wins over a typed cost.`
            : "Priced from an active vendor agreement — the price book wins over a typed cost."
        }
      >
        book
      </span>
    )
  }
  if (row.pricingSource === "cost_code_default") {
    return (
      <span
        className="shrink-0 border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
        title="Falling back to the cost code's default unit cost."
      >
        default
      </span>
    )
  }
  if (row.pricingSource === "unpriced") {
    return (
      <span
        className="shrink-0 border border-destructive/40 px-1 text-[9px] uppercase tracking-wide text-destructive"
        title="No agreement, no typed cost, and no cost code default — this line contributes nothing to the build cost."
      >
        unpriced
      </span>
    )
  }
  return null
}

/**
 * One row shape for reading and for typing: the cells never move, only what sits
 * inside them. Losing your place in a two-hundred-line takeoff is the fastest way
 * to make somebody stop maintaining it.
 */
function BillTableRow({
  row,
  draft,
  costCodes,
  elevations,
  elevationLabel,
  comparison,
  editable,
  locked,
  focusField,
  onFocused,
  onPatch,
  onDuplicate,
  onRemove,
  onEnter,
}: {
  row: BillRow
  draft: TakeoffDraft | null
  costCodes: CostCode[]
  elevations: HousePlanDto["elevations"]
  elevationLabel: string
  comparison: boolean
  /** Whether the edition itself is open for editing — owns the actions column. */
  editable: boolean
  locked: boolean
  /** Which cell to take focus on, when this row was just created. */
  focusField: "description" | "quantity" | null
  onFocused: () => void
  onPatch: (value: Partial<TakeoffDraft>) => void
  onDuplicate: () => void
  onRemove: () => void
  onEnter: () => void
}) {
  const quantityRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusField) return
    const target = focusField === "quantity" ? quantityRef.current : descriptionRef.current
    target?.focus()
    target?.select()
    onFocused()
  }, [focusField, onFocused])

  const removed = row.status === "removed"
  /** A removed row exists only in the comparison, so it is never typed into. */
  const live = editable && draft !== null && !removed

  function keyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      onEnter()
    }
  }

  return (
    <tr
      className={cn("group border-b border-border/60", removed && comparison && "text-muted-foreground")}
    >
      <td className="px-4 py-1">
        {live ? (
          <TakeoffCodePicker
            costCodes={costCodes}
            value={draft.costCodeId}
            onSelect={(code) =>
              onPatch({
                costCodeId: code.id,
                costType: code.cost_type ?? null,
                uom: draft.uom || code.unit || "ea",
                description: draft.description || code.name,
              })
            }
          />
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">{row.costCode}</span>
        )}
      </td>

      <td className="px-2 py-1">
        {live ? (
          <Input
            ref={descriptionRef}
            aria-label="Description"
            className={cn(CELL_INPUT, "w-full", !draft.description.trim() && "border-destructive/50")}
            value={draft.description}
            onChange={(event) => onPatch({ description: event.target.value })}
            onKeyDown={keyDown}
            placeholder="What is being built"
          />
        ) : (
          <span className="flex items-center gap-2">
            <span className={cn("truncate", removed && "line-through")}>{row.description || "—"}</span>
            {row.status === "added" ? (
              <span className="shrink-0 border border-success/40 px-1 text-[9px] uppercase tracking-wide text-success">
                new
              </span>
            ) : null}
            {removed ? (
              <span className="shrink-0 border border-destructive/40 px-1 text-[9px] uppercase tracking-wide text-destructive">
                removed
              </span>
            ) : null}
          </span>
        )}
      </td>

      <td className="px-2 py-1">
        {live && (elevations ?? []).length > 0 ? (
          <Select value={draft.elevationId} onValueChange={(value) => onPatch({ elevationId: value })}>
            <SelectTrigger
              aria-label="Elevation"
              className="h-7 w-full rounded-none border-transparent px-1.5 text-[11px] shadow-none hover:border-input"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="base">Base</SelectItem>
              {(elevations ?? []).map((elevation) => (
                <SelectItem key={elevation.id} value={elevation.id}>
                  {elevation.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-[11px] text-muted-foreground">{elevationLabel}</span>
        )}
      </td>

      <td className="px-2 py-1 text-right">
        {live ? (
          <Input
            ref={quantityRef}
            aria-label="Quantity"
            inputMode="decimal"
            className={cn(
              CELL_INPUT,
              "text-right tabular-nums",
              (parseQuantity(draft.quantity) ?? -1) < 0 && "border-destructive/50",
            )}
            value={draft.quantity}
            onChange={(event) => onPatch({ quantity: event.target.value })}
            onKeyDown={keyDown}
          />
        ) : (
          <span className="tabular-nums">{row.quantity.toLocaleString()}</span>
        )}
      </td>

      <td className="px-2 py-1">
        {live ? (
          <Input
            aria-label="Unit of measure"
            className={cn(CELL_INPUT, !draft.uom.trim() && "border-destructive/50")}
            value={draft.uom}
            onChange={(event) => onPatch({ uom: event.target.value })}
            onKeyDown={keyDown}
          />
        ) : (
          <span className="text-muted-foreground">{row.uom}</span>
        )}
      </td>

      <td className="px-2 py-1">
        <div className="flex items-center justify-end gap-1.5">
          {live && !locked ? (
            <Input
              aria-label="Unit cost"
              inputMode="decimal"
              className={cn(
                CELL_INPUT,
                "text-right tabular-nums",
                draft.unitCostDollars.trim() !== "" &&
                  (parseMoneyCents(draft.unitCostDollars) ?? -1) < 0 &&
                  "border-destructive/50",
              )}
              value={draft.unitCostDollars}
              onChange={(event) => onPatch({ unitCostDollars: event.target.value })}
              onKeyDown={keyDown}
              placeholder={row.pricingSource === "cost_code_default" && row.unitCostCents != null
                ? (row.unitCostCents / 100).toFixed(2)
                : "0.00"}
            />
          ) : (
            <span className="tabular-nums text-muted-foreground">
              {row.unitCostCents == null ? "—" : (row.unitCostCents / 100).toFixed(2)}
            </span>
          )}
          {removed ? null : <SourceMark row={row} />}
        </div>
      </td>

      {comparison ? (
        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
          {row.comparisonAmountCents == null ? "—" : centsToDollars(row.comparisonAmountCents)}
        </td>
      ) : null}

      <td className="px-2 py-1 text-right tabular-nums">
        {removed ? "—" : centsToDollars(row.amountCents)}
      </td>

      {comparison ? (
        <td
          className={cn(
            "px-2 py-1 text-right tabular-nums",
            (row.deltaCents ?? 0) > 0
              ? "text-warning"
              : (row.deltaCents ?? 0) < 0
                ? "text-success"
                : "text-muted-foreground",
          )}
        >
          {row.deltaCents ? signedDollars(row.deltaCents) : "—"}
        </td>
      ) : null}

      {editable ? (
        <td className="px-2 py-1">
          {live ? (
            <div className="flex items-center justify-end gap-px opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 rounded-none text-muted-foreground"
                aria-label="Duplicate line"
                title="Duplicate line"
                onClick={onDuplicate}
              >
                <Copy className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 rounded-none text-muted-foreground hover:text-destructive"
                aria-label="Remove line"
                title="Remove line"
                onClick={onRemove}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </td>
      ) : null}
    </tr>
  )
}

function EmptyTakeoff({
  editable,
  comparisonVersion,
  costCodes,
  onCopy,
  onPaste,
  onAdd,
}: {
  editable: boolean
  comparisonVersion: HousePlanVersionDto | null
  costCodes: CostCode[]
  onCopy: () => void
  onPaste: () => void
  onAdd: (code: CostCode) => void
}) {
  const copyCount = comparisonVersion?.takeoff_lines?.length ?? 0
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-xs text-muted-foreground">
        No takeoff on this edition yet. The takeoff prices every house generated from this plan.
      </p>
      {editable ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
          {copyCount > 0 && comparisonVersion ? (
            <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-[11px]" onClick={onCopy}>
              <Copy className="mr-1 h-3.5 w-3.5" />
              Copy {copyCount} lines from v{comparisonVersion.version_number}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-[11px]" onClick={onPaste}>
            <Upload className="mr-1 h-3.5 w-3.5" />
            Paste from a spreadsheet
          </Button>
          <TakeoffCodePicker costCodes={costCodes} value={null} onSelect={onAdd}>
            <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]">
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add a line
            </Button>
          </TakeoffCodePicker>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Where the base price actually goes, at the community that holds the least back.
 * Margin as a picture rather than a percentage: the gross slice is what has to
 * cover indirects, financing, overhead and commission.
 */
function CostOfSales({ offering, buildCents }: { offering: OfferingRow[]; buildCents: number }) {
  const priced = offering.filter((row) => row.offered && row.priceCents != null && row.lotBasisCents != null)
  if (priced.length === 0 || buildCents <= 0) return null
  const weakest = priced.reduce((low, row) => ((row.marginPct ?? 0) < (low.marginPct ?? 0) ? row : low))
  const price = weakest.priceCents as number
  const lot = weakest.lotBasisCents as number
  const gross = price - buildCents - lot
  const band = marginBand(weakest.marginPct)
  const share = (cents: number) => Math.max((cents / price) * 100, 0)

  return (
    <div className="border-t px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Cost of sales at {weakest.communityName} — base price {centsToDollars(price)}
      </p>
      <div className="mt-2 flex h-7 w-full overflow-hidden border">
        <span
          className="flex items-center justify-center bg-primary/30 text-[10px] tabular-nums"
          style={{ width: `${share(buildCents)}%` }}
          title={`Build ${centsToDollars(buildCents)}`}
        >
          {share(buildCents) > 18 ? `Build ${centsToDollars(buildCents)}` : null}
        </span>
        <span
          className="flex items-center justify-center border-l bg-primary/15 text-[10px] tabular-nums text-muted-foreground"
          style={{ width: `${share(lot)}%` }}
          title={`Lot ${centsToDollars(lot)}`}
        >
          {share(lot) > 14 ? `Lot ${centsToDollars(lot)}` : null}
        </span>
        <span
          className={cn(
            "flex flex-1 items-center justify-center border-l text-[10px] tabular-nums",
            gross < 0 ? "bg-destructive/25" : MARGIN_BAND_META[band].fill,
          )}
          title={`Gross ${centsToDollars(gross)}`}
        >
          Gross {centsToDollars(gross)}
          {weakest.marginPct != null ? ` · ${Math.round(weakest.marginPct)}%` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Indirects, financing, overhead and sales commission come out of the gross slice — they run 12–16% of price.
      </p>
    </div>
  )
}
