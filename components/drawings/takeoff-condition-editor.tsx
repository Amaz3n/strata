"use client"

/**
 * Create / edit a takeoff condition.
 *
 * The rate field is the interesting part: instead of an empty box, it offers
 * what this builder has actually paid for that cost code across their own jobs
 * (lib/services/takeoff-pricing.ts), with the evidence one click away. A code
 * with no history quietly falls back to its default — no invented numbers.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Check, ChevronDown, Loader2, Search } from "lucide-react"

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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import { MEASURE_UOMS, MEASURE_UOM_LABELS, type MeasureUom } from "@/lib/drawings/measure"
import { CONDITION_PALETTE } from "@/lib/drawings/takeoff-palette"
import type { TakeoffCondition } from "@/lib/services/takeoff"
import type { CostCodeRateHistory } from "@/lib/services/takeoff-pricing"
import {
  createTakeoffConditionAction,
  getCostCodeRateHistoryAction,
  listTakeoffCostCodesAction,
  updateTakeoffConditionAction,
} from "@/app/(app)/drawings/takeoff-actions"

interface CostCodeOption {
  id: string
  code: string
  name: string
  unit: string | null
  default_unit_cost_cents: number | null
}

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

/** Rates are shown to the cent — $4.05/SF, not $4/SF. */
const rate = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })

export interface ConditionEditorDialogProps {
  open: boolean
  /** Null = create. */
  condition: TakeoffCondition | null
  scope: { project_id: string } | { house_plan_version_id: string }
  onOpenChange: (open: boolean) => void
  onSaved: (condition: TakeoffCondition) => void
}

