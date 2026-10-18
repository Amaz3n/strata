"use client";

/**
 * Takeoff → estimate, as one review.
 *
 * Nothing is ticked by hand any more. Every measured item is compared with the
 * line it would write, and the review opens with exactly the lines that would
 * change already chosen: new quantities added, re-measured ones updated. Lines
 * someone edited in the estimate since the last send are left alone unless
 * the estimator says to overwrite each one, and items that cannot be priced
 * yet (a revision to review, a sheet with no scale) are held back with the
 * reason, not allowed to block everything else.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, Check, ChevronDown, Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listMeasurementRowsAction,
  listPlanVersionTargetAction,
  listSyncTargetsAction,
  previewConditionSyncAction,
  syncConditionsAction,
} from "@/app/(app)/drawings/takeoff-actions";
import { unwrapAction } from "@/lib/action-result";
import type { MeasurementContext } from "@/lib/drawings/measurement-context";
import { formatQuantity, MEASURE_UOM_LABELS } from "@/lib/drawings/measure";
import type { ConditionRollup, ConditionSyncPreviewRow } from "@/lib/services/takeoff";
import type { TakeoffSyncTarget } from "@/lib/services/takeoff-destinations";
import type { TakeoffDestination } from "@/lib/validation/takeoff";
import { cn } from "@/lib/utils";

const DESTINATION_LABELS: Record<TakeoffDestination, string> = {
  pricing_worksheet: "Working estimate",
  change_order: "Change order",
  estimate: "Estimate",
  bid_scope: "Bid package",
  plan_takeoff: "Plan takeoff",
};

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Where the estimator goes to see what they just sent. */
export function destinationHref(
  target: Pick<TakeoffSyncTarget, "destination" | "id">,
  projectId: string | null,
  prospectId?: string,
): string | null {
  if (target.destination === "pricing_worksheet") return `/pipeline/${prospectId ?? target.id}`;
  if (target.destination === "estimate") return `/estimates/${target.id}`;
  if (target.destination === "change_order" && projectId) return `/projects/${projectId}/change-orders`;
  if (target.destination === "bid_scope" && projectId) return `/projects/${projectId}/bids/${target.id}`;
  return null;
}

/** Items whose estimate line would move if sent now — the ledger's count. */
export function pendingHandoffCount(rollups: ConditionRollup[]): number {
  return rollups.filter(
    (row) =>
      row.markup_count > 0 &&
      row.pending_review_count === 0 &&
      row.unscaled_markup_count === 0 &&
      (!row.sync || (row.sync.quantity_changed && !row.sync.detached)),
  ).length;
}

export interface EstimateHandoffProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rollups: ConditionRollup[];
  projectId: string | null;
  housePlanVersionId: string | null;
  measurementContext?: MeasurementContext;
  prospectId?: string;
  estimateId?: string;
  onSent: () => void;
  /** "Review 2 measurements" from a held-back line. */
  onReviewRevision: () => void;
}

type Target = TakeoffSyncTarget;

