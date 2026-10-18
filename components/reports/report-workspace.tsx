"use client";
import { DateField } from "@/components/ui/date-field";
import { ReportSelect, ReportOption } from "./report-select";
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  History,
  RotateCcw,
  Save,
  Settings2,
  Star,
  Undo2,
  Redo2,
  RefreshCw,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageLayout } from "@/components/layout/page-layout";
import { ReportActivityReport } from "./report-activity-report";
import type { ClientReportParamSpec, ReportActivity } from "@/lib/reports/types";
import { ReportBody } from "./report-body";
import { ReportCustomizer, Field, controlClass } from "./report-customizer";
import { ReportChart } from "./report-chart";
import { motion, useReducedMotion } from "framer-motion";
import {
  tableLayoutSchema,
  customizeReport,
  parseLayout,
  type ReportLayout,
} from "@/lib/reports/builder";
import { PERIOD_PRESETS } from "@/lib/reports/params";
import type {
  ReportDefinition,
  ReportParams,
  ReportResult,
  ReportScopeContext,
} from "@/lib/reports/types";
import type { ReportRunDTO } from "@/lib/services/report-runs";
import {
  previewReportAction,
  saveReportAction,
  snapshotReportAction,
} from "@/app/(app)/reports/actions";
import { cn } from "@/lib/utils";

type Definition = Pick<
  ReportDefinition,
  "slug" | "title" | "summary" | "ambientScope"
