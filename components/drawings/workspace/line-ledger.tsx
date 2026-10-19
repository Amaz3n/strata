"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateTakeoffConditionAction } from "@/app/(app)/drawings/takeoff-actions";
import type { DrawingMarkup } from "@/app/(app)/drawings/types";
import { unwrapAction } from "@/lib/action-result";
import { formatQuantity, MEASURE_UOM_LABELS } from "@/lib/drawings/measure";
import { money } from "@/lib/precon/format";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { cn } from "@/lib/utils";

import { Segmented } from "./segmented";

/** Measuring one pricing line: the line sits beside the sheet and Done puts the quantity on it. */
export interface LineMeasuring {
  conditionId: string;
  name: string;
  section: string;
  /** What the line says now, before Done. */
  quantity: number;
  unit: string;
  rateCents: number | null;
  /** "Your guess" until it is measured; a quoted line keeps the trade's price. */
  basis: "guess" | "measured" | "quoted" | "allowance";
  onDone: (rateCents: number | null) => Promise<void>;
}

const dollars = (cents: number | null) => (cents === null ? "" : String(cents / 100));
const toCents = (value: string) => (value.trim() === "" ? null : Math.max(0, Math.round(Number(value) * 100)));

/**
 * The line being measured, live. The quantity is what the plans say (with its
 * waste), the total is that times the rate, and both are compared with what the
 * line said before. Waste and wall height belong to the measurement, so they
 * save as they change; the rate is the line's and goes on with Done.
 */
