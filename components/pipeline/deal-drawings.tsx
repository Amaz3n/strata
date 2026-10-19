"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DrawingViewer } from "@/components/drawings/drawing-viewer";
import type { LineMeasuring } from "@/components/drawings/workspace/line-ledger";
import { Segmented } from "@/components/drawings/workspace/segmented";
import { useSheetViewer } from "@/components/drawings/use-sheet-viewer";
import type { usePricingWorksheet } from "@/components/precon/use-pricing-worksheet";
import { listDrawingSheetsWithUrlsAction } from "@/app/(app)/drawings/actions";
import {
  applyLineMeasurementAction,
  beginWorksheetMeasurementAction,
  getConditionLandingSheetAction,
  resolvePlanChangesAction,
} from "@/app/(app)/drawings/takeoff-actions";
import type { DrawingSheet } from "@/app/(app)/drawings/types";
import { unwrapAction } from "@/lib/action-result";
import { formatQuantity } from "@/lib/drawings/measure";
import { isMeasured } from "@/lib/precon/deal-move";
import { money } from "@/lib/precon/format";
import type { PlanChanges } from "@/lib/precon/plan-changes";
import { rowPricing, type PricingRow, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";

/** What a line's price rests on, as the measuring takeover says it. */
function lineBasis(row: PricingRow, worksheet: PricingWorksheet): LineMeasuring["basis"] {
  const pricing = rowPricing(row, worksheet);
  if (pricing.basis === "quote") return "quoted";
  if (isMeasured(row)) return "measured";
  return pricing.basis === "allowance" ? "allowance" : "guess";
}

const sourceCondition = (row: PricingRow) =>
  ((row.metadata.takeoff_source ?? row.metadata.takeoff) as { condition_id?: string } | undefined)?.condition_id ?? null;

const SHEETS_FRESH_MS = 2 * 60_000;

type Mode = { kind: "view" } | { kind: "line"; rowId: string; conditionId: string };

/**
 * The deal's drawings, over whichever tab asked: the full-screen viewer for
 * reading a sheet, the same viewer measuring one pricing line (Done puts the
 * quantity on the line), and the review of what new plans did to measured
 * lines. A sheet opened to read measures nothing: takeoff starts from a line.
 */
export function useDealDrawings({
  dealId,
  projectId: initialProjectId,
  state,
  editable,
  canMeasure,
  modelEnabled,
  planChanges,
}: {
  dealId: string;
  projectId: string | null;
  state: ReturnType<typeof usePricingWorksheet>;
  editable: boolean;
  canMeasure: boolean;
  modelEnabled: boolean;
  planChanges: PlanChanges;
}) {
  const viewer = useSheetViewer();
  const [projectId, setProjectId] = useState(initialProjectId);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const worksheet = state.worksheet;

  // One load of the set per project, shared by the prefetch when a line opens and the Measure click after it.
  // It is short-lived so a set uploaded meanwhile shows up on the next measure.
  const sheetLoad = useRef<{ projectId: string; at: number; sheets: Promise<DrawingSheet[]> } | null>(null);
  const loadSheets = useCallback((forProject: string) => {
    const cached = sheetLoad.current;
    if (cached?.projectId === forProject && Date.now() - cached.at < SHEETS_FRESH_MS) return cached.sheets;
    const sheets = listDrawingSheetsWithUrlsAction({ project_id: forProject, limit: 1000 });
    sheetLoad.current = { projectId: forProject, at: Date.now(), sheets };
    sheets.catch(() => {
      if (sheetLoad.current?.sheets === sheets) sheetLoad.current = null;
    });
    return sheets;
  }, []);

  /** Warm the sheet list before Measure, so the click only links the line. */
  const prefetch = useCallback(() => {
    if (projectId && canMeasure) void loadSheets(projectId).catch(() => {});
  }, [projectId, canMeasure, loadSheets]);

  /** Open a sheet to read it. The plan room hands over the set it already has. */
  const open = useCallback(
    (sheet: DrawingSheet, set: DrawingSheet[]) => {
      if (projectId) sheetLoad.current = { projectId, at: Date.now(), sheets: Promise.resolve(set) };
      setMode({ kind: "view" });
      void viewer.openSheet(sheet, set);
    },
    [viewer, projectId],
  );

  const measure = useCallback(
    async (rowId: string, unit: string) => {
      if (!canMeasure) return toast.error("You can't measure on these plans.");
      setBusy(true);
      try {
        // The sheets load while the line is linked; a deal being priced already has its project.
        const early = projectId ? loadSheets(projectId) : null;
        if (editable && state.dirty) await state.save();
        const begun = unwrapAction(await beginWorksheetMeasurementAction(dealId, rowId, unit));
        setProjectId(begun.projectId);
        // Only a first measurement saves the worksheet (it links the line); then pick up that version.
        const latest = begun.saved ? state.reviewLatest() : null;
        const [set] = await Promise.all([early && begun.projectId === projectId ? early : loadSheets(begun.projectId), latest]);
        if (!set.length) {
          toast("Upload the plans first. Measured lines come off the sheets.");
          return;
        }
        const landing = (begun.sheetId && set.find((sheet) => sheet.id === begun.sheetId)) || set[0];
        setMode({ kind: "line", rowId, conditionId: begun.conditionId });
        void viewer.openSheet(landing, set);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to open the plans");
      } finally {
        setBusy(false);
      }
    },
    [canMeasure, editable, state, dealId, projectId, loadSheets, viewer],
  );

  /** "Review measurements": new plans carried them onto new sheets; confirm them in Takeoff. */
  const reviewMeasurements = useCallback(async () => {
    const first = worksheet.rows.find((row) => row.id === planChanges.review[0]?.rowId);
    const conditionId = first ? sourceCondition(first) : null;
    if (!projectId || !conditionId) return;
    setBusy(true);
    try {
      const [set, landing] = await Promise.all([loadSheets(projectId), getConditionLandingSheetAction(conditionId).then(unwrapAction)]);
      const sheet = set.find((item) => item.id === landing?.drawing_sheet_id) ?? set[0];
      if (!sheet) return;
      setMode({ kind: "view" });
      void viewer.openSheet(sheet, set);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to open the plans");
    } finally {
      setBusy(false);
    }
  }, [worksheet.rows, planChanges.review, projectId, loadSheets, viewer]);

  const measuringRow = mode.kind === "line" ? worksheet.rows.find((row) => row.id === mode.rowId) : undefined;
  const leaveLine = useCallback(() => {
    setMode({ kind: "view" });
    viewer.close();
  }, [viewer]);

  const line: LineMeasuring | undefined =
    mode.kind === "line" && measuringRow
      ? {
          conditionId: mode.conditionId,
          name: measuringRow.description,
          section: measuringRow.section,
          quantity: measuringRow.quantity,
          unit: measuringRow.unit,
          rateCents: measuringRow.unit_cost_cents,
          basis: lineBasis(measuringRow, worksheet),
          onDone: async (rateCents) => {
            const before = rowPricing(measuringRow, worksheet).cost ?? 0;
            unwrapAction(await applyLineMeasurementAction(dealId, { row_id: measuringRow.id, unit_cost_cents: rateCents }));
            await state.reviewLatest();
            toast.success(`${measuringRow.description} is measured.`, {
              description: rateCents === null ? undefined : `Was ${money(before)}.`,
            });
            leaveLine();
          },
        }
      : undefined;

  const overlay = (
    <>
      {viewer.open && viewer.sheet && projectId && (
        <DrawingViewer
          key={mode.kind === "line" ? `line:${mode.conditionId}` : "view"}
          sheet={viewer.sheet}
          fileUrl={viewer.url ?? undefined}
          markups={viewer.markups}
          pins={viewer.pins}
          highlightedPinId={viewer.highlightedPinId ?? undefined}
          initialVersionsOpen={viewer.versionsOpen}
          onClose={leaveLine}
          onSaveMarkup={viewer.saveMarkup}
          onSaveMeasurement={viewer.saveMeasurement}
          onDeleteMarkup={viewer.deleteMarkup}
          onMarkupsChanged={viewer.markupsChanged}
          takeoffProjectId={projectId}
          canWriteTakeoff={canMeasure}
          sheets={viewer.sheets}
          onNavigateSheet={(sheet) => void viewer.openSheet(sheet, viewer.sheets)}
          imageThumbnailUrl={viewer.sheet.image_thumbnail_url}
          imageWidth={viewer.sheet.image_width}
          imageHeight={viewer.sheet.image_height}
          modelTarget={modelEnabled ? { kind: "project", projectId } : null}
          canWriteModel={canMeasure}
          line={line}
          viewOnly={mode.kind === "view"}
          initialPanelOpen={planChanges.review.length > 0}
        />
      )}
      <PlanChangesReview open={reviewing} onOpenChange={setReviewing} dealId={dealId} changes={planChanges} state={state} />
    </>
  );

  return {
    api: {
      open,
      measure: (rowId: string, unit: string) => void measure(rowId, unit),
      prefetch,
      reviewMeasurements: () => void reviewMeasurements(),
      reviewQuantities: () => setReviewing(true),
      busy,
    },
    overlay,
  };
}

/** New plans changed measured quantities. Nothing on the price moves until the builder chooses, line by line. */
function PlanChangesReview({
  open,
  onOpenChange,
  dealId,
  changes,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  changes: PlanChanges;
  state: ReturnType<typeof usePricingWorksheet>;
}) {
  const [choice, setChoice] = useState<Record<string, "use" | "keep">>({});
  const [saving, setSaving] = useState(false);
  const pick = (rowId: string) => choice[rowId] ?? "use";
  const delta = changes.changed.reduce((sum, change) => sum + (pick(change.rowId) === "use" ? change.deltaCents : 0), 0);
  const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : "±"}${money(Math.abs(cents))}`;

  const apply = async () => {
    setSaving(true);
    try {
      if (state.dirty) await state.save();
      unwrapAction(
        await resolvePlanChangesAction(dealId, {
          lines: changes.changed.map((change) => ({ row_id: change.rowId, choice: pick(change.rowId), quantity: change.to })),
        }),
      );
      await state.reviewLatest();
      toast.success(delta ? `Quantities updated. The price moved ${signed(delta)}.` : "Quantities reviewed.");
      onOpenChange(false);
      setChoice({});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update the quantities");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4 text-left">
          <DialogTitle className="text-base">
            New plans changed {changes.changed.length} measured {changes.changed.length === 1 ? "line" : "lines"}
          </DialogTitle>
          <DialogDescription className="text-xs">The measurements you confirmed on the new sheets add up differently. Choose what goes on the price.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-5 py-3">
          {changes.changed.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Every measured line matches the plans.</p>
          ) : (
            changes.changed.map((change) => (
              <div key={change.rowId} className="grid gap-2 border px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate text-sm font-semibold">{change.description}</span>
                  <span className="flex flex-wrap items-baseline gap-x-3 font-mono text-xs tabular-nums">
                    <span className="text-muted-foreground">
                      Was {formatQuantity(change.from)} {change.unit.toUpperCase()}
                    </span>
                    <span>
                      Now {formatQuantity(change.to)} {change.unit.toUpperCase()}
                    </span>
                    <span className={change.deltaCents > 0 ? "text-warning" : "text-success"}>{signed(change.deltaCents)}</span>
                  </span>
                </div>
                <Segmented
                  label={`Quantity for ${change.description}`}
                  value={pick(change.rowId)}
                  onChange={(value) => setChoice((current) => ({ ...current, [change.rowId]: value }))}
                  options={[
                    { value: "use", label: `Use ${formatQuantity(change.to)}` },
                    { value: "keep", label: `Keep ${formatQuantity(change.from)}` },
                  ]}
                />
              </div>
            ))
          )}
        </div>
        <DialogFooter className="flex-row items-center border-t px-5 py-3 sm:justify-between">
          <span className="text-sm tabular-nums text-muted-foreground">Price {signed(delta)}</span>
          <span className="flex gap-2">
            <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Later
            </Button>
            <Button disabled={saving || changes.changed.length === 0} onClick={() => void apply()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Apply
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
