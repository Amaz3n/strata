"use client";

import { getConditionRollupAction } from "@/app/(app)/drawings/takeoff-actions";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { ArrowRight, Check, Loader2, Play, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PricingLineInspector } from "./pricing-line-inspector";
import { FirmnessMark, MARK_LABEL, PricingLineList, linesToPrice, type LineMark } from "./pricing-line-list";
import { PricingSummary } from "./pricing-summary";
import type { usePricingWorksheet } from "./use-pricing-worksheet";
import {
  pricingRowSchema,
  worksheetQuoteIssues,
  scopeSignature,
  type PricingRow,
} from "@/lib/precon/pricing-worksheet";
import { linesToBid, type PriceFirmness, type QuoteRequestStatus } from "@/lib/precon/deal-move";
import type { BidPackage, ProspectBidQuote } from "@/lib/services/bids";
import type { CostCode } from "@/lib/types";
import { cn } from "@/lib/utils";
import "@/components/pipeline/pipeline.css";

export type LineFocus = { rowId: string; at: number };

const LEGEND: LineMark[] = ["firm", "allowance", "guess", "bid", "open"];

/**
 * The work: a calm list of lines, and one rail beside it that is either the
 * price (nothing open) or the line you opened. A line is priced by your own
 * number, an allowance or a trade's bid, and measuring it from plans makes
 * your own number firm. Marking a line for bids is all Pricing does about
 * bids; requesting, chasing and picking them is the Bids tab's job.
 */
