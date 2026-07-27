"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { ChevronDown, ChevronRight, Plus, Save, Upload, X } from "@/components/icons"
import { replaceTakeoffLinesAction } from "@/app/(app)/plans/actions"
import { centsToDollars, signedDollars } from "@/components/plans/plan-badges"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { CostType } from "@/lib/cost-types"
import { buildBill, type BillRow } from "@/lib/plans/bill"
import { marginBand, MARGIN_BAND_META } from "@/lib/plans/margin"
import type { OfferingRow } from "@/lib/plans/offering"
import type { HousePlanDto, HousePlanVersionDto, PlanVersionPricingDto } from "@/lib/services/house-plans"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"

type TakeoffDraft = {
  lineId: string | null
  costCodeId: string
  costType: CostType | null
  description: string
  quantity: string
  uom: string
  unitCostDollars: string
  elevationId: string
}

function toDrafts(version: HousePlanVersionDto): TakeoffDraft[] {
  return (version.takeoff_lines ?? []).map((line) => ({
    lineId: line.id,
    costCodeId: line.cost_code_id,
    costType: line.cost_type,
    description: line.description,
    quantity: String(line.quantity),
    uom: line.uom,
    unitCostDollars: line.unit_cost_cents == null ? "" : (line.unit_cost_cents / 100).toFixed(2),
    elevationId: line.elevation_id ?? "base",
  }))
}

/**
 * The takeoff as a cost document rather than a form: grouped into the divisions an
 * estimator argues in, and always positioned against the edition currently being
 * built. Approving a release is then an act of reading a diff instead of an act of
 * faith — which is the whole reason the numbers on this page can be trusted.
 */