export function EstimateHandoff({
  open,
  onOpenChange,
  rollups,
  projectId,
  housePlanVersionId,
  measurementContext,
  prospectId,
  estimateId,
  onSent,
  onReviewRevision,
}: EstimateHandoffProps) {
  const router = useRouter();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [preview, setPreview] = useState<ConditionSyncPreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [overwrites, setOverwrites] = useState<Set<string>>(new Set());
  const [worksheetRows, setWorksheetRows] = useState<Array<{ id: string; label: string; unit: string; conditionId?: string }>>([]);
  const [mappings, setMappings] = useState<Record<string, string>>(
    measurementContext?.rowId && measurementContext.conditionId ? { [measurementContext.conditionId]: measurementContext.rowId } : {},
  );
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const rowMode = !!measurementContext?.rowId;
  const candidates = useMemo(
    () =>
      rowMode
        ? rollups.filter((row) => row.condition.id === measurementContext?.conditionId)
        : rollups.filter((row) => row.markup_count > 0),
    [rollups, rowMode, measurementContext?.conditionId],
  );
  const candidateIds = useMemo(() => candidates.map((row) => row.condition.id), [candidates]);
  const rollupById = useMemo(() => new Map(rollups.map((row) => [row.condition.id, row])), [rollups]);

  // Destinations: the measuring context, then the deal's working estimate,
  // then the estimate in the URL, then the only writable one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSent(null);
    setTargets(null);
    setTargetsError(null);
    const load = housePlanVersionId
      ? listPlanVersionTargetAction(housePlanVersionId)
      : projectId
        ? listSyncTargetsAction(projectId)
        : Promise.resolve({ success: true as const, data: [] as Target[] });
    load
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setTargetsError(result.error);
          setTargets([]);
          return;
        }
        setTargets(result.data);
        const writable = result.data.filter((candidate) => candidate.writable);
        const preferred = measurementContext
          ? writable.find((candidate) => candidate.destination === measurementContext.destination && candidate.id === measurementContext.targetId)
          : prospectId
            ? writable.find((candidate) => candidate.destination === "pricing_worksheet")
            : estimateId
              ? writable.find((candidate) => candidate.destination === "estimate" && candidate.id === estimateId)
              : undefined;
        setTarget((current) => current && writable.some((candidate) => candidate.id === current.id) ? current : (preferred ?? (writable.length === 1 ? writable[0] : null)));
      })
      .catch(() => {
        if (!cancelled) {
          setTargetsError("Couldn't load where these quantities can go. Close and try again.");
          setTargets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, housePlanVersionId, measurementContext, prospectId, estimateId]);

  useEffect(() => {
    if (!open || target?.destination !== "pricing_worksheet") {
      setWorksheetRows([]);
      return;
    }
    let cancelled = false;
    listMeasurementRowsAction(target.id)
      .then((result) => {
        if (!cancelled && result.success) setWorksheetRows(result.data);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't load the estimate's scope items.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  const lineMappings = target?.destination === "pricing_worksheet" ? mappings : undefined;

  useEffect(() => {
    if (!open || !target || candidateIds.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    previewConditionSyncAction({ destination: target.destination, target_id: target.id, condition_ids: candidateIds, line_mappings: lineMappings })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setPreviewError(result.error);
          return;
        }
        setPreview(result.data);
        setOverwrites(new Set());
        setIncluded(
          new Set(
            result.data
              .filter((row) => !row.blocked_reason && (row.action === "create" || row.action === "update"))
              .map((row) => row.condition_id),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setPreviewError("Couldn't compare with the estimate. Close and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, candidateIds, lineMappings]);

  const rows = preview ?? [];
  const changing = rows.filter((row) => !row.blocked_reason && row.action !== "unchanged");
  const current = rows.filter((row) => !row.blocked_reason && row.action === "unchanged");
  const held = rows.filter((row) => !!row.blocked_reason);
  const toSend = rows.filter(
    (row) => included.has(row.condition_id) && !row.blocked_reason && (row.action !== "drift" || overwrites.has(row.condition_id)),
  );
  const deltaCents = toSend.reduce((sum, row) => sum + lineDeltaCents(row), 0);
  const href = target ? destinationHref(target, projectId, prospectId) : null;

  const send = useCallback(async () => {
    if (!target || toSend.length === 0) return;
    setSending(true);
    try {
      const ids = toSend.map((row) => row.condition_id);
      const result = unwrapAction(
        await syncConditionsAction({
          destination: target.destination,
          target_id: target.id,
          condition_ids: ids,
          line_mappings: lineMappings,
          reviewed_line_quantities: Object.fromEntries(toSend.map((row) => [row.condition_id, row.current_quantity])),
          reviewed_quantities: Object.fromEntries(toSend.map((row) => [row.condition_id, row.next_quantity])),
          drift_resolution: Object.fromEntries(toSend.filter((row) => row.action === "drift").map((row) => [row.condition_id, "overwrite" as const])),
        }),
      );
      const parts = [
        result.created ? `${result.created} added` : null,
        result.updated ? `${result.updated} updated` : null,
        result.unchanged ? `${result.unchanged} already current` : null,
        result.skipped ? `${result.skipped} left alone` : null,
      ].filter(Boolean);
      setSent(parts.join(" · ") || "Nothing to change");
      router.refresh();
      onSent();
      if (measurementContext?.rowId) router.push(measurementContext.returnHref);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send these quantities");
    } finally {
      setSending(false);
    }
  }, [target, toSend, lineMappings, router, onSent, measurementContext]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          <SheetTitle className="text-base">
            {rowMode && measurementContext?.rowLabel ? `Use measurements for ${measurementContext.rowLabel}` : "Send to estimate"}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Each line keeps a link to its measurements, so a re-measure can update it later.
          </SheetDescription>
          <div className="pt-2">
            {targets === null ? (
              <Skeleton className="h-10 w-full rounded-none" />
            ) : targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {targetsError ??
                  (housePlanVersionId
                    ? "This plan version can't take lines — it may already be released."
                    : prospectId
                      ? "Create a draft estimate in Pricing first. Your measurements are saved."
                      : "This project has no draft estimate, bid package or change order to send to yet.")}
              </p>
            ) : (
              <DestinationPicker targets={targets} value={target} onChange={(next) => { setTarget(next); setMappings({}); }} locked={rowMode} />
            )}
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sent ? (
            <div className="flex flex-col items-start gap-3 px-5 py-8">
              <span className="grid size-9 place-items-center bg-success text-success-foreground">
                <Check className="size-4" />
              </span>
              <div>
                <p className="font-semibold">Sent to {target?.label}</p>
                <p className="text-sm text-muted-foreground">{sent}</p>
              </div>
              <div className="flex gap-2">
                {href && (
                  <Button asChild size="sm" className="gap-1.5">
                    <Link href={href}>
                      Open {target ? DESTINATION_LABELS[target.destination].toLowerCase() : "estimate"}
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                  Back to the drawing
                </Button>
              </div>
            </div>
          ) : !target ? (
            targets && targets.length > 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Choose where these quantities go.</p>
            ) : null
          ) : previewError ? (
            <p className="px-5 py-8 text-sm text-destructive" role="alert">
              {previewError}
            </p>
          ) : preview === null ? (
            <div className="space-y-2 px-5 py-4" role="status" aria-label="Comparing with the estimate">
              {Array.from({ length: Math.min(6, Math.max(2, candidates.length)) }, (_, index) => (
                <Skeleton key={index} className="h-11 w-full rounded-none" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Nothing is measured yet. Measure something first.</p>
          ) : (
            <div className="pb-4">
              {changing.length > 0 && (
                <HandoffGroup label="Changes" count={changing.length}>
                  {changing.map((row) => (
                    <HandoffRow
                      key={row.condition_id}
                      row={row}
                      color={rollupById.get(row.condition_id)?.condition.color}
                      included={included.has(row.condition_id)}
                      onInclude={() => setIncluded((set) => toggle(set, row.condition_id))}
                      overwriting={overwrites.has(row.condition_id)}
                      onOverwrite={() => setOverwrites((set) => toggle(set, row.condition_id))}
                      mapping={
                        target.destination === "pricing_worksheet" && !rowMode
                          ? {
                              rows: worksheetRows.filter((item) => !item.conditionId || item.conditionId === row.condition_id),
                              value: mappings[row.condition_id] ?? worksheetRows.find((item) => item.conditionId === row.condition_id)?.id ?? "",
                              onChange: (value) =>
                                setMappings((currentMappings) => {
                                  const next = { ...currentMappings };
                                  if (value) next[row.condition_id] = value;
                                  else delete next[row.condition_id];
                                  return next;
                                }),
                            }
                          : null
                      }
                    />
                  ))}
                </HandoffGroup>
              )}
              {held.length > 0 && (
                <HandoffGroup label="Held back" count={held.length}>
                  {held.map((row) => {
                    const rollup = rollupById.get(row.condition_id);
                    return (
                      <div key={row.condition_id} className="flex items-start gap-3 px-5 py-2.5">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{row.condition_name}</div>
                          <div className="text-xs text-warning">{row.blocked_reason}</div>
                        </div>
                        {rollup && rollup.pending_review_count > 0 && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReviewRevision}>
                            Review
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </HandoffGroup>
              )}
              {current.length > 0 && (
                <HandoffGroup label="Already in the estimate" count={current.length} quiet>
                  {current.map((row) => (
                    <div key={row.condition_id} className="flex items-center gap-3 px-5 py-2 text-sm text-muted-foreground">
                      <span className="size-2 shrink-0" style={{ backgroundColor: rollupById.get(row.condition_id)?.condition.color }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{row.condition_name}</span>
                      <span className="font-mono text-xs tabular-nums">
                        {formatQuantity(row.next_quantity)} {MEASURE_UOM_LABELS[row.uom]}
                      </span>
                    </div>
                  ))}
                </HandoffGroup>
              )}
            </div>
          )}
        </div>

        {!sent && target && preview && (
          <div className="flex items-center gap-3 border-t px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {toSend.length} {toSend.length === 1 ? "line" : "lines"}
              </div>
              <div className={cn("font-mono text-xs tabular-nums", deltaCents > 0 ? "text-foreground" : "text-muted-foreground")}>
                {deltaCents === 0 ? "No price change" : `${deltaCents > 0 ? "+" : "−"}${money(Math.abs(deltaCents))} at current rates`}
              </div>
            </div>
            {href && (
              <Button asChild variant="ghost" size="sm" className="gap-1">
                <Link href={href}>
                  Open
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            )}
            <Button disabled={toSend.length === 0 || sending} onClick={() => void send()} className="gap-1.5">
              {sending && <Loader2 className="size-3.5 animate-spin" />}
              {toSend.length === 0
                ? "Nothing to send"
                : rowMode
                  ? "Use quantity & return to estimate"
                  : `Send ${toSend.length} to ${DESTINATION_LABELS[target.destination].toLowerCase()}`}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** What this line adds to the estimate, at the rate the preview carries. */
function lineDeltaCents(row: ConditionSyncPreviewRow): number {
  if (row.unit_cost_cents == null || row.evidence_only) return 0;
  return Math.round((row.next_quantity - (row.current_quantity ?? 0)) * row.unit_cost_cents);
}

function DestinationPicker({
  targets,
  value,
  onChange,
  locked,
}: {
  targets: Target[];
  value: Target | null;
  onChange: (target: Target) => void;
  locked: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={locked}>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 border bg-card px-3 py-2 text-left transition-colors hover:border-line-strong disabled:pointer-events-none"
          aria-label="Destination"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{value ? value.label : "Choose a destination"}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {value ? [DESTINATION_LABELS[value.destination], value.detail].filter(Boolean).join(" · ") : `${targets.filter((target) => target.writable).length} available`}
            </span>
          </span>
          {!locked && <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] max-w-[34rem]">
        <DropdownMenuLabel className="microlabel">Send quantities to</DropdownMenuLabel>
        {targets.map((target) => (
          <DropdownMenuItem
            key={`${target.destination}-${target.id}`}
            disabled={!target.writable}
            onSelect={() => onChange(target)}
            className="flex items-start justify-between gap-3"
          >
            <span className="min-w-0">
              <span className="block truncate">{target.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[DESTINATION_LABELS[target.destination], target.detail].filter(Boolean).join(" · ")}
              </span>
            </span>
            {!target.writable && target.blocked_reason && (
              <span className="shrink-0 text-[11px] text-muted-foreground">{target.blocked_reason}</span>
            )}
            {value?.id === target.id && value.destination === target.destination && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HandoffGroup({ label, count, quiet, children }: { label: string; count: number; quiet?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("pt-4", quiet && "opacity-90")}>
      <div className="flex items-baseline justify-between px-5 pb-1.5">
        <span className="microlabel">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
      </div>
      <div className="divide-y border-y">{children}</div>
    </section>
  );
}

function HandoffRow({
  row,
  color,
  included,
  onInclude,
  overwriting,
  onOverwrite,
  mapping,
}: {
  row: ConditionSyncPreviewRow;
  color?: string;
  included: boolean;
  onInclude: () => void;
  overwriting: boolean;
  onOverwrite: () => void;
  mapping: { rows: Array<{ id: string; label: string; unit: string }>; value: string; onChange: (value: string) => void } | null;
}) {
  const drift = row.action === "drift";
  const delta = row.next_quantity - (row.current_quantity ?? 0);
  const unit = MEASURE_UOM_LABELS[row.uom];
  return (
    <div className={cn("flex items-start gap-3 px-5 py-2.5", !included && "bg-muted/30")}>
      <Checkbox
        checked={included}
        onCheckedChange={onInclude}
        aria-label={`Send ${row.condition_name}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {color && <span className="size-2 shrink-0" style={{ backgroundColor: color }} aria-hidden />}
          <span className="truncate text-sm font-medium">{row.condition_name}</span>
          <span
            className={cn(
              "shrink-0 border px-1.5 text-[10px] font-semibold uppercase tracking-wide",
              row.action === "create" && "border-primary/40 text-primary",
              row.action === "update" && "text-foreground",
              drift && "border-warning/60 text-warning",
            )}
          >
            {row.action === "create" ? "New" : drift ? "Edited in estimate" : "Update"}
          </span>
        </div>
        {mapping && (
          <select
            aria-label={`Estimate item for ${row.condition_name}`}
            className="h-7 w-full max-w-72 border bg-background px-1.5 text-xs"
            value={mapping.value}
            onChange={(event) => mapping.onChange(event.target.value)}
          >
            <option value="">Create a new scope item</option>
            {mapping.rows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.unit}
              </option>
            ))}
          </select>
        )}
        {drift && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-warning">
              Changed by hand to {formatQuantity(row.current_quantity ?? 0)} since the last send (was {formatQuantity(row.last_synced_quantity ?? 0)}).
            </span>
            <button type="button" onClick={onOverwrite} className={cn("border px-1.5 py-0.5 font-medium", overwriting ? "border-destructive text-destructive" : "text-muted-foreground hover:text-foreground")}>
              {overwriting ? "Will overwrite" : "Keep their edit"}
            </button>
          </div>
        )}
        {row.reprice_required && <p className="text-xs text-warning">The lump sum will be cleared — enter a unit rate in the estimate after sending.</p>}
        {row.evidence_only && <p className="text-xs text-muted-foreground">Sent as measurement evidence · the quoted price stays.</p>}
      </div>
      <div className="shrink-0 text-right font-mono text-xs tabular-nums">
        <div className="text-sm text-foreground">
          {formatQuantity(row.next_quantity)} <span className="text-[10px] text-muted-foreground">{unit}</span>
        </div>
        <div className={cn(delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground")}>
          {row.current_quantity == null ? "new line" : `${delta >= 0 ? "+" : "−"}${formatQuantity(Math.abs(delta))} from ${formatQuantity(row.current_quantity)}`}
        </div>
      </div>
    </div>
  );
}
