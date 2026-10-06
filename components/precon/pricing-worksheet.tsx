"use client";

import {
  beginWorksheetMeasurementAction,
  getConditionRollupAction,
} from "@/app/(app)/drawings/takeoff-actions";
import { unwrapAction } from "@/lib/action-result";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, SlidersHorizontal, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkSelectionIsland } from "@/components/ui/bulk-selection-island";
import { PricingScopeRow } from "./pricing-scope-row";
import { PricingQuotesSheet } from "./pricing-quotes-sheet";
import { usePricingQuotes } from "./use-pricing-quotes";
import type { usePricingWorksheet } from "./use-pricing-worksheet";
import {
  pricingRowSchema,
  worksheetTotals,
  worksheetQuoteIssues,
  scopeSignature,
  type PricingRow,
} from "@/lib/precon/pricing-worksheet";
import type { PriceFirmness } from "@/lib/precon/deal-move";
import type { BidPackage, ProspectBidQuote } from "@/lib/services/bids";
import type { Company, CostCode } from "@/lib/types";
import { money } from "@/lib/precon/format";
import "@/components/pipeline/pipeline.css";

export type LineFocus = { rowId: string; mode: "expand" | "quotes"; at: number };

/**
 * The work: every line of the job and how it is priced. A line is priced by your
 * own number, an allowance, or a trade's quote, and measuring it from plans makes
 * your own number firm. The client's document is a snapshot of these lines.
 */