export function LineLedger({
  line,
  rollup,
  rateCents,
  onRate,
  markupsHere,
  sheetNumber,
  canWrite,
  onChanged,
  onOpenSheet,
  onDeleteMarkup,
}: {
  line: LineMeasuring;
  rollup: ConditionRollup | undefined;
  rateCents: number | null;
  onRate: (cents: number | null) => void;
  /** This line's measurements on the open sheet. */
  markupsHere: DrawingMarkup[];
  sheetNumber: string;
  canWrite: boolean;
  onChanged: () => void;
  onOpenSheet: (sheetId: string) => void;
  onDeleteMarkup: (markupId: string) => void;
}) {
  const condition = rollup?.condition;
  const [waste, setWaste] = useState(String(condition?.waste_pct ?? 0));
  const [height, setHeight] = useState(condition?.height_ft ? String(condition.height_ft) : "");
  const [walls, setWalls] = useState(!!condition?.height_ft);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!condition) return;
    setWaste(String(condition.waste_pct));
    setHeight(condition.height_ft ? String(condition.height_ft) : "");
    setWalls(!!condition.height_ft);
  }, [condition]);

  const save = async (updates: { waste_pct?: number; height_ft?: number | null }) => {
    if (!condition) return;
    setSaving(true);
    try {
      unwrapAction(await updateTakeoffConditionAction(condition.id, updates, condition.updated_at));
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  const unit = condition ? MEASURE_UOM_LABELS[condition.uom] : line.unit.toUpperCase();
  const measured = (rollup?.markup_count ?? 0) > 0;
  const quantity = rollup?.effective_quantity ?? 0;
  const total = rateCents === null ? null : Math.round(quantity * rateCents);
  const before = line.rateCents === null ? null : Math.round(line.quantity * line.rateCents);
  const waiting = (rollup?.pending_review_count ?? 0) + (rollup?.unscaled_markup_count ?? 0);
  // An area line can be measured as wall runs times a height (paint, drywall),
  // decided before anything is measured, because the members measure differently.
  const canChooseWalls = condition?.uom === "sf" && !measured && canWrite;
  const wastePct = Number(waste) || 0;
  const source = rollup ? `${formatQuantity(rollup.source_quantity)} ${MEASURE_UOM_LABELS[rollup.source_uom]}` : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4">
        <div className="grid gap-0.5">
          <span className="microlabel text-muted-foreground">Quantity</span>
          <span className="flex items-baseline gap-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {measured ? formatQuantity(quantity) : "—"}
            <span className="text-sm font-medium tracking-normal text-muted-foreground">{unit}</span>
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {!measured
              ? "Nothing measured yet."
              : walls && condition?.height_ft
                ? `${source} of wall × ${formatQuantity(condition.height_ft)} ft${wastePct ? ` + ${wastePct}% waste` : ""}`
                : `${source} measured${wastePct ? ` + ${wastePct}% waste` : ""}`}
          </span>
        </div>

        {waiting > 0 && (
          <p className="flex gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {rollup?.unscaled_markup_count
              ? "Some measurements are on a sheet with no scale. Set the scale to count them."
              : "Some measurements were carried onto new sheets. Confirm them in Takeoff to count them."}
          </p>
        )}

        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 bg-muted px-3 py-2 text-[13px] tabular-nums">
          <span className={cn("text-xs font-medium", line.basis === "guess" ? "text-warning" : "text-muted-foreground")}>
            {line.basis === "guess" ? "Your guess" : "Before"}
          </span>
          <span className="truncate text-muted-foreground">
            <s>
              {formatQuantity(line.quantity)} {line.unit.toUpperCase()}
              {before !== null ? ` · ${money(before)}` : ""}
            </s>
            {line.basis === "guess" ? " · replaced on Done" : ""}
          </span>
        </div>

        {canChooseWalls && (
          <div className="grid gap-2">
            <span className="text-xs font-medium">Measure by</span>
            <Segmented
              label="Measure by"
              value={walls ? "walls" : "area"}
              onChange={(value) => {
                setWalls(value === "walls");
                if (value === "area" && condition?.height_ft) void save({ height_ft: null });
              }}
              options={[
                { value: "area", label: "Area" },
                { value: "walls", label: "Wall runs × height" },
              ]}
            />
            {walls && !condition?.height_ft && (
              <p className="text-xs text-muted-foreground">Click the wall runs; Arc multiplies by the height. Set it once and it stays on the line.</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <label className="grid gap-1 text-xs font-medium">
            Rate
            {line.basis === "quoted" ? (
              <span className="flex h-9 items-center text-xs font-normal text-muted-foreground">Quoted price kept</span>
            ) : (
              <span className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">$</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={dollars(rateCents)}
                  onChange={(event) => onRate(toCents(event.target.value))}
                  className="pl-6 pr-10 text-right font-mono tabular-nums"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">/{unit}</span>
              </span>
            )}
          </label>
          {walls ? (
            <label className="grid gap-1 text-xs font-medium">
              Wall height
              <span className="relative">
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  inputMode="decimal"
                  value={height}
                  disabled={!canWrite || measured}
                  placeholder="9"
                  onChange={(event) => setHeight(event.target.value)}
                  onBlur={() => {
                    const next = Number(height) || null;
                    if (next !== (condition?.height_ft ?? null)) void save({ height_ft: next });
                  }}
                  className="pr-8 text-right font-mono tabular-nums"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">ft</span>
              </span>
            </label>
          ) : condition?.uom === "ea" ? null : (
            <label className="grid gap-1 text-xs font-medium">
              Waste
              <span className="relative">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  inputMode="numeric"
                  value={waste}
                  disabled={!canWrite}
                  onChange={(event) => setWaste(event.target.value)}
                  onBlur={() => {
                    const next = Math.min(100, Math.max(0, Number(waste) || 0));
                    if (next !== condition?.waste_pct) void save({ waste_pct: next });
                  }}
                  className="pr-8 text-right font-mono tabular-nums"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">%</span>
              </span>
            </label>
          )}
        </div>

        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="microlabel text-muted-foreground">Line total</span>
          <span className="grid justify-items-end gap-0.5">
            <span className="text-xl font-semibold tabular-nums">{measured && total !== null ? money(total) : "—"}</span>
            {measured && total !== null && before !== null && (
              <span className={cn("text-xs tabular-nums", total > before ? "text-warning" : "text-success")}>
                {total === before ? "No change" : `${total > before ? "+" : "−"}${money(Math.abs(total - before))} vs. ${line.basis === "guess" ? "the guess" : "before"}`}
              </span>
            )}
          </span>
        </div>

        <div className="grid gap-1.5">
          <span className="microlabel flex items-center gap-1.5 text-muted-foreground">
            Measured on
            {saving && <Loader2 className="size-3 animate-spin" />}
          </span>
          {rollup?.sheets.length ? (
            <div className="grid border">
              {rollup.sheets.map((sheet) => (
                <button
                  key={sheet.drawing_sheet_id}
                  type="button"
                  onClick={() => onOpenSheet(sheet.drawing_sheet_id)}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-2 border-t px-2.5 py-1.5 text-left text-[13px] transition-colors first:border-t-0 hover:bg-muted"
                >
                  <span className="font-mono text-xs">{sheet.sheet_number}</span>
                  <span className="truncate text-muted-foreground">{sheet.sheet_title ?? ""}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {formatQuantity(sheet.quantity)} {unit}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">Each room, run or fixture you measure adds to the line.</p>
          )}
        </div>

        {markupsHere.length > 0 && (
          <div className="grid gap-1.5">
            <span className="microlabel text-muted-foreground">On {sheetNumber}</span>
            <div className="grid border">
              {markupsHere.map((markup, index) => (
                <div key={markup.id} className="flex items-center gap-2 border-t py-1 pl-2.5 pr-1 text-[13px] first:border-t-0">
                  <span className="min-w-0 flex-1 truncate">{markup.label || `Measurement ${index + 1}`}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {markup.quantity === null ? "No scale" : `${formatQuantity(markup.quantity)} ${markup.uom ? MEASURE_UOM_LABELS[markup.uom] : ""}`}
                  </span>
                  {canWrite && (
                    <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Remove measurement" onClick={() => onDeleteMarkup(markup.id)}>
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">Done puts the quantity on the line. There is nothing else to send.</p>
    </div>
  );
}