> & { params?: ClientReportParamSpec[] };
type Saved = { id: string; name: string; owned: boolean };
export function ReportWorkspace({
  definition,
  context,
  params: initialParams,
  base: initialBase,
  fingerprint: initialFingerprint,
  snapshot,
  saved,
  lenses,
  packetReports,
}: {
  definition: Definition;
  context: ReportScopeContext;
  params: ReportParams;
  base: ReportResult;
  fingerprint: string;
  snapshot?: ReportRunDTO;
  saved?: Saved;
  packetReports: { id: string; name: string }[];
  lenses: {
    divisions: { id: string; name: string }[];
    communities: { id: string; name: string }[];
  };
}) {
  const router = useRouter();
  const [params, setParams] = useState(initialParams);
  const [preview, setPreview] = useState<{
    base: ReportResult;
    fingerprint: string;
  } | null>(null);
  const [history, setHistory] = useState<ReportLayout[]>([
    parseLayout(initialParams._layout),
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const layout = history[historyIndex];
  const [activity, setActivity] = useState<ReportActivity | null>(null);
  const searchParams = useSearchParams();
  const [customize, setCustomize] = useState(
    searchParams.get("customize") === "1",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [saveOpen, setSaveOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const [name, setName] = useState(
    saved?.name ?? initialParams._name ?? snapshot?.title ?? definition.title,
  );
  const [savedId, setSavedId] = useState(saved?.id);
  const [owned, setOwned] = useState(saved?.owned ?? true);
  const visibility = "private";
  const [favorite, setFavorite] = useState(initialParams._favorite === "1");
  const [savedState, setSavedState] = useState(
    stateKey(
      initialParams,
      parseLayout(initialParams._layout),
      saved?.name ?? initialParams._name ?? snapshot?.title ?? definition.title,
      initialParams._visibility ?? "private",
      initialParams._favorite === "1",
    ),
  );
  const serializedParams = JSON.stringify(params);
  const serializedInitialParams = JSON.stringify(initialParams);
  // Server refreshes are authoritative for the server's parameters. Locally
  // edited filters keep their preview; presentation history stays independent.
  const useServerResult = serializedParams === serializedInitialParams || !preview;
  const base = useServerResult ? initialBase : preview.base;
  const fingerprint = useServerResult ? initialFingerprint : preview.fingerprint;
  const prefix = context.projectId
    ? `/projects/${context.projectId}/reports`
    : "/reports";
  const result = useMemo(
    () => (snapshot ? base : customizeReport(base, layout)),
    [base, layout, snapshot],
  );
  const dirty =
    savedState !== stateKey(params, layout, name, visibility, favorite);
  const busy = loading || pending || Boolean(error);
  function changeLayout(next: ReportLayout) {
    const nextHistory = [...history.slice(0, historyIndex + 1), next].slice(
      -100,
    );
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  }
  function parameter(key: string, value: string) {
    setParams((previous) => ({ ...previous, [key]: value }));
    setLoading(true);
  }
  useEffect(() => {
    if (snapshot) return;
    if (serializedParams === serializedInitialParams) {
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      previewReportAction({
        slug: definition.slug,
        projectId: context.projectId,
        params: JSON.parse(serializedParams),
      })
        .then((report) => {
          if (active) {
            setPreview({ base: report.base, fingerprint: report.fingerprint });
          }
        })
        .catch((cause) => {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not refresh report.",
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      active = false;
    };
  }, [serializedParams, serializedInitialParams, definition.slug, context.projectId, snapshot]);
  const configuredParams = () => ({
    ...params,
    _layout: JSON.stringify(layout),
    _visibility: visibility,
    _favorite: favorite ? "1" : "0",
    _name: name,
  });
  async function save(copy = false) {
    const saved = await saveReportAction(
      {
        name,
        slug: definition.slug,
        scope: context.scope,
        project_id: context.projectId ?? null,
        division_id: params._division || null,
        community_id: params._community || null,
        params: configuredParams(),
        format: "pdf",
      },
      !copy && owned ? savedId : undefined,
    );
    setSavedId(saved.id);
    setOwned(true);
    setSaveOpen(false);
    setSavedState(stateKey(params, layout, name, visibility, favorite));
    window.history.replaceState(
      null,
      "",
      `${prefix}/${definition.slug}?config=${saved.id}`,
    );
    toast.success("Report saved");
    return saved.id;
  }
  function task(work: () => Promise<unknown>) {
    startTransition(async () => {
      try {
        await work();
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : "Something went wrong.",
        );
      }
    });
  }
  async function snapshotOrExport(format?: string) {
    const id =
      snapshot?.id ??
      (await snapshotReportAction(
        {
          slug: definition.slug,
          projectId: context.projectId,
          params: configuredParams(),
        },
        fingerprint,
        name,
      ));
    if (format)
      window.location.assign(
        `/api/reports/${definition.slug}?run=${id}&format=${format}${context.projectId ? `&projectId=${context.projectId}` : ""}`,
      );
    else {
      toast.success("Snapshot saved");
      router.push(`${prefix}/${definition.slug}?run=${id}`);
      router.refresh();
    }
  }
  if (activity)
    return (
      <ReportActivityReport
        target={activity}
        parentTitle={name}
        prefix={prefix}
        onBack={() => setActivity(null)}
      />
    );
  return (
    <div className="space-y-5">
      <PageLayout
        title={definition.title}
        breadcrumbs={[
          { label: "Reports", href: prefix },
          { label: definition.title },
        ]}
        fullBleed
      />
      <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-muted/10 p-4">
        {snapshot ? (
          <div className="flex flex-1 flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>
              <History className="mr-2 inline size-4" />
              Captured {new Date(snapshot.createdAt).toLocaleString()} · values
              are fixed. Drilldowns are disabled for historical evidence.
            </span>
            <Link
              className="shrink-0 underline"
              href={`${prefix}/${definition.slug}?${new URLSearchParams(snapshot.params).toString()}`}
            >
              Open live report
            </Link>
          </div>
        ) : (
          <div className="flex flex-1 flex-wrap items-end gap-4">
            {(definition.params ?? []).map((spec) => (
              <Field key={spec.key} label={spec.label}>
                {spec.kind === "date" ? (
                  <DateField
                    value={params[spec.key] ?? ""}
                    onChange={(value) => parameter(spec.key, value)}
                  />
                ) : spec.kind === "toggle" ? (
                  <input
                    aria-label={spec.label}
                    type="checkbox"
                    checked={params[spec.key] === "1"}
                    onChange={(e) =>
                      parameter(spec.key, e.target.checked ? "1" : "0")
                    }
                  />
                ) : (
                  <ReportSelect
                    aria-label={spec.label}
                    className={cn(controlClass, "min-w-36")}
                    value={params[spec.key] ?? ""}
                    onValueChange={(value) => parameter(spec.key, value)}
                  >
                    {(spec.kind === "period"
                      ? PERIOD_PRESETS
                      : spec.options
                    ).map((option) => (
                      <ReportOption key={option.value} value={option.value}>
                        {option.label}
                      </ReportOption>
                    ))}
                  </ReportSelect>
                )}
              </Field>
            ))}
            {params.period === "custom" && (
              <>
                <Field label="From">
                  <DateField
                    value={params._from ?? ""}
                    onChange={(value) => parameter("_from", value)}
                  />
                </Field>
                <Field label="Through">
                  <DateField
                    value={params._to ?? ""}
                    onChange={(value) => parameter("_to", value)}
                  />
                </Field>
              </>
            )}
            {definition.slug === "books-profit-loss" && (
              <>
                <Field label="Compare with">
                  <ReportSelect
                    aria-label="Compare with"
                    className={controlClass}
                    value={params.comparison ?? "prior_year"}
                    disabled={
                      params.monthly === "1" ||
                      (params.dimension ?? "account") !== "account"
                    }
                    onValueChange={(value) => parameter("comparison", value)}
                  >
                    <ReportOption value="prior_year">Prior year</ReportOption>
                    <ReportOption value="prior_period">
                      Prior period
                    </ReportOption>
                    <ReportOption value="none">No comparison</ReportOption>
                  </ReportSelect>
                </Field>
                <Field label="Rows">
                  <ReportSelect
                    aria-label="Statement dimension"
                    className={controlClass}
                    value={params.dimension ?? "account"}
                    onValueChange={(value) => parameter("dimension", value)}
                  >
                    {[
                      ["account", "Account"],
                      ["project", "Project"],
                      ["division_id", "Division"],
                      ["community_id", "Community"],
                      ["lot_id", "Lot"],
                      ["contract_id", "Contract"],
                      ["cost_code_id", "Cost code"],
                      ["cost_type", "Cost type"],
                      ["organization_id", "Organization"],
                    ].map(([value, label]) => (
                      <ReportOption key={value} value={value}>
                        {label}
                      </ReportOption>
                    ))}
                  </ReportSelect>
                </Field>
                <Field label="Columns">
                  <ReportSelect
                    aria-label="Statement columns"
                    className={controlClass}
                    value={params.monthly ?? "0"}
                    disabled={(params.dimension ?? "account") !== "account"}
                    onValueChange={(value) => parameter("monthly", value)}
                  >
                    <ReportOption value="0">Total & comparison</ReportOption>
                    <ReportOption value="1">Months</ReportOption>
                  </ReportSelect>
                </Field>
              </>
            )}
            {context.scope === "org" && definition.ambientScope && (
              <>
                <Field label="Division">
                  <ReportSelect
                    aria-label="Division scope"
                    className={controlClass}
                    value={params._division ?? ""}
                    onValueChange={(value) => parameter("_division", value)}
                  >
                    <ReportOption value="">All divisions</ReportOption>
                    {lenses.divisions.map((d) => (
                      <ReportOption key={d.id} value={d.id}>
                        {d.name}
                      </ReportOption>
                    ))}
                  </ReportSelect>
                </Field>
                {definition.ambientScope === "full" && (
                  <Field label="Community">
                    <ReportSelect
                      aria-label="Community scope"
                      className={controlClass}
                      value={params._community ?? ""}
                      onValueChange={(value) => parameter("_community", value)}
                    >
                      <ReportOption value="">All communities</ReportOption>
                      {lenses.communities.map((d) => (
                        <ReportOption key={d.id} value={d.id}>
                          {d.name}
                        </ReportOption>
                      ))}
                    </ReportSelect>
                  </Field>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh report"
              disabled={loading}
              onClick={() => {
                setParams({ ...params, _refresh: String(Date.now()) });
              }}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!snapshot && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Undo customization"
                disabled={historyIndex === 0}
                onClick={() => setHistoryIndex(historyIndex - 1)}
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Redo customization"
                disabled={historyIndex === history.length - 1}
                onClick={() => setHistoryIndex(historyIndex + 1)}
              >
                <Redo2 className="size-4" />
              </Button>
              <Button
                variant={customize ? "secondary" : "outline"}
                id="report-customize-toggle"
                aria-expanded={customize}
                aria-controls="report-customization"
                onClick={() => setCustomize(!customize)}
              >
                <Settings2 className="size-4" />
                Customize
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setSaveOpen(true)}
              >
                <Save className="size-4" />
                {dirty ? "Save changes" : "Save report"}
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={!snapshot && busy}>
                <Download className="size-4" />
                Export
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {["pdf", "csv", "json"].map((format) => (
                <DropdownMenuItem
                  key={format}
                  onClick={() => task(() => snapshotOrExport(format))}
                >
                  Download {format.toUpperCase()}
                </DropdownMenuItem>
              ))}
              {!snapshot && (
                <DropdownMenuItem
                  onClick={() => task(() => snapshotOrExport())}
                >
                  Save snapshot
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error} The canvas below shows the previous result.
        </div>
      )}
      <div className="flex flex-col items-start gap-6 xl:flex-row">
        <div
          className={cn(
            "min-w-0 flex-1 space-y-5 w-full rounded-xl border bg-background p-5 sm:p-8",
            loading && "opacity-60",
          )}
          aria-busy={loading}
        >
          <header className="space-y-2 pb-5 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-muted-foreground">
              {base.subtitle?.replace(/ · accrual$/i, "")}
            </p>
            {[
              "books-profit-loss",
              "books-balance-sheet",
              "books-trial-balance",
              "books-general-ledger",
            ].includes(definition.slug) && (
              <p className="text-xs text-muted-foreground">Accrual basis</p>
            )}
            {base.provenance?.status &&
              base.provenance.status !== "Official ledger" && (
                <p className="text-xs text-muted-foreground">
                  {base.provenance.status}
                </p>
              )}
            <span
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {loading
                ? "Updating report…"
                : dirty && !snapshot
                  ? "Unsaved changes"
                  : ""}
            </span>
          </header>
          {result.tables
            .filter((t) => t.chart)
            .map((table) => (
              <ReportChart key={table.key} table={table} />
            ))}
          <ReportBody
            sorting={layout.tables}
            onSort={
              snapshot
                ? undefined
                : (table, column) => {
                    const current = tableLayoutSchema.parse(
                      layout.tables[table] ?? {},
                    );
                    changeLayout({
                      ...layout,
                      tables: {
                        ...layout.tables,
                        [table]: {
                          ...current,
                          sortBy: column,
                          descending:
                            current.sortBy === column
                              ? !current.descending
                              : false,
                        },
                      },
                    });
                  }
            }
            result={result}
            onActivity={setActivity}
            drilldown={!snapshot && !loading && !error}
          />
        </div>
        {!snapshot && (
          <motion.aside
            id="report-customization"
            aria-label="Customize report"
            aria-hidden={!customize}
            inert={!customize}
            initial={false}
            animate={{
              width: customize ? 300 : 0,
              height: customize ? "auto" : 0,
              opacity: customize ? 1 : 0,
              marginLeft: customize ? 0 : -24,
            }}
            transition={{
              duration: reducedMotion ? 0 : 0.24,
              ease: [0.22, 1, 0.36, 1],
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setCustomize(false);
                document.getElementById("report-customize-toggle")?.focus();
              }
            }}
            className="fixed top-16 right-0 bottom-0 z-40 max-w-[calc(100vw-2rem)] shrink-0 overflow-hidden bg-background xl:static xl:z-auto xl:max-w-full"
          >
            <div className="max-h-[calc(100dvh-4rem)] w-[300px] max-w-full space-y-4 overflow-y-auto border-l p-4 pb-24 xl:max-h-none xl:border-0 xl:p-0">
              {definition.slug === "report-packet" && (
                <section className="space-y-3 rounded-lg border p-4">
                  <h2 className="text-sm font-semibold">Packet contents</h2>
                  <p className="text-xs text-muted-foreground">
                    Each report retains its saved period. Reorder sections
                    below.
                  </p>
                  {packetReports.map((report) => {
                    const members = JSON.parse(
                      params._packet ?? "[]",
                    ) as string[];
                    return (
                      <label
                        key={report.id}
                        className="flex items-center gap-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={members.includes(report.id)}
                          onChange={(e) =>
                            parameter(
                              "_packet",
                              JSON.stringify(
                                e.target.checked
                                  ? [...members, report.id]
                                  : members.filter((id) => id !== report.id),
                              ),
                            )
                          }
                        />
                        {report.name}
                      </label>
                    );
                  })}
                  {(JSON.parse(params._packet ?? "[]") as string[]).map(
                    (id, i, members) => (
                      <div className="flex items-center gap-2 text-xs" key={id}>
                        <span className="flex-1">
                          {i + 1}.{" "}
                          {packetReports.find((r) => r.id === id)?.name ??
                            "Unavailable report"}
                        </span>
                        {[-1, 1].map((delta) => (
                          <button
                            key={delta}
                            className="p-1 disabled:opacity-30"
                            aria-label={
                              delta < 0
                                ? "Move section up"
                                : "Move section down"
                            }
                            disabled={
                              i + delta < 0 || i + delta >= members.length
                            }
                            onClick={() => {
                              const next = [...members];
                              [next[i], next[i + delta]] = [
                                next[i + delta],
                                next[i],
                              ];
                              parameter("_packet", JSON.stringify(next));
                            }}
                          >
                            {delta < 0 ? (
                              <ArrowUp className="size-3" />
                            ) : (
                              <ArrowDown className="size-3" />
                            )}
                          </button>
                        ))}
                      </div>
                    ),
                  )}
                </section>
              )}
              <ReportCustomizer
                onClose={() => {
                  setCustomize(false);
                  document.getElementById("report-customize-toggle")?.focus();
                }}
                controls={
                  definition.slug === "books-profit-loss" ? (
                    <div className="space-y-3">
                      <Field label="Display columns">
                        <ReportSelect
                          aria-label="Display columns"
                          className={controlClass}
                          value={params.monthly ?? "0"}
                          onValueChange={(value) => parameter("monthly", value)}
                        >
                          <ReportOption value="0">
                            Total and comparison
                          </ReportOption>
                          <ReportOption value="1">Months</ReportOption>
                        </ReportSelect>
                      </Field>
                      <Field label="Comparison columns">
                        <ReportSelect
                          aria-label="Comparison columns"
                          className={controlClass}
                          disabled={params.monthly === "1"}
                          value={params.comparison ?? "prior_year"}
                          onValueChange={(value) =>
                            parameter("comparison", value)
                          }
                        >
                          <ReportOption value="none">None</ReportOption>
                          <ReportOption value="prior_year">
                            Prior year, change and change %
                          </ReportOption>
                          <ReportOption value="prior_period">
                            Prior period, change and change %
                          </ReportOption>
                        </ReportSelect>
                      </Field>
                    </div>
                  ) : undefined
                }
                result={base}
                layout={layout}
                onChange={changeLayout}
              />
            </div>
          </motion.aside>
        )}
      </div>
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this report</DialogTitle>
            <DialogDescription>
              Keep the layout, scope, and date rules for your next review.
              Relative dates advance automatically.
            </DialogDescription>
          </DialogHeader>
          <Field label="Report name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            <Star className="size-4" />
            Favorite
          </label>
          <div className="flex justify-end gap-2">
            {savedId && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => task(() => save(true))}
              >
                <Copy className="size-4" />
                Save a copy
              </Button>
            )}
            <Button
              disabled={pending || name.trim().length < 2}
              onClick={() => task(() => save())}
            >
              <Check className="size-4" />
              {pending ? "Saving…" : owned ? "Save report" : "Save my copy"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function stateKey(
  params: ReportParams,
  layout: ReportLayout,
  name: string,
  visibility: string,
  favorite: boolean,
) {
  const { _refresh, ...stable } = params;
  return JSON.stringify({ params: stable, layout, name, visibility, favorite });
}
