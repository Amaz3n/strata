"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Plus, Save, X } from "@/components/icons"
import { replaceTakeoffLinesAction } from "@/app/(app)/plans/actions"
import { PricingSourceBadge, centsToMoney } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { CostType } from "@/lib/cost-types"
import type { HousePlanDto, HousePlanVersionDto, PlanVersionPricingDto } from "@/lib/services/house-plans"
import type { CostCode } from "@/lib/types"

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

function draftAmountCents(line: TakeoffDraft): number {
  return Math.round((Number(line.quantity) || 0) * (Number(line.unitCostDollars) || 0) * 100)
}

export function PlanTakeoffTab({
  plan,
  version,
  costCodes,
  pricing,
  editable,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  costCodes: CostCode[]
  pricing: PlanVersionPricingDto | null
  editable: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [takeoff, setTakeoff] = useState<TakeoffDraft[]>(() => toDrafts(version))
  const [elevationFilter, setElevationFilter] = useState("all")
  const [csvTakeoff, setCsvTakeoff] = useState("")
  const pricingByLine = useMemo(() => new Map((pricing?.lines ?? []).map((line) => [line.line_id, line])), [pricing])

  const visible = useMemo(
    () => takeoff.map((line, index) => ({ line, index })).filter(({ line }) => elevationFilter === "all" || line.elevationId === elevationFilter),
    [takeoff, elevationFilter],
  )
  const manualTotal = useMemo(() => takeoff.reduce((sum, line) => sum + draftAmountCents(line), 0), [takeoff])
  const dirty = useMemo(() => JSON.stringify(takeoff) !== JSON.stringify(toDrafts(version)), [takeoff, version])

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
        elevationId: elevationFilter === "all" ? "base" : elevationFilter,
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
          const [elevationValue = "base", costCodeValue = "", description = "", quantity = "0", uom = "ea", unitCost = ""] = row
            .split(",")
            .map((cell) => cell.trim())
          const costCode = costCodes.find(
            (code) => code.id === costCodeValue || code.code.toLowerCase() === costCodeValue.toLowerCase(),
          )
          const elevation = (plan.elevations ?? []).find(
            (item) => item.id === elevationValue || item.code.toLowerCase() === elevationValue.toLowerCase(),
          )
          if (!costCode || !description) throw new Error(`CSV row ${index + 1}: cost code and description are required`)
          if (elevationValue.toLowerCase() !== "base" && !elevation) throw new Error(`CSV row ${index + 1}: elevation was not found`)
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
      toast.success(`${parsed.length} takeoff line${parsed.length === 1 ? "" : "s"} imported`)
    } catch (error) {
      toast.error("CSV import failed", { description: error instanceof Error ? error.message : undefined })
    }
  }

  const showPricing = pricing !== null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={elevationFilter} onValueChange={setElevationFilter}>
            <SelectTrigger className="h-8 w-40 rounded-none text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All elevations</SelectItem>
              <SelectItem value="base">Base only</SelectItem>
              {(plan.elevations ?? []).map((elevation) => (
                <SelectItem key={elevation.id} value={elevation.id}>{elevation.code} deltas</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">Base lines apply to every elevation; elevation rows are deltas on top.</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums">
            Manual {centsToMoney(manualTotal)}
            {showPricing ? <span className="text-muted-foreground"> · Price book {centsToMoney(pricing.resolved_total_cents)}</span> : null}
          </span>
          {editable ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="rounded-none" onClick={addLine}>
                <Plus className="mr-1 h-4 w-4" />
                Line
              </Button>
              <Button size="sm" className="rounded-none" onClick={save} disabled={pending || !dirty}>
                <Save className="mr-1 h-4 w-4" />
                {pending ? "Saving…" : "Save takeoff"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {editable ? (
        <div className="grid gap-2 border p-3 sm:grid-cols-[1fr_auto]">
          <Textarea
            value={csvTakeoff}
            onChange={(event) => setCsvTakeoff(event.target.value)}
            placeholder={"Paste CSV: elevation, cost code, description, quantity, uom, unit cost\nbase, 06100, Wall framing, 1, ls, 24500"}
            className="min-h-20 rounded-none font-mono text-xs"
          />
          <Button variant="outline" size="sm" className="self-end rounded-none" onClick={importCsv} disabled={!csvTakeoff.trim()}>
            Import CSV
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead className="w-28">Elevation</TableHead>
              <TableHead className="w-56">Cost code</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-20 text-right">Qty</TableHead>
              <TableHead className="w-20">UOM</TableHead>
              <TableHead className="w-32 text-right">Unit cost</TableHead>
              {showPricing ? <TableHead className="w-40 text-right">Price book</TableHead> : null}
              <TableHead className="w-32 text-right">Total</TableHead>
              {editable ? <TableHead className="w-10" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={showPricing ? 9 : 8} className="h-32 text-center text-xs text-muted-foreground">
                  {takeoff.length === 0
                    ? "No takeoff lines on this version. Add lines or paste a CSV — the takeoff prices every start generated from this plan."
                    : "No lines for this elevation filter."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map(({ line, index }) => {
                const resolved = line.lineId ? pricingByLine.get(line.lineId) : undefined
                return (
                  <TableRow key={line.lineId ?? `new-${index}`} className="text-xs">
                    <TableCell>
                      <Select disabled={!editable} value={line.elevationId} onValueChange={(value) => patch(index, { elevationId: value })}>
                        <SelectTrigger className="h-8 w-24 rounded-none text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="base">Base</SelectItem>
                          {(plan.elevations ?? []).map((elevation) => (
                            <SelectItem key={elevation.id} value={elevation.id}>{elevation.code}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        disabled={!editable}
                        value={line.costCodeId}
                        onValueChange={(value) =>
                          patch(index, { costCodeId: value, costType: costCodes.find((code) => code.id === value)?.cost_type ?? null })
                        }
                      >
                        <SelectTrigger className="h-8 w-52 rounded-none text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {costCodes.map((code) => (
                            <SelectItem key={code.id} value={code.id}>{code.code} · {code.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input disabled={!editable} className="h-8 rounded-none text-xs" value={line.description} onChange={(event) => patch(index, { description: event.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input disabled={!editable} inputMode="decimal" className="h-8 rounded-none text-right text-xs tabular-nums" value={line.quantity} onChange={(event) => patch(index, { quantity: event.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input disabled={!editable} className="h-8 rounded-none text-xs" value={line.uom} onChange={(event) => patch(index, { uom: event.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input disabled={!editable} inputMode="decimal" className="h-8 rounded-none text-right text-xs tabular-nums" value={line.unitCostDollars} onChange={(event) => patch(index, { unitCostDollars: event.target.value })} placeholder="0.00" />
                    </TableCell>
                    {showPricing ? (
                      <TableCell className="text-right">
                        {resolved ? (
                          <span className="inline-flex items-center gap-1.5">
                            <PricingSourceBadge source={resolved.source} />
                            <span className="tabular-nums" title={resolved.vendor_name ?? undefined}>
                              {resolved.source === "unpriced" ? "—" : centsToMoney(resolved.resolved_unit_cost_cents)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{line.lineId ? "—" : "Save first"}</span>
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">{centsToMoney(draftAmountCents(line))}</TableCell>
                    {editable ? (
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 rounded-none text-muted-foreground hover:text-destructive"
                          aria-label="Remove line"
                          onClick={() => setTakeoff((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })
            )}
          </TableBody>
          {takeoff.length > 0 ? (
            <TableFooter>
              <TableRow className="text-xs">
                <TableCell colSpan={6} className="font-medium">
                  {takeoff.length} lines
                  {showPricing && pricing.unpriced_line_count > 0 ? (
                    <span className="ml-2 font-normal text-destructive">{pricing.unpriced_line_count} unpriced</span>
                  ) : null}
                </TableCell>
                {showPricing ? <TableCell className="text-right tabular-nums font-medium">{centsToMoney(pricing.resolved_total_cents)}</TableCell> : null}
                <TableCell className="text-right tabular-nums font-medium">{centsToMoney(manualTotal)}</TableCell>
                {editable ? <TableCell /> : null}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </div>
  )
}