export function PlanBill({
  plan,
  version,
  comparisonVersion,
  costCodes,
  pricing,
  offering,
  editable,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  comparisonVersion: HousePlanVersionDto | null
  costCodes: CostCode[]
  pricing: PlanVersionPricingDto | null
  offering: OfferingRow[]
  editable: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [takeoff, setTakeoff] = useState<TakeoffDraft[]>(() => toDrafts(version))
  const [editing, setEditing] = useState(false)
  const [changedOnly, setChangedOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [elevationFilter, setElevationFilter] = useState("all")
  const [importing, setImporting] = useState(false)
  const [csvTakeoff, setCsvTakeoff] = useState("")

  const pricingByLine = useMemo(
    () => new Map((pricing?.lines ?? []).map((line) => [line.line_id, line])),
    [pricing],
  )
  const dirty = useMemo(() => JSON.stringify(takeoff) !== JSON.stringify(toDrafts(version)), [takeoff, version])

  const bill = useMemo(
    () =>
      buildBill({
        lines: takeoff.map((line, index) => {
          const resolved = line.lineId ? pricingByLine.get(line.lineId) : undefined
          return {
            lineId: line.lineId,
            index,
            costCodeId: line.costCodeId,
            description: line.description,
            uom: line.uom,
            quantity: Number(line.quantity) || 0,
            unitCostCents: line.unitCostDollars === "" ? null : Math.round(Number(line.unitCostDollars) * 100),
            elevationId: line.elevationId === "base" ? null : line.elevationId,
            // While the draft is being edited the resolved price is stale for any
            // line whose quantity just changed, so manual math wins mid-edit.
            resolvedAmountCents: editing || !resolved ? null : resolved.amount_cents,
            unpriced: resolved?.source === "unpriced",
          }
        }),
        comparisonLines: comparisonVersion?.takeoff_lines ?? null,
        costCodes,
      }),
    [takeoff, pricingByLine, comparisonVersion, costCodes, editing],
  )

  const elevations = plan.elevations ?? []
  const elevationLabel = (elevationId: string | null) =>
    elevationId == null ? "Base" : elevations.find((item) => item.id === elevationId)?.code ?? "—"

  const visibleDivisions = useMemo(
    () =>
      bill.divisions
        .map((division) => ({
          ...division,
          rows: division.rows.filter((row) => {
            if (changedOnly && row.status === "same") return false
            if (elevationFilter === "all") return true
            if (elevationFilter === "base") return row.elevationId === null
            return row.elevationId === elevationFilter
          }),
        }))
        .filter((division) => division.rows.length > 0),
    [bill, changedOnly, elevationFilter],
  )

  const heatedSqft = plan.heated_sqft
  const costPerSqft = heatedSqft ? Math.round(bill.amountCents / 100 / heatedSqft) : null

  function patch(index: number, patchValue: Partial<TakeoffDraft>) {
    setTakeoff((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patchValue } : item)))
  }

  function addLine() {
    setTakeoff((current) => [
      ...current,
      {
        lineId: null,
        costCodeId: costCodes[0]?.id ?? "",
        costType: costCodes[0]?.cost_type ?? null,
        description: "",
        quantity: "1",
        uom: costCodes[0]?.unit ?? "ea",
        unitCostDollars: "",
        elevationId: elevationFilter === "all" || elevationFilter === "base" ? "base" : elevationFilter,
      },
    ])
  }

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(
          await replaceTakeoffLinesAction(
            plan.id,
            version.id,
            takeoff
              .filter((line) => line.costCodeId && line.description.trim() && line.uom.trim())
              .map((line) => ({
                costCodeId: line.costCodeId,
                costType: line.costType,
                description: line.description,
                quantity: Number(line.quantity) || 0,
                uom: line.uom,
                unitCostCents: line.unitCostDollars === "" ? null : Math.round(Number(line.unitCostDollars) * 100),
                elevationId: line.elevationId === "base" ? null : line.elevationId,
              })),
          ),
        )
        toast.success("Takeoff saved")
        setEditing(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save takeoff", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function importCsv() {
    try {
      const parsed = csvTakeoff
        .split(/\r?\n/)
        .map((row) => row.trim())
        .filter(Boolean)
        .map((row, index) => {
          const [elevationValue = "base", costCodeValue = "", description = "", quantity = "0", uom = "ea", unitCost = ""] =
            row.split(",").map((cell) => cell.trim())
          const costCode = costCodes.find(
            (code) => code.id === costCodeValue || code.code.toLowerCase() === costCodeValue.toLowerCase(),
          )
          const elevation = elevations.find(
            (item) => item.id === elevationValue || item.code.toLowerCase() === elevationValue.toLowerCase(),
          )
          if (!costCode || !description) throw new Error(`CSV row ${index + 1}: cost code and description are required`)
          if (elevationValue.toLowerCase() !== "base" && !elevation) {
            throw new Error(`CSV row ${index + 1}: elevation was not found`)
          }
          return {
            lineId: null,
            costCodeId: costCode.id,
            costType: costCode.cost_type ?? null,
            description,
            quantity,
            uom: uom || "ea",
            unitCostDollars: unitCost,
            elevationId: elevation?.id ?? "base",
          } satisfies TakeoffDraft
        })
      setTakeoff((current) => [...current, ...parsed])
      setCsvTakeoff("")
      setImporting(false)
      setEditing(true)
      toast.success(`${parsed.length} takeoff line${parsed.length === 1 ? "" : "s"} imported — save to keep them`)
    } catch (error) {
      toast.error("CSV import failed", { description: error instanceof Error ? error.message : undefined })
    }
  }

  function toggleDivision(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const columnCount = editing ? 6 : comparisonVersion ? 5 : 3

  return (
    <section className="border-b">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-4 pb-2 pt-3.5">
        <div>
          <h3 className="text-sm font-medium">The bill</h3>
          <p className="text-[11px] text-muted-foreground">
            What one house costs before anyone marks it up. Base lines apply to every elevation; elevation lines are
            deltas on top.
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
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-y bg-muted/30 px-4 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {comparisonVersion ? (
            <Button
              size="sm"
              variant={changedOnly ? "secondary" : "ghost"}
              aria-pressed={changedOnly}
              className={cn(
                "h-7 rounded-none px-2 text-[11px]",
                changedOnly ? "border border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground",
              )}
              onClick={() => setChangedOnly((current) => !current)}
            >
              Only what changed vs v{comparisonVersion.version_number}
              {bill.changedCount > 0 ? <span className="ml-1.5 tabular-nums">{bill.changedCount}</span> : null}
            </Button>
          ) : null}
          {elevations.length > 0 ? (
            <Select value={elevationFilter} onValueChange={setElevationFilter}>
              <SelectTrigger className="h-7 w-36 rounded-none text-[11px]">
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
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {bill.lineCount} {bill.lineCount === 1 ? "line" : "lines"} · {bill.divisions.length}{" "}
            {bill.divisions.length === 1 ? "division" : "divisions"}
            {bill.unpricedCount > 0 ? (
              <span className="ml-1.5 text-destructive">{bill.unpricedCount} unpriced</span>
            ) : null}
          </span>
        </div>

        {editable ? (
          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-none px-2 text-[11px]"
                  onClick={() => setImporting(true)}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import CSV
                </Button>
                <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-[11px]" onClick={addLine}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Line
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-none px-2 text-[11px]"
                  onClick={() => {
                    setTakeoff(toDrafts(version))
                    setEditing(false)
                  }}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button size="sm" className="h-7 rounded-none px-2 text-[11px]" onClick={save} disabled={pending || !dirty}>
                  <Save className="mr-1 h-3.5 w-3.5" />
                  {pending ? "Saving…" : "Save takeoff"}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-none px-2 text-[11px]"
                onClick={() => setEditing(true)}
              >
                Edit takeoff
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {bill.lineCount === 0 && bill.divisions.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          No takeoff on this edition yet. The takeoff prices every house generated from this plan — add lines or import a
          CSV.
        </p>
      ) : visibleDivisions.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {changedOnly ? "Nothing has changed against the released edition." : "No lines match this elevation filter."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          {/* Editing adds four controls per row; below this the description field
              collapses, so the table scrolls rather than squeezing. */}
          <table className={cn("w-full text-xs", editing && "min-w-[1080px]")}>
            <thead>
              <tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-1.5 text-left font-medium">Line</th>
                {editing ? <th className="w-20 px-2 py-1.5 text-right font-medium">Qty</th> : null}
                {editing ? <th className="w-16 px-2 py-1.5 text-left font-medium">UOM</th> : null}
                {editing ? <th className="w-28 px-2 py-1.5 text-right font-medium">Unit cost</th> : null}
                {!editing ? <th className="w-24 px-2 py-1.5 text-right font-medium">Qty</th> : null}
                {comparisonVersion ? (
                  <th className="w-28 px-2 py-1.5 text-right font-medium">v{comparisonVersion.version_number}</th>
                ) : null}
                <th className="w-28 px-2 py-1.5 text-right font-medium">
                  {comparisonVersion ? `v${version.version_number}` : "Amount"}
                </th>
                {comparisonVersion ? <th className="w-28 px-2 py-1.5 text-right font-medium">Δ</th> : null}
                {editing ? <th className="w-8 px-2 py-1.5" /> : null}
              </tr>
            </thead>

            {visibleDivisions.map((division) => {
              const isCollapsed = collapsed.has(division.key)
              return (
                <tbody key={division.key}>
                  <tr className="border-y bg-muted/40">
                    <td className="px-4 py-1.5" colSpan={editing ? 4 : comparisonVersion ? 2 : 2}>
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
                          <span className="block h-full bg-primary/60" style={{ width: `${division.sharePct}%` }} />
                        </span>
                        {division.unpricedCount > 0 ? (
                          <span className="ml-1 text-[10px] text-destructive">{division.unpricedCount} unpriced</span>
                        ) : null}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-right text-[11px] font-medium tabular-nums">
                      {centsToDollars(division.amountCents)}
                    </td>
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
                    {editing ? <td /> : null}
                  </tr>

                  {isCollapsed
                    ? null
                    : division.rows.map((row) =>
                        editing && row.index >= 0 ? (
                          <EditRow
                            key={row.key}
                            row={row}
                            draft={takeoff[row.index]}
                            costCodes={costCodes}
                            elevations={elevations}
                            comparison={Boolean(comparisonVersion)}
                            onPatch={(value) => patch(row.index, value)}
                            onRemove={() =>
                              setTakeoff((current) => current.filter((_, itemIndex) => itemIndex !== row.index))
                            }
                          />
                        ) : (
                          <ReadRow
                            key={row.key}
                            row={row}
                            elevationLabel={elevationLabel(row.elevationId)}
                            comparison={Boolean(comparisonVersion)}
                            editing={editing}
                          />
                        ),
                      )}
                </tbody>
              )
            })}

            <tfoot>
              <tr className="border-t font-medium">
                <td className="px-4 py-2" colSpan={editing ? 4 : comparisonVersion ? 2 : 2}>
                  <span className="text-muted-foreground">
                    {bill.lineCount} {bill.lineCount === 1 ? "line" : "lines"}
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
                {editing ? <td /> : null}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <CostOfSales offering={offering} buildCents={bill.amountCents} />

      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import takeoff lines</DialogTitle>
            <DialogDescription>
              One line per row. Imported lines are appended to the draft — nothing is saved until you save the takeoff.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={csvTakeoff}
            onChange={(event) => setCsvTakeoff(event.target.value)}
            placeholder={"elevation, cost code, description, quantity, uom, unit cost\nbase, 06100, Wall framing, 1, ls, 24500"}
            className="min-h-40 rounded-none font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setImporting(false)}>
              Cancel
            </Button>
            <Button className="rounded-none" onClick={importCsv} disabled={!csvTakeoff.trim()}>
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function ReadRow({
  row,
  elevationLabel,
  comparison,
  editing,
}: {
  row: BillRow
  elevationLabel: string
  comparison: boolean
  editing: boolean
}) {
  const unchanged = row.status === "same"
  return (
    <tr className={cn("border-b border-border/60", unchanged && comparison && "text-muted-foreground")}>
      <td className="px-4 py-1.5" colSpan={editing ? 4 : 1}>
        <span className="font-mono text-[10px] text-muted-foreground">{row.costCode}</span>
        <span className={cn("ml-2", row.status === "removed" && "line-through")}>{row.description || "—"}</span>
        {row.elevationId ? (
          <span className="ml-2 border px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
            {elevationLabel}
          </span>
        ) : null}
        {row.status === "added" ? (
          <span className="ml-2 border border-success/40 px-1 py-px text-[9px] uppercase tracking-wide text-success">
            new
          </span>
        ) : null}
        {row.status === "removed" ? (
          <span className="ml-2 border border-destructive/40 px-1 py-px text-[9px] uppercase tracking-wide text-destructive">
            removed
          </span>
        ) : null}
        {row.unpriced ? (
          <span className="ml-2 border border-destructive/40 px-1 py-px text-[9px] uppercase tracking-wide text-destructive">
            unpriced
          </span>
        ) : null}
      </td>
      {!editing ? (
        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
          {row.quantity.toLocaleString()} {row.uom}
        </td>
      ) : null}
      {comparison ? (
        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
          {row.comparisonAmountCents == null ? "—" : centsToDollars(row.comparisonAmountCents)}
        </td>
      ) : null}
      <td className="px-2 py-1.5 text-right tabular-nums">
        {row.status === "removed" ? "—" : centsToDollars(row.amountCents)}
      </td>
      {comparison ? (
        <td
          className={cn(
            "px-2 py-1.5 text-right tabular-nums",
            (row.deltaCents ?? 0) > 0 ? "text-warning" : (row.deltaCents ?? 0) < 0 ? "text-success" : "text-muted-foreground",
          )}
        >
          {row.deltaCents ? signedDollars(row.deltaCents) : "—"}
        </td>
      ) : null}
      {editing ? <td /> : null}
    </tr>
  )
}

function EditRow({
  row,
  draft,
  costCodes,
  elevations,
  comparison,
  onPatch,
  onRemove,
}: {
  row: BillRow
  draft: TakeoffDraft | undefined
  costCodes: CostCode[]
  elevations: HousePlanDto["elevations"]
  comparison: boolean
  onPatch: (value: Partial<TakeoffDraft>) => void
  onRemove: () => void
}) {
  if (!draft) return null
  return (
    <tr className="border-b border-border/60">
      <td className="min-w-[26rem] px-4 py-1">
        <div className="flex items-center gap-1.5">
          <Select value={draft.elevationId} onValueChange={(value) => onPatch({ elevationId: value })}>
            <SelectTrigger className="h-7 w-[4.5rem] shrink-0 rounded-none text-[11px]">
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
          <Select
            value={draft.costCodeId}
            onValueChange={(value) =>
              onPatch({ costCodeId: value, costType: costCodes.find((code) => code.id === value)?.cost_type ?? null })
            }
          >
            <SelectTrigger className="h-7 w-40 shrink-0 rounded-none text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {costCodes.map((code) => (
                <SelectItem key={code.id} value={code.id}>
                  {code.code} · {code.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Description"
            className="h-7 w-full min-w-[9rem] rounded-none text-[11px]"
            value={draft.description}
            onChange={(event) => onPatch({ description: event.target.value })}
          />
        </div>
      </td>
      <td className="px-2 py-1">
        <Input
          aria-label="Quantity"
          inputMode="decimal"
          className="h-7 rounded-none text-right text-[11px] tabular-nums"
          value={draft.quantity}
          onChange={(event) => onPatch({ quantity: event.target.value })}
        />
      </td>
      <td className="px-2 py-1">
        <Input
          aria-label="Unit of measure"
          className="h-7 rounded-none text-[11px]"
          value={draft.uom}
          onChange={(event) => onPatch({ uom: event.target.value })}
        />
      </td>
      <td className="px-2 py-1">
        <Input
          aria-label="Unit cost"
          inputMode="decimal"
          className="h-7 rounded-none text-right text-[11px] tabular-nums"
          value={draft.unitCostDollars}
          onChange={(event) => onPatch({ unitCostDollars: event.target.value })}
          placeholder="0.00"
        />
      </td>
      {comparison ? (
        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
          {row.comparisonAmountCents == null ? "—" : centsToDollars(row.comparisonAmountCents)}
        </td>
      ) : null}
      <td className="px-2 py-1 text-right tabular-nums">{centsToDollars(row.amountCents)}</td>
      {comparison ? (
        <td
          className={cn(
            "px-2 py-1 text-right tabular-nums",
            (row.deltaCents ?? 0) > 0 ? "text-warning" : (row.deltaCents ?? 0) < 0 ? "text-success" : "text-muted-foreground",
          )}
        >
          {row.deltaCents ? signedDollars(row.deltaCents) : "—"}
        </td>
      ) : null}
      <td className="px-2 py-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 rounded-none text-muted-foreground hover:text-destructive"
          aria-label="Remove line"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
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