export function PricingWorksheet({
  prospectId,
  projectId,
  state,
  editable,
  available,
  packages,
  companies,
  quotes,
  costCodes,
  firmness,
  focus,
}: {
  prospectId: string;
  projectId: string | null;
  state: ReturnType<typeof usePricingWorksheet>;
  editable: boolean;
  available: boolean;
  packages: BidPackage[];
  companies: Company[];
  quotes: ProspectBidQuote[];
  costCodes: CostCode[];
  firmness: PriceFirmness;
  focus: LineFocus | null;
}) {
  const router = useRouter();
  const quoteData = usePricingQuotes(prospectId);
  const reducedMotion = useReducedMotion();
  const { worksheet, setWorksheet } = state;
  const [measurements, setMeasurements] = useState<ConditionRollup[]>([]);
  const [measurementsLoaded, setMeasurementsLoaded] = useState(false);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
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
  }, [projectId]);
  const [newScope, setNewScope] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [quotePanel, setQuotePanel] = useState<{ rowIds: string[]; packageId?: string } | null>(null);
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1100);
  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const inspectorRef = useRef<HTMLElement>(null);
  const mobileInspector = workspaceWidth < 768 && !!quotePanel;
  useEffect(() => {
    if (!mobileInspector) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inspectorRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']")
      ?.focus();
    return () => previous?.focus();
  }, [mobileInspector]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [removed, setRemoved] = useState<{ row: PricingRow; index: number } | null>(null);
  const totals = worksheetTotals(worksheet);
  const quoteIssues = worksheetQuoteIssues(worksheet, quotes);
  const sections = [...new Set(worksheet.rows.map((row) => row.section))];
  const unlinked = packages.filter(
    (pkg) =>
      !worksheet.requests.some((request) => request.package_id === pkg.id) && pkg.status !== "cancelled",
  );

  function openQuotes(ids: string[], packageId?: string) {
    setQuotesExpanded(false);
    setQuotePanel({ rowIds: ids, packageId });
  }
  useEffect(() => {
    if (!focus) return;
    document
      .getElementById(`deal-line-${focus.rowId}`)
      ?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    if (focus.mode !== "quotes") return;
    const request = worksheet.requests.find((item) => item.row_ids.includes(focus.rowId));
    openQuotes(request?.row_ids ?? [focus.rowId], request?.package_id);
    // A focus request is consumed once, by its timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at]);

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
  function addScope() {
    if (!newScope.trim()) return;
    setWorksheet((current) => ({
      ...current,
      rows: [...current.rows, pricingRowSchema.parse({ id: crypto.randomUUID(), description: newScope.trim() })],
    }));
    setNewScope("");
  }
  const openPlans = (row: PricingRow, unit: string) =>
    startTransition(async () => {
      try {
        if (editable) await state.save();
        router.push(unwrapAction(await beginWorksheetMeasurementAction(prospectId, row.id, unit)));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to open plans");
      }
    });

  return (
    <div ref={workspaceRef} className="relative flex min-h-0">
      <div inert={mobileInspector ? true : undefined} className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">The work</h2>
          <span
            role="status"
            aria-live="polite"
            className={`flex items-center gap-1.5 text-xs ${state.error ? "text-destructive" : "text-muted-foreground"}`}
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
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => setSettingsOpen(!settingsOpen)}
            aria-expanded={settingsOpen}
          >
            <SlidersHorizontal className="size-3.5" />
            Margin, contingency & tax
          </Button>
        </div>
        {measurementError && <p role="status" className="pb-2 text-xs text-warning">{measurementError}</p>}
        {!available && (
          <p role="alert" className="border-l-2 border-warning pl-3 text-sm">
            Pricing is unavailable right now. Documents already sent are unaffected.
          </p>
        )}
        {state.error && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 border-l-2 border-destructive pl-3 text-sm">
            <p className="mr-auto">{state.error}</p>
            <Button size="sm" variant="outline" disabled={state.saving} onClick={() => void state.save().catch(() => {})}>
              Retry save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void state.reviewLatest().catch((error) => toast.error(error instanceof Error ? error.message : "Unable to load pricing"))}
            >
              Load latest saved pricing
            </Button>
          </div>
        )}
        {state.recovery && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 border bg-muted/40 p-3 text-sm">
            <p className="mr-auto">This browser has pricing edits that were never saved.</p>
            <Button size="sm" onClick={state.restoreRecovery}>Recover my edits</Button>
            <Button size="sm" variant="outline" onClick={state.discardRecovery}>Use saved pricing</Button>
          </div>
        )}
        {state.conflicts.length > 0 && (
          <div role="alert" className="mb-3 max-h-64 overflow-auto border p-3 text-sm">
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
        {settingsOpen && (
          <fieldset disabled={!editable} className="mb-3 grid gap-4 border bg-muted/30 p-4 sm:grid-cols-3">
            {(
              [
                ["markup_percent", "Your margin", 1000],
                ["contingency_percent", "Contingency", 100],
                ["tax_rate", "Tax", 100],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key} className="space-y-1.5 text-xs text-muted-foreground">
                {label} %
                <Input
                  type="number"
                  min="0"
                  max={max}
                  step="0.1"
                  value={worksheet[key]}
                  onChange={(event) => setWorksheet((current) => ({ ...current, [key]: Number(event.target.value) }))}
                />
              </label>
            ))}
          </fieldset>
        )}
        <DealFirmnessBar firmness={firmness} />
        <div className="mt-3 overflow-x-auto border">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead className="border-b bg-muted/40 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr className="h-9">
                <th className="w-10 pl-3">
                  <Checkbox
                    aria-label="Select every line"
                    disabled={!editable || !worksheet.rows.length}
                    checked={selected.length === worksheet.rows.length && !!selected.length}
                    onCheckedChange={(checked) => setSelected(checked ? worksheet.rows.map((row) => row.id) : [])}
                  />
                </th>
                <th className="font-medium">Line</th>
                <th className="px-3 font-medium">Priced by</th>
                <th className="px-3 text-right font-medium">Cost</th>
                <th className="w-24 pr-3" aria-label="Line actions" />
              </tr>
            </thead>
            <tbody>
              {!worksheet.rows.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No lines yet. Add the first piece of work below.
                  </td>
                </tr>
              )}
              {sections.map((section) => (
                <Fragment key={section}>
                  {section && (
                    <tr className="border-b bg-muted/20">
                      <td colSpan={5} className="px-4 py-2 text-xs font-medium">{section}</td>
                    </tr>
                  )}
                  {worksheet.rows
                    .filter((row) => row.section === section)
                    .map((row) => (
                      <PricingScopeRow
                        key={row.id}
                        row={row}
                        status={firmness.lines.get(row.id) ?? { kind: "open" }}
                        prospectId={prospectId}
                        onMeasure={(unit) => openPlans(row, unit)}
                        measurementsLoaded={measurementsLoaded}
                        measurement={measurements.find(
                          (item) =>
                            item.condition.id ===
                            ((row.metadata.takeoff_source ?? row.metadata.takeoff) as { condition_id?: string } | undefined)
                              ?.condition_id,
                        )}
                        worksheet={worksheet}
                        packages={packages}
                        costCodes={costCodes}
                        editable={editable && !pending}
                        selected={selected.includes(row.id)}
                        inspecting={quotePanel?.rowIds.includes(row.id) ?? false}
                        focusAt={focus?.mode === "expand" && focus.rowId === row.id ? focus.at : undefined}
                        onSelect={(value) =>
                          setSelected((ids) => (value ? [...ids, row.id] : ids.filter((id) => id !== row.id)))
                        }
                        onChange={(change) => patch(row.id, change)}
                        onRemove={() => {
                          setRemoved({ row, index: worksheet.rows.findIndex((item) => item.id === row.id) });
                          setWorksheet((current) => ({
                            ...current,
                            rows: current.rows.filter((item) => item.id !== row.id),
                          }));
                          setSelected((ids) => ids.filter((id) => id !== row.id));
                        }}
                        onMove={(direction) =>
                          setWorksheet((current) => {
                            const rows = [...current.rows];
                            const index = rows.findIndex((item) => item.id === row.id);
                            const other = index + direction;
                            if (other >= 0 && other < rows.length) [rows[index], rows[other]] = [rows[other], rows[index]];
                            return { ...current, rows };
                          })
                        }
                        onQuoteIntent={() => {
                          const request = worksheet.requests.find((item) => item.row_ids.includes(row.id));
                          if (request) void quoteData.load(request.package_id).catch(() => {});
                        }}
                        onQuotes={() => {
                          const request = worksheet.requests.find((item) => item.row_ids.includes(row.id));
                          openQuotes(request?.row_ids ?? [row.id], request?.package_id);
                        }}
                        onUnlink={() =>
                          setWorksheet((current) => ({
                            ...current,
                            requests: current.requests.filter((request) => !request.row_ids.includes(row.id)),
                          }))
                        }
                      />
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {editable && (
            <form
              className="flex items-center gap-2 border-t px-3 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                addScope();
              }}
            >
              <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                id="deal-add-line"
                aria-label="Add a line of work"
                className="border-0 bg-transparent shadow-none focus-visible:ring-0"
                placeholder="Add a line of work, e.g. Gutters"
                value={newScope}
                onChange={(event) => setNewScope(event.target.value)}
              />
              <Button type="submit" variant="ghost" size="sm" disabled={!newScope.trim()}>
                Add
              </Button>
            </form>
          )}
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t px-4 py-3 text-sm">
            <dt className="text-muted-foreground">Cost</dt>
            <dd className="text-right font-mono tabular-nums">{money(totals.cost)}</dd>
            <dt className="text-muted-foreground">Your margin</dt>
            <dd className="text-right font-mono tabular-nums">{money(totals.markup)}</dd>
            {totals.contingency > 0 && (
              <>
                <dt className="text-muted-foreground">Contingency</dt>
                <dd className="text-right font-mono tabular-nums">{money(totals.contingency)}</dd>
              </>
            )}
            {totals.tax > 0 && (
              <>
                <dt className="text-muted-foreground">Tax</dt>
                <dd className="text-right font-mono tabular-nums">{money(totals.tax)}</dd>
              </>
            )}
            <dt className="mt-1 border-t pt-2 font-semibold">Client price</dt>
            <dd className="mt-1 border-t pt-2 text-right font-mono text-base font-semibold tabular-nums">
              {totals.unpriced ? <span className="font-sans text-sm font-normal text-muted-foreground">Not every line is priced</span> : money(totals.total)}
            </dd>
          </dl>
        </div>
        {removed && (
          <p className="pt-2 text-xs text-muted-foreground">
            Removed {removed.row.description}.{" "}
            <button
              className="underline underline-offset-4"
              onClick={() => {
                setWorksheet((current) => {
                  const rows = [...current.rows];
                  rows.splice(removed.index, 0, removed.row);
                  return { ...current, rows };
                });
                setRemoved(null);
              }}
            >
              Undo
            </button>
          </p>
        )}
        {quoteIssues.length > 0 && (
          <div className="mt-3 border-l-2 border-warning pl-3 text-xs text-warning">
            {quoteIssues.map((issue) => (
              <p key={issue} className="py-0.5">{issue}</p>
            ))}
          </div>
        )}
        {unlinked.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Quote requests not on a line ({unlinked.length})
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
                      const row = pricingRowSchema.parse({ id, description: pkg.title, notes: pkg.scope ?? "" });
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
        <BulkSelectionIsland count={quotePanel ? 0 : selected.length} label="Selected lines" onClear={() => setSelected([])}>
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending ||
              selected.some((id) => worksheet.requests.some((request) => request.row_ids.includes(id)))
            }
            onClick={() => openQuotes(selected)}
          >
            Get one quote for these
          </Button>
          {selected.some((id) => worksheet.requests.some((request) => request.row_ids.includes(id))) && (
            <span className="max-w-52 text-xs text-muted-foreground">Some of these already have a quote request.</span>
          )}
        </BulkSelectionIsland>
      </div>
      <AnimatePresence initial={false}>
        {quotePanel && (
          <motion.aside
            key="pricing-inspector"
            ref={inspectorRef}
            role={mobileInspector ? "dialog" : undefined}
            aria-modal={mobileInspector || undefined}
            aria-label="Quotes"
            style={{ position: mobileInspector ? "absolute" : "relative" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuotePanel(null);
                setSelected([]);
                router.refresh();
              }
              if (!mobileInspector || event.key !== "Tab") return;
              const focusable = Array.from(
                inspectorRef.current?.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex='0']",
                ) ?? [],
              ).filter((element) => element.getClientRects().length > 0);
              const first = focusable[0],
                last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
            initial={reducedMotion ? false : { width: 0, opacity: 0, x: 24 }}
            animate={{
              width:
                workspaceWidth < 768
                  ? workspaceWidth
                  : quotesExpanded
                    ? Math.max(420, Math.min(1000, workspaceWidth - 160))
                    : 420,
              opacity: 1,
              x: 0,
            }}
            exit={reducedMotion ? { opacity: 0 } : { width: 0, opacity: 0, x: 24 }}
            transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="inset-y-0 right-0 z-40 ml-4 min-h-0 shrink-0 self-start overflow-hidden border bg-background"
          >
            <div className="h-full w-full min-w-0">
              <PricingQuotesSheet
                key={quotePanel.packageId ?? quotePanel.rowIds.join(":")}
                initialData={quotePanel.packageId ? quoteData.read(quotePanel.packageId) : undefined}
                loadQuotes={quoteData.load}
                wide={quotesExpanded}
                onWideChange={setQuotesExpanded}
                prospectId={prospectId}
                rowIds={quotePanel.rowIds}
                packageId={quotePanel.packageId}
                worksheet={worksheet}
                companies={companies}
                editable={editable}
                onClose={() => {
                  setQuotePanel(null);
                  setSelected([]);
                  router.refresh();
                }}
                save={state.save}
                getVersion={() => state.version.current}
                onSaved={state.accept}
              />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

/** How much of the price is real. Firm reads green, held amounts neutral, guesses hatched amber. */
export function DealFirmnessBar({ firmness }: { firmness: PriceFirmness }) {
  const share = (value: number) => (firmness.cost ? `${(value / firmness.cost) * 100}%` : "0%");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border px-4 py-3">
      <div
        className="flex h-2 overflow-hidden bg-muted"
        role="img"
        aria-label={`${Math.round(firmness.firmShare * 100)}% of cost is firm`}
      >
        <span className="h-full bg-success" style={{ width: share(firmness.firm) }} />
        <span className="h-full bg-muted-foreground/50" style={{ width: share(firmness.allowance) }} />
        <span className="firmness-guess h-full" style={{ width: share(firmness.guess) }} />
      </div>
      <p className="row-span-2 text-right">
        <span className="block font-mono text-xl font-semibold tabular-nums">{Math.round(firmness.firmShare * 100)}%</span>
        <span className="block text-[11px] text-muted-foreground">of cost is firm</span>
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="size-2 bg-success" aria-hidden />
          Firm <span className="font-mono tabular-nums text-foreground">{money(firmness.firm)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <i className="size-2 bg-muted-foreground/50" aria-hidden />
          Allowance <span className="font-mono tabular-nums text-foreground">{money(firmness.allowance)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <i className="firmness-guess size-2" aria-hidden />
          Your guesses <span className="font-mono tabular-nums text-foreground">{money(firmness.guess)}</span>
        </span>
        {firmness.unpriced > 0 && (
          <span className="font-medium text-warning">{firmness.unpriced} not priced</span>
        )}
      </div>
    </div>
  );
}