export function ConditionEditorDialog({
  open,
  condition,
  scope,
  onOpenChange,
  onSaved,
}: ConditionEditorDialogProps) {
  const isEdit = !!condition

  const [name, setName] = useState(condition?.name ?? "")
  const [uom, setUom] = useState<MeasureUom>((condition?.uom as MeasureUom) ?? "sf")
  const [color, setColor] = useState(condition?.color ?? CONDITION_PALETTE[0].hex)
  const [costCodeId, setCostCodeId] = useState<string | null>(condition?.cost_code_id ?? null)
  const [wastePct, setWastePct] = useState(String(condition?.waste_pct ?? 0))
  const [rateDollars, setRateDollars] = useState(
    condition?.unit_cost_cents != null ? (condition.unit_cost_cents / 100).toFixed(2) : "",
  )
  const [shareWithClients, setShareWithClients] = useState(condition?.share_with_clients ?? false)
  const [notes, setNotes] = useState(condition?.notes ?? "")
  const [saving, setSaving] = useState(false)

  const [costCodes, setCostCodes] = useState<CostCodeOption[] | null>(null)
  const [history, setHistory] = useState<CostCodeRateHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    listTakeoffCostCodesAction()
      .then((codes) => {
        if (!cancelled) setCostCodes(codes)
      })
      .catch(() => {
        if (!cancelled) setCostCodes([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Rate history follows the selected cost code, not the condition — picking a
  // code is the moment an estimator wants to know what it has been costing.
  useEffect(() => {
    if (!costCodeId) {
      setHistory(null)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    getCostCodeRateHistoryAction(costCodeId)
      .then((result) => {
        if (cancelled) return
        setHistory(result.success ? result.data : null)
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [costCodeId])

  const selectedCode = useMemo(
    () => costCodes?.find((code) => code.id === costCodeId) ?? null,
    [costCodes, costCodeId],
  )

  const handleSave = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Give the condition a name")
      return
    }

    const parsedWaste = Number(wastePct)
    if (!Number.isFinite(parsedWaste) || parsedWaste < 0 || parsedWaste > 100) {
      toast.error("Waste must be between 0 and 100%")
      return
    }

    const parsedRate = rateDollars.trim() === "" ? null : Number(rateDollars)
    if (parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0)) {
      toast.error("Enter a rate like 4.05, or leave it blank to use the cost code default")
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: trimmed,
        cost_code_id: costCodeId,
        color,
        waste_pct: parsedWaste,
        unit_cost_cents: parsedRate === null ? null : Math.round(parsedRate * 100),
        share_with_clients: shareWithClients,
        notes: notes.trim() || null,
      }

      const saved = isEdit
        ? unwrapAction(await updateTakeoffConditionAction(condition!.id, payload))
        : unwrapAction(await createTakeoffConditionAction({ ...scope, ...payload, uom }))

      toast.success(isEdit ? "Condition updated" : `"${saved.name}" ready — measure it on the sheet`)
      onSaved(saved)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save condition")
    } finally {
      setSaving(false)
    }
  }, [
    name,
    wastePct,
    rateDollars,
    costCodeId,
    color,
    shareWithClients,
    notes,
    isEdit,
    condition,
    scope,
    uom,
    onSaved,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit condition" : "New condition"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "The unit can't change — measurements already belong to it."
              : "Name what you price, pick how it measures, then trace it on the sheet."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="condition-name">Name</Label>
            <Input
              id="condition-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="LVP flooring"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Measures in</Label>
              <div className="flex gap-1">
                {MEASURE_UOMS.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={uom === option ? "secondary" : "outline"}
                    className="flex-1"
                    disabled={isEdit}
                    onClick={() => setUom(option)}
                  >
                    {MEASURE_UOM_LABELS[option]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Color on the sheet</Label>
              <div className="flex flex-wrap gap-1">
                {CONDITION_PALETTE.map((entry) => (
                  <button
                    key={entry.hex}
                    type="button"
                    aria-label={entry.label}
                    aria-pressed={color === entry.hex}
                    onClick={() => setColor(entry.hex)}
                    className={cn(
                      "h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                      color === entry.hex && "ring-2 ring-foreground",
                    )}
                    style={{ backgroundColor: entry.hex }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Cost code</Label>
            <CostCodePicker
              costCodes={costCodes}
              selected={selectedCode}
              onSelect={(code) => {
                setCostCodeId(code?.id ?? null)
                // Adopting a code's default is a courtesy, not an override:
                // only fill an empty rate field.
                if (code?.default_unit_cost_cents && rateDollars.trim() === "") {
                  setRateDollars((code.default_unit_cost_cents / 100).toFixed(2))
                }
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="condition-rate">
                Rate per {MEASURE_UOM_LABELS[uom]}
              </Label>
              <Input
                id="condition-rate"
                value={rateDollars}
                onChange={(event) => setRateDollars(event.target.value)}
                placeholder={
                  selectedCode?.default_unit_cost_cents
                    ? (selectedCode.default_unit_cost_cents / 100).toFixed(2)
                    : "0.00"
                }
                inputMode="decimal"
                className="tabular-nums"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="condition-waste">Waste %</Label>
              <Input
                id="condition-waste"
                value={wastePct}
                onChange={(event) => setWastePct(event.target.value)}
                inputMode="decimal"
                className="tabular-nums"
              />
            </div>
          </div>

          <RateSuggestion
            history={history}
            loading={historyLoading}
            uom={uom}
            onAccept={(cents) => setRateDollars((cents / 100).toFixed(2))}
          />

          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div>
              <Label htmlFor="condition-share" className="text-sm">
                Show on the client estimate
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Lets the client tap the estimate line and see this geometry on the plan.
              </p>
            </div>
            <Switch
              id="condition-share"
              checked={shareWithClients}
              onCheckedChange={setShareWithClients}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="condition-notes">Notes</Label>
            <Textarea
              id="condition-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              placeholder="Assumptions, exclusions, who to call"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save" : "Create condition"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "You've paid $4.05–$4.30/SF across 6 jobs." Silent when there is no history
 * — an empty band is more honest than a fabricated one.
 */
function RateSuggestion({
  history,
  loading,
  uom,
  onAccept,
}: {
  history: CostCodeRateHistory | null
  loading: boolean
  uom: MeasureUom
  onAccept: (cents: number) => void
}) {
  const [showEvidence, setShowEvidence] = useState(false)

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking what you&apos;ve paid…
      </div>
    )
  }

  if (!history || !history.visible || history.sample_count === 0 || history.median_cents === null) {
    return null
  }

  const unitMismatch = history.unit && history.unit.toLowerCase() !== uom
  const lastDate = history.evidence[0]?.dated

  return (
    <div className="border bg-muted/40 p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs">
            You&apos;ve paid{" "}
            <span className="font-medium tabular-nums">
              {rate(history.p25_cents ?? history.median_cents)}–
              {rate(history.p75_cents ?? history.median_cents)}
            </span>{" "}
            per {history.unit?.toUpperCase() ?? MEASURE_UOM_LABELS[uom]} across {history.sample_count}{" "}
            record{history.sample_count === 1 ? "" : "s"}
            {lastDate ? ` · last ${new Date(lastDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}` : ""}
          </p>
          {unitMismatch && (
            <p className="mt-1 text-[11px] text-warning">
              Those records are priced per {history.unit?.toUpperCase()} — this condition measures in{" "}
              {MEASURE_UOM_LABELS[uom]}.
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 tabular-nums"
          onClick={() => onAccept(history.median_cents as number)}
        >
          Use {rate(history.median_cents)}
        </Button>
      </div>

      <button
        type="button"
        className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setShowEvidence((prev) => !prev)}
      >
        {showEvidence ? "Hide" : "Show"} the {history.evidence.length} most recent
      </button>

      {showEvidence && (
        <ul className="mt-1.5 space-y-0.5">
          {history.evidence.map((sample, index) => (
            <li key={index} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate text-muted-foreground">
                {sample.vendor_name ?? "—"}
                {sample.context_label ? ` · ${sample.context_label}` : ""}
                {sample.source === "price_agreement" ? " · agreement" : ""}
              </span>
              <span className="shrink-0 tabular-nums">
                {rate(sample.unit_cost_cents)}
                {sample.unit ? `/${sample.unit.toUpperCase()}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CostCodePicker({
  costCodes,
  selected,
  onSelect,
}: {
  costCodes: CostCodeOption[] | null
  selected: CostCodeOption | null
  onSelect: (code: CostCodeOption | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    if (!costCodes) return []
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? costCodes.filter(
          (code) =>
            code.code.toLowerCase().includes(needle) || code.name.toLowerCase().includes(needle),
        )
      : costCodes
    return matches.slice(0, 100)
  }, [costCodes, query])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? `${selected.code} — ${selected.name}` : "No cost code"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search cost codes"
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <ScrollArea className="h-64">
          {costCodes === null ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No cost code matches &ldquo;{query}&rdquo;
            </div>
          ) : (
            <ul className="py-1">
              <li>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onSelect(null)
                    setOpen(false)
                  }}
                >
                  <Check className={cn("h-3.5 w-3.5", selected ? "opacity-0" : "opacity-100")} />
                  <span className="text-muted-foreground">No cost code</span>
                </button>
              </li>
              {filtered.map((code) => (
                <li key={code.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      onSelect(code)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        selected?.id === code.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="shrink-0 tabular-nums text-muted-foreground">{code.code}</span>
                    <span className="truncate">{code.name}</span>
                    {code.default_unit_cost_cents != null && (
                      <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
                        {money(code.default_unit_cost_cents)}
                        {code.unit ? `/${code.unit.toUpperCase()}` : ""}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
