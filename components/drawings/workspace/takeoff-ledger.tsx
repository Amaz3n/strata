"use client";

/**
 * The takeoff, beside the sheet, all the time.
 *
 * One row per item: what it adds up to, how much of that is on the sheet you
 * are looking at, what it costs, and whether the estimate has it. Clicking a
 * row arms it — the next click on the sheet measures into it. Hovering a row
 * lights its geometry on the sheet and in 3D.
 */

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  BookmarkPlus,
  ChevronRight,
  Download,
  Library,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteTakeoffConditionAction,
  exportConditionRollupCsvAction,
  updateTakeoffConditionAction,
} from "@/app/(app)/drawings/takeoff-actions";
import { unwrapAction } from "@/lib/action-result";
import { formatQuantity, MEASURE_UOM_LABELS } from "@/lib/drawings/measure";
import type { ConditionRollup, TakeoffCondition } from "@/lib/services/takeoff";
import { cn } from "@/lib/utils";

import { ConditionEditorDialog } from "../takeoff-condition-editor";
import { HarvestTemplatesDialog, TemplateLibraryDialog } from "../takeoff-template-library";
import type { TakeoffScope } from "./item-picker";
import { pendingHandoffCount } from "./estimate-handoff";

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export interface TakeoffLedgerProps {
  rollups: ConditionRollup[] | null;
  error: string | null;
  onRetry: () => void;
  scope: TakeoffScope;
  canWrite: boolean;
  activeSheetId: string;
  armedId: string | null;
  onArm: (condition: TakeoffCondition) => void;
  onHover: (conditionId: string | null) => void;
  onChanged: () => void;
  onNewItem: () => void;
  onOpenSheet: (sheetId: string) => void;
  onSendToEstimate: () => void;
  /** Above the list: the revision band, the measuring context. */
  notices?: React.ReactNode;
}

