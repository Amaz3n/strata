"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  FileText,
  Search,
  Star,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReportSelect, ReportOption } from "./report-select";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  REPORT_COLLECTIONS,
  reportCollection,
} from "@/lib/reports/collections";
import { deleteReportAction } from "@/app/(app)/reports/actions";
import type { ReportRunDTO } from "@/lib/services/report-runs";
import { cn } from "@/lib/utils";

export type LibraryReport = {
  slug: string;
  title: string;
  summary: string;
  group: string;
  href: string;
};
export type LibrarySavedReport = {
  id: string;
  name: string;
  slug: string;
  scope: string;
  project_id: string | null;
  params: Record<string, string>;
  owned: boolean;
};
export function ReportLibrary({
  reports,
  saved,
  runs,
  projectId,
}: {
  reports: LibraryReport[];
  saved: LibrarySavedReport[];
  runs: ReportRunDTO[];
  projectId?: string;
}) {
  const searchParams = useSearchParams();
  const [collection, setCollection] = useState(
    searchParams.get("collection") ?? "all",
  );
  const requestedCollection = searchParams.get("collection") ?? "all";
  useEffect(() => setCollection(requestedCollection), [requestedCollection]);
  const [view, setView] = useState("templates");
  const [query, setQuery] = useState("");
  const reportListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    reportListRef.current?.scrollTo({ top: 0 });
  }, [collection, view, query]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderSlug, setBuilderSlug] = useState("");
  const [builderName, setBuilderName] = useState("");
  const [builderQuery, setBuilderQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const matches = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase());
  const templates = reports.filter(
    (r) =>
      r.slug !== "report-packet" &&
      matches(`${r.title} ${r.summary}`) &&
      (collection === "all" ||
        reportCollection(r.slug, r.group) === collection),
  );
  const savedRows = saved.filter(
    (r) =>
      (!projectId || r.project_id === projectId) &&
      matches(r.name) &&
      (view !== "saved" || r.owned) &&
      (view !== "favorites" || r.params._favorite === "1") &&
      (view !== "team" || r.params._visibility === "team"),
  );
  const openBuilder = () => {
    setBuilderOpen(true);
    setBuilderQuery("");
  };
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col overflow-hidden px-5 py-5 sm:px-8 lg:px-10">
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:grid-rows-1 lg:gap-8">
        <aside className="min-h-0 space-y-4 lg:overflow-y-auto">
          <nav
            aria-label="Report library"
            className="flex flex-wrap gap-1 lg:flex-col"
          >
            {[
              ["templates", "Report library"],
              ["saved", "My reports"],
              ["favorites", "Favorites"],
              ["history", "Snapshots"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={cn(
                  "rounded-md px-3 py-2 text-left text-sm transition-colors",
                  view === key
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                {label}
              </button>
            ))}
          </nav>
          {view === "templates" && (
            <nav
              aria-label="Report collections"
              className="hidden space-y-1 border-t pt-5 lg:block"
            >
              <p className="px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Collections
              </p>
              {REPORT_COLLECTIONS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setCollection(key)}
                  className={cn(
                    "block w-full rounded-md px-3 py-2 text-left text-xs",
                    collection === key
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b pb-4">
            <Search className="size-4 text-muted-foreground" />
            <Input
              id="report-search"
              aria-label="Search reports"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a report, metric, or question…"
              className="min-w-40 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="ml-auto flex shrink-0 gap-2">
              <Button onClick={openBuilder}>
                <Plus className="size-4" />
                Build a report
              </Button>
            </div>
          </div>
          {view === "templates" && (
            <div className="py-3 lg:hidden">
              <ReportSelect
                aria-label="Report collection"
                value={collection}
                onValueChange={setCollection}
                className="w-full"
              >
                {REPORT_COLLECTIONS.map(([key, label]) => (
                  <ReportOption key={key} value={key}>
                    {label}
                  </ReportOption>
                ))}
              </ReportSelect>
            </div>
          )}
          <div
            ref={reportListRef}
            aria-label="Reports"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5 pr-1 pb-8"
          >
            {view === "templates" ? (
              <>
                <div className="mb-4 flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold tracking-tight">
                    {REPORT_COLLECTIONS.find(
                      ([key]) => key === collection,
                    )?.[1] ?? "Report library"}
                  </h2>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {templates.map((report) => (
                    <Link
                      key={report.slug}
                      href={report.href}
                      className="group flex min-h-32 items-start gap-4 rounded-lg border bg-background p-5 transition-colors hover:border-foreground/30 hover:bg-muted/20"
                    >
                      <div className="rounded-md border bg-muted/30 p-2">
                        <FileText className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium tracking-tight">
                          {report.title}
                        </p>
                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                          {report.summary}
                        </p>
                        <p className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {report.slug.startsWith("books-")
                            ? "Arc Books"
                            : "Arc operations"}
                        </p>
                      </div>
                      <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </Link>
                  ))}
                </div>
                {!templates.length && (
                  <Empty text="No matching reports. Try another collection or search." />
                )}
              </>
            ) : view === "history" ? (
              <div className="divide-y rounded-lg border">
                {runs
                  .filter((r) => matches(r.title))
                  .map((run) => (
                    <Link
                      key={run.id}
                      className="flex items-center justify-between gap-4 p-4 hover:bg-muted/30"
                      href={`${run.projectId ? `/projects/${run.projectId}/reports` : "/reports"}/${run.slug}?run=${run.id}`}
                    >
                      <div>
                        <p className="text-sm font-medium">{run.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.subtitle}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(run.createdAt).toLocaleDateString()}
                      </span>
                    </Link>
                  ))}
                {!runs.length && (
                  <Empty text="Snapshots preserve the numbers exactly as they were when you exported or saved them." />
                )}
              </div>
            ) : (
              <div className="divide-y rounded-lg border">
                {savedRows.map((report) => (
                  <div
                    key={report.id}
                    className="flex items-center gap-3 px-4 py-4"
                  >
                    <Link
                      className="min-w-0 flex-1"
                      href={`${report.project_id ? `/projects/${report.project_id}/reports` : "/reports"}/${report.slug}?config=${report.id}`}
                    >
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {report.params._favorite === "1" && (
                          <Star className="size-3 fill-current" />
                        )}
                        {report.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {report.slug === "report-packet"
                          ? "Packet"
                          : (reports.find((r) => r.slug === report.slug)
                              ?.title ?? "Saved report")}
                      </p>
                    </Link>
                    {report.owned && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${report.name}`}
                        disabled={pending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete “${report.name}” and its saved settings?`,
                            )
                          )
                            startTransition(async () => {
                              try {
                                await deleteReportAction(report.id);
                                router.refresh();
                              } catch {
                                toast.error("Could not delete report.");
                              }
                            });
                        }}
                      >
                        <Trash2 className="size-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                ))}
                {!savedRows.length && (
                  <Empty text="Start with a template, customize it, and save a report for your next review." />
                )}
              </div>
            )}
          </div>
        </main>
      </div>
      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Build a report</DialogTitle>
            <DialogDescription>
              Choose a starting report and name it. Then customize its columns,
              filters, and layout.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Find a starting report"
            placeholder="Find a starting report…"
            value={builderQuery}
            onChange={(e) => setBuilderQuery(e.target.value)}
          />
          <div
            className="max-h-64 space-y-2 overflow-y-auto"
            role="radiogroup"
            aria-label="Starting report"
          >
            {reports
              .filter(
                (r) =>
                  r.slug !== "report-packet" &&
                  `${r.title} ${r.summary}`
                    .toLowerCase()
                    .includes(builderQuery.toLowerCase()),
              )
              .map((report) => (
                <button
                  role="radio"
                  aria-checked={builderSlug === report.slug}
                  key={report.slug}
                  onClick={() => {
                    setBuilderSlug(report.slug);
                    setBuilderName(`Custom ${report.title}`);
                  }}
                  className={cn(
                    "w-full rounded border p-3 text-left transition-colors",
                    builderSlug === report.slug
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted",
                  )}
                >
                  <p className="text-sm font-medium">{report.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {report.summary}
                  </p>
                </button>
              ))}
          </div>
          <Input
            aria-label="New report name"
            placeholder="Report name"
            value={builderName}
            onChange={(e) => setBuilderName(e.target.value)}
            maxLength={120}
          />
          <Button
            disabled={!builderSlug || builderName.trim().length < 2}
            onClick={() => {
              const report = reports.find((r) => r.slug === builderSlug);
              if (!report) return;
              const query = new URLSearchParams({
                _name: builderName.trim(),
                customize: "1",
              });
              setBuilderOpen(false);
              router.push(
                `${report.href}${report.href.includes("?") ? "&" : "?"}${query}`,
              );
            }}
          >
            Open builder
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="px-6 py-16 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
