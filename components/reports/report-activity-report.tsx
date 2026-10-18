"use client";
import { DateField } from "@/components/ui/date-field";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Settings2 } from "lucide-react";
import { loadAccountActivityAction } from "@/app/(app)/books/actions";
import { PageLayout } from "@/components/layout/page-layout";
import { Button } from "@/components/ui/button";
import { ReportChart } from "./report-chart";
import { ReportBody } from "./report-body";
import { ReportCustomizer, Field } from "./report-customizer";
import {
  accountActivityResult,
  type ActivityData,
} from "@/lib/reports/activity-result";
import {
  customizeReport,
  emptyLayout,
  tableLayoutSchema,
} from "@/lib/reports/builder";
import { reportToCsv } from "@/lib/reports/export-csv";
import type { ReportActivity } from "@/lib/reports/types";
export function ReportActivityReport({
  target,
  parentTitle,
  prefix,
  onBack,
}: {
  target: ReportActivity;
  parentTitle: string;
  prefix: string;
  onBack: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [from, setFrom] = useState(target.startDate),
    [to, setTo] = useState(target.endDate);
  const [data, setData] = useState<ActivityData | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState(emptyLayout),
    [customize, setCustomize] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    if (!from || !to || from > to) {
      setLoading(false);
      setError("Choose a valid start and end date.");
      return;
    }
    const timer = setTimeout(() => {
      loadAccountActivityAction({ ...target, startDate: from, endDate: to })
        .then((response) => {
          if (!active) return;
          if (response.success) setData(response.data as ActivityData);
          else setError(response.error ?? "Could not load transactions.");
        })
        .catch(() => {
          if (active) setError("Could not load transactions.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [target, from, to]);
  const base = useMemo(
    () => (data ? accountActivityResult(data) : null),
    [data],
  );
  const result = useMemo(
    () => (base ? customizeReport(base, layout) : null),
    [base, layout],
  );
  const title = `${target.code} ${target.name}`;
  function download() {
    if (!result) return;
    const blob = new Blob(
      [reportToCsv({ ...result, subtitle: `${title}${target.dimension ? ` · ${target.dimension.label}` : ""} · ${result.subtitle}` })],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `account-transactions-${from}-${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <PageLayout
      title="Transaction detail"
      breadcrumbs={[
        { label: "Reports", href: prefix },
        { label: parentTitle, onClick: onBack },
        { label: target.name },
      ]}
      fullBleed
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/10 p-4">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back to report
          </Button>
          <Field label="From">
            <DateField value={from} onChange={(value) => setFrom(value)} />
          </Field>
          <Field label="Through">
            <DateField value={to} onChange={(value) => setTo(value)} />
          </Field>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              id="detail-customize-toggle"
              aria-expanded={customize}
              disabled={!result}
              onClick={() => setCustomize(!customize)}
            >
              <Settings2 className="size-4" />
              Customize
            </Button>
            <Button disabled={!result || loading} onClick={download}>
              <Download className="size-4" />
              Export CSV
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-6 xl:flex-row">
          <div className="min-w-0 flex-1 rounded-xl border p-5 sm:p-8">
            <header className="space-y-2 pb-8 text-center">
              <h1 className="text-xl font-semibold">
                Transaction detail by account
              </h1>
              <p className="text-sm">{title}</p>
              <p className="text-xs text-muted-foreground">
                {from} through {to} · Accrual basis
                {target.projectName
                  ? ` · ${target.projectName}`
                  : target.unassignedOnly
                    ? " · Unassigned project"
                    : ""}
                {target.dimension ? ` · ${target.dimension.label}` : ""}
              </p>
            </header>
            {loading && (
              <p
                role="status"
                className="py-12 text-center text-sm text-muted-foreground"
              >
                Loading transactions…
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {result && !loading && (
              <>
                {result.tables
                  .filter((t) => t.chart)
                  .map((t) => (
                    <ReportChart key={t.key} table={t} />
                  ))}
                <ReportBody
                  result={result}
                  drilldown={false}
                  sorting={layout.tables}
                  onSort={(table, column) => {
                    const current = tableLayoutSchema.parse(
                      layout.tables[table] ?? {},
                    );
                    setLayout({
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
                  }}
                />
              </>
            )}
          </div>
          <AnimatePresence>
            {customize && base && (
              <motion.div
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: reducedMotion ? 0 : 0.2 }}
                className="fixed top-16 right-0 bottom-0 z-40 w-[340px] max-w-[calc(100vw-2rem)] shrink-0 overflow-y-auto bg-background p-4 pb-24 xl:static xl:z-auto xl:w-[320px] xl:max-w-none xl:p-0"
              >
                <ReportCustomizer
                  result={base}
                  layout={layout}
                  onChange={setLayout}
                  onClose={() => {
                    setCustomize(false);
                    document.getElementById("detail-customize-toggle")?.focus();
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </PageLayout>
  );
}