export function TakeoffLedger({
  rollups,
  error,
  onRetry,
  scope,
  canWrite,
  activeSheetId,
  armedId,
  onArm,
  onHover,
  onChanged,
  onNewItem,
  onOpenSheet,
  onSendToEstimate,
  notices,
}: TakeoffLedgerProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<TakeoffCondition | null>(null);
  const [deleting, setDeleting] = useState<ConditionRollup | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [harvestOpen, setHarvestOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: ConditionRollup[]; cents: number }>();
    for (const row of rollups ?? []) {
      const key = row.cost_code ? row.cost_code.code : "";
      const label = row.cost_code ? `${row.cost_code.code} · ${row.cost_code.name}` : "No cost code";
      const group = map.get(key) ?? { label, rows: [], cents: 0 };
      group.rows.push(row);
      group.cents += row.extended_cents ?? 0;
      map.set(key, group);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(([, group]) => group);
  }, [rollups]);

  const total = (rollups ?? []).reduce((sum, row) => sum + (row.extended_cents ?? 0), 0);
  const unpriced = (rollups ?? []).filter((row) => row.markup_count > 0 && row.extended_cents === null).length;
  const changes = rollups ? pendingHandoffCount(rollups) : 0;
  const measured = (rollups ?? []).filter((row) => row.markup_count > 0).length;

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const result = unwrapAction(await exportConditionRollupCsvAction(scope));
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.condition_count} items`);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't export the takeoff");
    } finally {
      setExporting(false);
    }
  }, [scope]);

  const confirmDelete = useCallback(async () => {
    if (!deleting || !canWrite || busyDelete) return;
    setBusyDelete(true);
    try {
      const result = unwrapAction(await deleteTakeoffConditionAction(deleting.condition.id, deleting.condition.updated_at));
      toast.success(
        result.detached_lines > 0
          ? `${deleting.condition.name} deleted · ${result.detached_lines} estimate ${result.detached_lines === 1 ? "line" : "lines"} kept, now detached`
          : `${deleting.condition.name} deleted`,
      );
      setDeleting(null);
      onChanged();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't delete that item");
    } finally {
      setBusyDelete(false);
    }
  }, [deleting, canWrite, busyDelete, onChanged]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            {rollups === null ? "Loading…" : rollups.length === 0 ? "No items yet" : `${rollups.length} ${rollups.length === 1 ? "item" : "items"} · ${measured} measured`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {canWrite && (
            <Button size="sm" variant="outline" className="h-8 gap-1" onClick={onNewItem}>
              <Plus className="size-3.5" />
              Item
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Takeoff options">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canWrite && (
                <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                  <Library className="size-3.5" />
                  Add from library
                </DropdownMenuItem>
              )}
              {canWrite && (
                <DropdownMenuItem disabled={!rollups?.length} onSelect={() => setHarvestOpen(true)}>
                  <BookmarkPlus className="size-3.5" />
                  Save these items to the library
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={exporting || !rollups?.length} onSelect={() => void exportCsv()}>
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                Export quantities (CSV)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notices}
        {rollups === null ? (
          <LedgerSkeleton />
        ) : error && rollups.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-4 py-8" role="alert">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : rollups.length === 0 ? (
          <div className="space-y-3 px-4 py-8">
            <p className="text-sm font-medium">Nothing measured yet</p>
            <p className="text-sm text-muted-foreground">
              Pick <strong className="font-medium text-foreground">Length</strong>, <strong className="font-medium text-foreground">Area</strong> or{" "}
              <strong className="font-medium text-foreground">Count</strong> in the tool dock and name what you&apos;re measuring. The running totals
              land here.
            </p>
            {canWrite && (
              <Button size="sm" onClick={onNewItem} className="gap-1.5">
                <Plus className="size-3.5" />
                New item
              </Button>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <div className="flex items-baseline justify-between gap-2 px-4 pb-1 pt-4">
                <span className="microlabel truncate">{group.label}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{group.cents ? money(group.cents) : ""}</span>
              </div>
              <ul>
                {group.rows.map((row) => (
                  <LedgerRow
                    key={row.condition.id}
                    row={row}
                    armed={armedId === row.condition.id}
                    expanded={expanded === row.condition.id}
                    activeSheetId={activeSheetId}
                    canWrite={canWrite}
                    onArm={() => onArm(row.condition)}
                    onExpand={() => setExpanded((current) => (current === row.condition.id ? null : row.condition.id))}
                    onHover={onHover}
                    onEdit={() => setEditing(row.condition)}
                    onDelete={() => setDeleting(row)}
                    onOpenSheet={onOpenSheet}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {rollups && rollups.length > 0 && (
        <footer className="space-y-2.5 border-t px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="microlabel">Takeoff total</span>
            <span className="font-mono text-lg font-semibold tabular-nums">{money(total)}</span>
          </div>
          {unpriced > 0 && (
            <p className="text-xs text-muted-foreground">
              {unpriced} measured {unpriced === 1 ? "item has" : "items have"} no rate yet.
            </p>
          )}
          {canWrite && (
            <Button className="h-9 w-full gap-1.5" variant={changes > 0 ? "default" : "outline"} onClick={onSendToEstimate} disabled={measured === 0}>
              <Send className="size-3.5" />
              {changes > 0 ? `Send ${changes} ${changes === 1 ? "change" : "changes"} to estimate` : "Review estimate lines"}
            </Button>
          )}
        </footer>
      )}

      {editing && (
        <ConditionEditorDialog
          open
          condition={editing}
          scope={scope}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
      {libraryOpen && (
        <TemplateLibraryDialog
          open
          scope={scope}
          onOpenChange={setLibraryOpen}
          onApplied={() => {
            setLibraryOpen(false);
            onChanged();
          }}
        />
      )}
      {harvestOpen && rollups && (
        <HarvestTemplatesDialog
          open
          conditionIds={rollups.map((row) => row.condition.id)}
          onOpenChange={setHarvestOpen}
          onSaved={() => setHarvestOpen(false)}
        />
      )}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && !busyDelete && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.condition.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.sync
                ? `Its estimate line stays, marked detached. Its ${deleting.markup_count} ${deleting.markup_count === 1 ? "measurement stays" : "measurements stay"} on the sheets, unassigned.`
                : `Its ${deleting?.markup_count ?? 0} ${deleting?.markup_count === 1 ? "measurement stays" : "measurements stay"} on the sheets, unassigned.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyDelete}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyDelete || !canWrite}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyDelete && <Loader2 className="size-3.5 animate-spin" />}
              Delete item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LedgerRow({
  row,
  armed,
  expanded,
  activeSheetId,
  canWrite,
  onArm,
  onExpand,
  onHover,
  onEdit,
  onDelete,
  onOpenSheet,
  onChanged,
}: {
  row: ConditionRollup;
  armed: boolean;
  expanded: boolean;
  activeSheetId: string;
  canWrite: boolean;
  onArm: () => void;
  onExpand: () => void;
  onHover: (conditionId: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSheet: (sheetId: string) => void;
  onChanged: () => void;
}) {
  const { condition } = row;
  const unit = MEASURE_UOM_LABELS[condition.uom];
  const here = row.sheets.find((sheet) => sheet.drawing_sheet_id === activeSheetId);
  const flags = rowFlags(row);
  const estimate = estimateState(row);
  return (
    <li onMouseEnter={() => onHover(condition.id)} onMouseLeave={() => onHover(null)} className={cn(armed && "bg-accent")}>
      <div className="flex items-start">
        <button
          type="button"
          onClick={onArm}
          disabled={!canWrite}
          aria-pressed={armed}
          aria-label={`Measure ${condition.name}`}
          className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pl-4 pr-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span
            aria-hidden
            className={cn("mt-1 size-2.5 shrink-0", armed && "outline outline-2 outline-offset-2 outline-foreground")}
            style={{ backgroundColor: condition.color }}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{condition.name}</span>
            <span className="block text-xs text-muted-foreground">
              {here ? (
                <>
                  This sheet <span className="font-mono tabular-nums">{formatQuantity(here.quantity)}</span>
                </>
              ) : row.markup_count > 0 ? (
                "Not on this sheet"
              ) : (
                "Nothing measured yet"
              )}
            </span>
            {(flags.length > 0 || estimate) && (
              <span className="mt-1.5 flex flex-wrap gap-1">
                {flags.map((flag) => (
                  <span key={flag} className="inline-flex items-center gap-1 border border-warning/50 bg-warning/10 px-1.5 text-[10px] font-medium text-warning">
                    <AlertTriangle className="size-2.5" />
                    {flag}
                  </span>
                ))}
                {estimate && (
                  <span
                    className={cn(
                      "border px-1.5 text-[10px] font-medium",
                      estimate.tone === "primary" && "border-primary/40 text-primary",
                      estimate.tone === "warning" && "border-warning/50 text-warning",
                      estimate.tone === "muted" && "text-muted-foreground",
                    )}
                  >
                    {estimate.label}
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="shrink-0 text-right">
            <span className="block font-mono text-sm font-semibold tabular-nums">
              {formatQuantity(row.effective_quantity)}
              <span className="ml-1 text-[10px] font-medium text-muted-foreground">{unit}</span>
            </span>
            <span className="block font-mono text-xs tabular-nums text-muted-foreground">
              {row.extended_cents !== null ? money(row.extended_cents) : row.markup_count > 0 ? "No rate" : ""}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={`Details for ${condition.name}`}
          className="mr-1 mt-2 grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
        </button>
      </div>
      {expanded && <LedgerDetail row={row} activeSheetId={activeSheetId} canWrite={canWrite} onEdit={onEdit} onDelete={onDelete} onOpenSheet={onOpenSheet} onChanged={onChanged} />}
    </li>
  );
}

function LedgerDetail({
  row,
  activeSheetId,
  canWrite,
  onEdit,
  onDelete,
  onOpenSheet,
  onChanged,
}: {
  row: ConditionRollup;
  activeSheetId: string;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSheet: (sheetId: string) => void;
  onChanged: () => void;
}) {
  const { condition } = row;
  const unit = MEASURE_UOM_LABELS[condition.uom];
  const [waste, setWaste] = useState(String(condition.waste_pct));
  const [rate, setRate] = useState(condition.unit_cost_cents !== null ? (condition.unit_cost_cents / 100).toFixed(2) : "");
  const [saving, setSaving] = useState(false);

  const save = async (field: "waste" | "rate") => {
    const updates: { waste_pct?: number; unit_cost_cents?: number | null } = {};
    if (field === "waste") {
      const value = Number(waste);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        toast.error("Waste is a percentage between 0 and 100");
        setWaste(String(condition.waste_pct));
        return;
      }
      if (value === condition.waste_pct) return;
      updates.waste_pct = value;
    } else {
      const trimmed = rate.trim();
      const value = trimmed === "" ? null : Math.round(Number(trimmed) * 100);
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        toast.error("Enter the rate in dollars, like 6.50");
        return;
      }
      if (value === condition.unit_cost_cents) return;
      updates.unit_cost_cents = value;
    }
    setSaving(true);
    try {
      unwrapAction(await updateTakeoffConditionAction(condition.id, updates, condition.updated_at));
      onChanged();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that change");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t bg-muted/40 px-4 py-3 pl-9">
      {row.sheets.length > 0 ? (
        <table className="w-full text-xs">
          <tbody>
            {row.sheets.map((sheet) => (
              <tr key={sheet.drawing_sheet_id} className="border-b last:border-0">
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => onOpenSheet(sheet.drawing_sheet_id)}
                    className={cn("font-mono font-semibold hover:underline", sheet.drawing_sheet_id === activeSheetId ? "text-foreground" : "text-primary")}
                  >
                    {sheet.sheet_number}
                  </button>
                  <span className="ml-2 text-muted-foreground">{sheet.sheet_title ?? ""}</span>
                </td>
                <td className="py-1 text-right font-mono tabular-nums">
                  {formatQuantity(sheet.quantity)} {unit}
                </td>
              </tr>
            ))}
            {row.sheets_truncated > 0 && (
              <tr>
                <td colSpan={2} className="py-1 text-muted-foreground">
                  +{row.sheets_truncated} more {row.sheets_truncated === 1 ? "sheet" : "sheets"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing measured yet. Click the row to start.</p>
      )}
      {row.conversion_summary && <p className="font-mono text-[11px] text-muted-foreground">{row.conversion_summary}</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="microlabel">Waste %</span>
          <Input
            value={waste}
            disabled={!canWrite || saving}
            inputMode="decimal"
            onChange={(event) => setWaste(event.target.value)}
            onBlur={() => void save("waste")}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
            className="h-8 font-mono text-xs"
            aria-label={`Waste percent for ${condition.name}`}
          />
        </label>
        <label className="space-y-1">
          <span className="microlabel">Rate / {unit}</span>
          <Input
            value={rate}
            disabled={!canWrite || saving}
            inputMode="decimal"
            placeholder={row.rate_source === "cost_code" && row.effective_unit_cost_cents !== null ? (row.effective_unit_cost_cents / 100).toFixed(2) : "0.00"}
            onChange={(event) => setRate(event.target.value)}
            onBlur={() => void save("rate")}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
            className="h-8 font-mono text-xs"
            aria-label={`Rate per ${unit} for ${condition.name}`}
          />
        </label>
      </div>
      {row.rate_source === "cost_code" && condition.unit_cost_cents === null && (
        <p className="text-[11px] text-muted-foreground">Using the {row.cost_code?.code} rate until you pin one here.</p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onEdit}>
            <Pencil className="size-3" />
            Edit item
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 className="size-3" />
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

/** What makes this number less trustworthy than it looks, loudest first. */
function rowFlags(row: ConditionRollup): string[] {
  const flags: string[] = [];
  if (row.net_negative) flags.push("Deductions exceed areas — counted as 0");
  if (row.duplicate_suspect_sheets.length > 0) flags.push(`${row.duplicate_suspect_sheets.join(" and ")} match — measured twice?`);
  if (row.unscaled_markup_count > 0) flags.push(`${row.unscaled_markup_count} need a scale`);
  if (row.pending_review_count > 0) flags.push(`${row.pending_review_count} to review after revision`);
  if (row.stale_markup_count > 0) flags.push(`${row.stale_markup_count} on an old revision`);
  return flags;
}

function estimateState(row: ConditionRollup): { label: string; tone: "primary" | "warning" | "muted" } | null {
  if (row.markup_count === 0 && !row.sync) return null;
  if (!row.sync) return { label: "Not in estimate", tone: "primary" };
  if (row.sync.detached) return { label: "Estimate line detached", tone: "muted" };
  if (row.sync.hand_edited) return { label: "Edited in estimate", tone: "warning" };
  if (row.sync.quantity_changed) return { label: "Estimate out of date", tone: "primary" };
  return { label: "In estimate", tone: "muted" };
}

function LedgerSkeleton() {
  return (
    <div className="space-y-1 px-4 pt-4" role="status" aria-label="Loading takeoff">
      <Skeleton className="mb-3 h-3 w-24 rounded-none" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-start gap-2.5 py-2">
          <Skeleton className="mt-1 size-2.5 rounded-none" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3 rounded-none" />
            <Skeleton className="h-3 w-1/3 rounded-none" />
          </div>
          <Skeleton className="h-4 w-14 rounded-none" />
        </div>
      ))}
    </div>
  );
}