export function PricingWorksheet({
  projectId,
  state,
  editable,
  available,
  packages,
  quotes,
  costCodes,
  firmness,
  requests,
  signable,
  clientName,
  focus,
  onPreview,
  onBids,
  onMeasure,
  prefetchPlans,
}: {
  projectId: string | null;
  state: ReturnType<typeof usePricingWorksheet>;
  editable: boolean;
  available: boolean;
  packages: BidPackage[];
  quotes: ProspectBidQuote[];
  costCodes: CostCode[];
  firmness: PriceFirmness;
  requests: QuoteRequestStatus[];
  signable: boolean;
  clientName: string;
  focus: LineFocus | null;
  onPreview: () => void;
  /** Go to Bids, at the request for this line when there is one. */
  onBids: (rowId?: string) => void;
  /** Measure a line on the plans, full screen over the deal; Done puts the quantity on it. */
  onMeasure: (rowId: string, unit: string) => void;
  /** Warm the plans while a line is open, so Measure opens without waiting on the sheet list. */
  prefetchPlans: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { worksheet, setWorksheet } = state;
  const [measurements, setMeasurements] = useState<ConditionRollup[]>([]);
  const [measurementsLoaded, setMeasurementsLoaded] = useState(false);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  // Measuring writes onto the lines; a new sync stamp is the cue to re-read the measurements.
  const synced = worksheet.rows.map((row) => (row.metadata.takeoff as { synced_at?: string } | undefined)?.synced_at ?? "").join();
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const refresh = () =>
      getConditionRollupAction({ project_id: projectId })
        .then((rows) => {
          if (!cancelled) {
            setMeasurements(rows);
            setMeasurementsLoaded(true);
            setMeasurementError(null);
          }
        })
        .catch(() => {
          if (!cancelled)
            setMeasurementError("Measurement status is unavailable. Open plans to review quantities.");
        });
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [projectId, synced]);

  const [openRowId, setOpenRowId] = useState<string | null>(null);
  useEffect(() => {
    if (openRowId) prefetchPlans();
  }, [openRowId, prefetchPlans]);
  const [walking, setWalking] = useState(false);
  const quoteIssues = worksheetQuoteIssues(worksheet, quotes);
  const unlinked = packages.filter(
    (pkg) =>
      !worksheet.requests.some((request) => request.package_id === pkg.id) && pkg.status !== "cancelled",
  );
  const order = [...new Set(worksheet.rows.map((row) => row.section))].flatMap((section) =>
    worksheet.rows.filter((row) => row.section === section),
  );
  const toPrice = linesToPrice(worksheet, firmness);
  const openRow = worksheet.rows.find((row) => row.id === openRowId) ?? null;
  const counts = { price: toPrice.length, bid: linesToBid(worksheet, requests).length, pick: 0, waiting: 0 };
  for (const row of worksheet.rows) {
    const kind = firmness.lines.get(row.id)?.kind;
    if (kind === "request_draft") counts.bid++;
    else if (kind === "quotes_in") counts.pick++;
    else if (kind === "awaiting_quotes") counts.waiting++;
  }

  function openLine(rowId: string) {
    setOpenRowId(rowId);
    requestAnimationFrame(() =>
      document
        .getElementById(`deal-line-${rowId}`)
        ?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" }),
    );
  }
  function close() {
    setOpenRowId(null);
    setWalking(false);
  }
  function step(direction: -1 | 1) {
    const next = order[order.findIndex((row) => row.id === openRowId) + direction];
    if (next) openLine(next.id);
  }
  function nextToPrice() {
    const next = toPrice.find((row) => row.id !== openRowId);
    if (next) {
      setWalking(true);
      openLine(next.id);
    } else {
      close();
      toast.success("Every line has a price.");
    }
  }
  useEffect(() => {
    if (!focus) return;
    openLine(focus.rowId);
    // A focus request is consumed once, by its timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at]);

  // Arrow keys walk the lines while one is open; Escape closes it.
  useEffect(() => {
    if (!openRowId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=listbox]")) return;
      if (event.key === "Escape") close();
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        step(event.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function patch(rowId: string, change: Partial<PricingRow>) {
    setWorksheet((current) => ({
      ...current,
      rows: current.rows.map((row) =>
        row.id === rowId
          ? {
              ...row,
              ...change,
              ...(("unit_cost_cents" in change || "quantity" in change || "basis" in change) &&
              row.metadata.source_bid_submission_id
                ? {
                    metadata: {
                      ...row.metadata,
                      ...change.metadata,
                      source_bid_submission_id: undefined,
                      bid_pricing_basis: undefined,
                    },
                  }
                : {}),
            }
          : row,
      ),
    }));
  }
  function remove(row: PricingRow) {
    const index = worksheet.rows.findIndex((item) => item.id === row.id);
    setWorksheet((current) => ({ ...current, rows: current.rows.filter((item) => item.id !== row.id) }));
    close();
    toast(`Removed ${row.description}`, {
      action: {
        label: "Undo",
        onClick: () =>
          setWorksheet((current) => {
            const rows = [...current.rows];
            rows.splice(index, 0, row);
            return { ...current, rows };
          }),
      },
    });
  }
  function move(rowId: string, direction: -1 | 1) {
    setWorksheet((current) => {
      const rows = [...current.rows];
      const index = rows.findIndex((item) => item.id === rowId);
      const other = index + direction;
      if (other >= 0 && other < rows.length) [rows[index], rows[other]] = [rows[other], rows[index]];
      return { ...current, rows };
    });
  }

  const openStatus = openRow ? (firmness.lines.get(openRow.id) ?? { kind: "open" as const }) : null;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="min-w-0 space-y-3">
        {!available && (
          <p role="alert" className="border-l-2 border-warning pl-3 text-sm">
            Pricing is unavailable right now. Documents already sent are unaffected.
          </p>
        )}
        {state.error && (
          <div role="alert" className="flex flex-wrap items-center gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <p className="mr-auto">{state.error}</p>
            <Button size="sm" variant="outline" disabled={state.saving} onClick={() => void state.save().catch(() => {})}>
              Retry save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void state
                  .reviewLatest()
                  .catch((error) => toast.error(error instanceof Error ? error.message : "Unable to load pricing"))
              }
            >
              Load latest saved pricing
            </Button>
          </div>
        )}
        {state.recovery && (
          <div role="alert" className="flex flex-wrap items-center gap-3 border bg-muted/40 px-3 py-2 text-sm">
            <p className="mr-auto">This browser has pricing edits that were never saved.</p>
            <Button size="sm" onClick={state.restoreRecovery}>Recover my edits</Button>
            <Button size="sm" variant="outline" onClick={state.discardRecovery}>Use saved pricing</Button>
          </div>
        )}
        {state.conflicts.length > 0 && (
          <div role="alert" className="max-h-64 overflow-auto border p-3 text-sm">
            <p className="font-medium">Someone else changed these at the same time</p>
            <ul className="my-3 space-y-2">
              {state.conflicts.map((conflict) => (
                <li key={conflict.field}>
                  <strong>
                    {worksheet.rows.find((row) => conflict.field.includes(row.id))?.description ?? "Pricing"} ·{" "}
                    {conflict.field.split(".").at(-1)?.replaceAll("_", " ")}
                  </strong>
                  <p>Yours: {JSON.stringify(conflict.local) ?? "Removed"}</p>
                  <p>Saved: {JSON.stringify(conflict.remote) ?? "Removed"}</p>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => state.resolveConflicts(true)}>Keep mine and save</Button>
              <Button size="sm" variant="outline" onClick={() => state.resolveConflicts(false)}>Use the saved version</Button>
            </div>
          </div>
        )}

        {worksheet.rows.length > 0 &&
          (counts.price || counts.bid || counts.pick || counts.waiting ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-warning/30 bg-warning/[0.06] py-2.5 pl-3.5 pr-3"
            >
              <p className="flex flex-1 flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px]">
                {[
                  counts.price > 0 && (
                    <span key="price">
                      <strong className="font-semibold tabular-nums">{counts.price}</strong> need a price
                    </span>
                  ),
                  counts.bid > 0 && (
                    <span key="bid">
                      <strong className="font-semibold tabular-nums">{counts.bid}</strong> to request bids
                    </span>
                  ),
                  counts.pick > 0 && (
                    <span key="pick">
                      <strong className="font-semibold tabular-nums">{counts.pick}</strong> with bids to pick
                    </span>
                  ),
                  counts.waiting > 0 && (
                    <span key="waiting" className="text-muted-foreground">
                      <strong className="font-semibold tabular-nums">{counts.waiting}</strong> waiting on trades
                    </span>
                  ),
                ]
                  .filter(Boolean)
                  .flatMap((item, index) => (index ? [<span key={`sep-${index}`} aria-hidden className="h-3.5 w-px bg-border" />, item] : [item]))}
              </p>
              {(counts.bid > 0 || counts.pick > 0) && (
                <Button size="sm" variant={toPrice.length ? "outline" : "default"} onClick={() => onBids()}>
                  Go to Bids
                  <ArrowRight className="size-3.5" />
                </Button>
              )}
              {toPrice.length > 0 && (
                <Button size="sm" onClick={nextToPrice}>
                  <Play className="size-3" />
                  Work through {toPrice.length}
                </Button>
              )}
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 border border-success/30 bg-success/[0.06] px-3.5 py-2.5 text-[13px]">
              <Check className="size-3.5 text-success" />
              Every line has a price.
            </p>
          ))}

        <div className="flex items-center gap-2.5 px-0.5 pt-1.5">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">The work</h2>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {worksheet.rows.length} line{worksheet.rows.length === 1 ? "" : "s"}
          </span>
          <span
            role="status"
            aria-live="polite"
            className={cn("ml-auto flex items-center gap-1 text-xs", state.error ? "text-destructive" : "text-muted-foreground")}
          >
            {state.saving ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Saving
              </>
            ) : state.error ? (
              "Not saved"
            ) : state.dirty ? (
              "Unsaved changes"
            ) : (
              <>
                <Check className="size-3" />
                Saved
              </>
            )}
          </span>
        </div>
        {measurementError && <p role="status" className="text-xs text-warning">{measurementError}</p>}

        <PricingLineList
          worksheet={worksheet}
          firmness={firmness}
          openRowId={openRowId}
          editable={editable}
          onOpen={(rowId) => {
            setWalking(false);
            if (openRowId === rowId) close();
            else openLine(rowId);
          }}
          onAdd={(_, rows) => setWorksheet((current) => {
            const at = current.rows.map((row) => row.section).lastIndexOf(rows[0]?.section ?? "");
            const next = [...current.rows];
            next.splice(at === -1 ? next.length : at + 1, 0, ...rows);
            return { ...current, rows: next };
          })}
        />

        <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-0.5 text-xs text-muted-foreground" aria-label="What the marks mean">
          {LEGEND.map((mark) => (
            <span key={mark} className="inline-flex items-center gap-1.5">
              <FirmnessMark mark={mark} className="size-2.5" />
              {mark === "firm" ? "Firm: a bid or a measurement" : MARK_LABEL[mark]}
            </span>
          ))}
        </div>

        {quoteIssues.length > 0 && (
          <div className="border-l-2 border-warning pl-3 text-xs text-warning">
            {quoteIssues.map((issue) => (
              <p key={issue} className="py-0.5">{issue}</p>
            ))}
          </div>
        )}
        {unlinked.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Bid requests not on a line ({unlinked.length})
            </summary>
            <div className="mt-2 divide-y border-y">
              {unlinked.map((pkg) => (
                <div key={pkg.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span>{pkg.title}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!editable}
                    onClick={() => {
                      const id = crypto.randomUUID();
                      const row = pricingRowSchema.parse({ id, description: pkg.title, notes: pkg.scope ?? "", basis: "quote" });
                      setWorksheet((current) => ({
                        ...current,
                        rows: [...current.rows, row],
                        requests: [
                          ...current.requests,
                          { package_id: pkg.id, row_ids: [id], scope_signature: scopeSignature([row]), quote: null },
                        ],
                      }));
                    }}
                  >
                    Add as a line
                    <Plus className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <aside
        aria-label={openRow ? openRow.description : "The price"}
        className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)]"
      >
        {openRow && openStatus ? (
          <PricingLineInspector
            key={openRow.id}
            row={openRow}
            worksheet={worksheet}
            status={openStatus}
            packages={packages}
            costCodes={costCodes}
            measurement={measurements.find(
              (item) =>
                item.condition.id ===
                ((openRow.metadata.takeoff_source ?? openRow.metadata.takeoff) as { condition_id?: string } | undefined)
                  ?.condition_id,
            )}
            measurementsLoaded={measurementsLoaded}
            editable={editable}
            walking={walking}
            toPrice={toPrice.filter((row) => row.id !== openRow.id).length}
            focusAt={focus?.rowId === openRow.id ? focus.at : undefined}
            onChange={(change) => patch(openRow.id, change)}
            onRemove={() => remove(openRow)}
            onMove={(direction) => move(openRow.id, direction)}
            onUnlink={() =>
              setWorksheet((current) => ({
                ...current,
                requests: current.requests.filter((request) => !request.row_ids.includes(openRow.id)),
              }))
            }
            onBids={() => onBids(openRow.id)}
            onMeasure={(unit) => onMeasure(openRow.id, unit)}
            onOpenLine={openLine}
            onStep={step}
            onNext={nextToPrice}
            onClose={close}
          />
        ) : (
          <PricingSummary
            worksheet={worksheet}
            setTerm={(term, value) => setWorksheet((current) => ({ ...current, [term]: value }))}
            firmness={firmness}
            signable={signable}
            clientName={clientName}
            editable={editable}
            onPreview={onPreview}
          />
        )}
      </aside>
    </div>
  );
}
