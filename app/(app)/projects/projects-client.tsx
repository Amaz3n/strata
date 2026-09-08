"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { OptimisticLink as Link } from "@/lib/navigation/optimistic-pathname";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  FolderOpen,
} from "@/components/icons";
import { toast } from "sonner";
import { deleteProjectAction } from "./actions";
import { unwrapAction } from "@/lib/action-result";
import type { ProductTier } from "@/lib/product-tier";
import type { ProjectScheduleSummary, ProjectStatus } from "@/lib/types";
import { terminology } from "@/lib/terminology";
import {
  directoryQueryKey,
  projectDirectoryQuerySchema,
  type ProjectDirectoryPage,
  type ProjectDirectoryQuery,
  type ProjectDirectoryRow,
} from "@/lib/projects/directory";

const ProjectEditor = dynamic(() =>
  import("./project-editor").then((m) => m.ProjectEditor),
);
const ProjectScheduleSheet = dynamic(() =>
  import("@/components/projects/project-schedule-sheet").then(
    (m) => m.ProjectScheduleSheet,
  ),
);
const statusLabels: Record<ProjectStatus, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "Paused",
  completed: "Complete",
  cancelled: "Canceled",
};
const statusColors: Record<ProjectStatus, string> = {
  planning: "bg-chart-3/20 text-chart-3",
  bidding: "bg-chart-2/20 text-chart-2",
  active: "bg-success/20 text-success",
  on_hold: "bg-warning/20 text-warning",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/20 text-destructive",
};

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load projects");
  return response.json();
}

export function ProjectsClient({
  initialPage,
  initialQuery,
  productTier,
  communities,
  communityId,
  canReadSchedule,
}: {
  initialPage: ProjectDirectoryPage;
  initialQuery: ProjectDirectoryQuery;
  productTier: ProductTier;
  communities: Array<{ id: string; name: string }>;
  communityId?: string;
  canReadSchedule: boolean;
}) {
  const params = useSearchParams();
  const paramsString = params.toString();
  const query = useMemo(
    () =>
      projectDirectoryQuerySchema.parse(
        Object.fromEntries(new URLSearchParams(paramsString)),
      ),
    [paramsString],
  );
  const key = directoryQueryKey(query);
  const initialKey = directoryQueryKey(initialQuery);
  const [search, setSearch] = useState(query.q);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    revision: number;
    page: ProjectDirectoryPage;
  } | null>(null);
  const [error, setError] = useState<{ key: string; revision: number } | null>(
    null,
  );
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [deleting, setDeleting] = useState<ProjectDirectoryRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [scheduleProject, setScheduleProject] =
    useState<ProjectDirectoryRow | null>(null);
  const terms = terminology(productTier);
  // Props stay authoritative after RSC revalidation. No copied project array
  // survives a community change; in-flight responses are cancelled on key changes.
  const page =
    revision === 0 && key === initialKey
      ? initialPage
      : loaded?.key === key && loaded.revision === revision
        ? loaded.page
        : null;
  const failed = error?.key === key && error.revision === revision;

  const changeQuery = useCallback(
    (changes: Record<string, string | undefined>, replace = false) => {
      const next = new URLSearchParams(paramsString);
      next.delete("cursor");
      for (const [name, value] of Object.entries(changes)) {
        if (value === undefined || value === "") next.delete(name);
        else next.set(name, value);
      }
      const url = `/projects${next.size ? `?${next}` : ""}`;
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    },
    [paramsString],
  );

  useEffect(() => {
    setSearch(query.q);
  }, [query.q]);
  useEffect(() => {
    setRevision(0);
    setLoaded(null);
  }, [initialPage, initialKey]);
  useEffect(() => {
    if (search.trim() === query.q) return;
    const timer = setTimeout(
      () => changeQuery({ q: search.trim() }, true),
      200,
    );
    return () => clearTimeout(timer);
  }, [search, query.q, changeQuery]);

  useEffect(() => {
    if (key === initialKey && revision === 0) return;
    const controller = new AbortController();
    readJson<ProjectDirectoryPage>(
      `/api/projects/directory?${paramsString}`,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setLoaded({ key, revision, page: result });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError({ key, revision });
      });
    return () => controller.abort();
  }, [key, initialKey, paramsString, revision]);

  const progress = useDirectoryProgress(
    page,
    canReadSchedule,
    query.sort,
    revision,
  );
  const retry = () => setRevision((n) => n + 1);
  async function confirmDelete() {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      unwrapAction(await deleteProjectAction(deleting.id));
      toast.success(`${terms.project} deleted`);
      setDeleting(null);
      retry();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to delete project",
      );
    } finally {
      setIsDeleting(false);
    }
  }
  function sort(column: ProjectDirectoryQuery["sort"]) {
    changeQuery({
      sort: column,
      direction:
        query.sort === column && query.direction === "asc" ? "desc" : "asc",
    });
  }
  function header(
    label: string,
    column: ProjectDirectoryQuery["sort"],
    className = "",
  ) {
    const active = query.sort === column;
    return (
      <th
        scope="col"
        className={`px-4 py-3 text-left font-medium ${className}`}
        aria-sort={
          active
            ? query.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button
          type="button"
          onClick={() => sort(column)}
          className="inline-flex items-center gap-1 hover:text-foreground"
          disabled={column === "progress" && !canReadSchedule}
        >
          {label}
          {active ? (
            query.direction === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-40" />
          )}
        </button>
      </th>
    );
  }

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-background"
      data-instant-shell="projects-directory"
      data-projects-ready={page ? "true" : "false"}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        {communities.length > 0 && (
          <Select
            value={query.community ?? communityId ?? "all"}
            onValueChange={(value) => changeQuery({ community: value })}
          >
            <SelectTrigger aria-label="Community" className="h-8 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All communities</SelectItem>
              {communities.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative min-w-40 flex-1 sm:max-w-64">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label={`Search ${terms.projects.toLowerCase()}`}
            placeholder={`Search ${terms.projects.toLowerCase()}…`}
            className="h-8 pl-8"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          value={query.status}
          onValueChange={(value) => changeQuery({ status: value })}
        >
          <SelectTrigger aria-label="Project status" className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(statusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          className="ml-auto h-8"
          size="sm"
          onClick={() => setEditor({ id: null })}
          onPointerEnter={() => void import("./project-editor")}
          onFocus={() => void import("./project-editor")}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New {terms.project.toLowerCase()}
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto"
        aria-busy={!page && !failed}
      >
        {failed ? (
          <div role="alert" className="p-8 text-center">
            Could not load projects.{" "}
            <Button variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : !page ? (
          <div className="space-y-2 p-4" aria-label="Loading projects">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : page.rows.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-6 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
            <h2 className="font-semibold">
              No {terms.projects.toLowerCase()} found
            </h2>
            <p className="text-sm text-muted-foreground">
              Try another search or filter, or create a{" "}
              {terms.project.toLowerCase()}.
            </p>
            {query.cursor && (
              <Button variant="outline" onClick={() => changeQuery({})}>
                First page
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm" aria-label={terms.projects}>
            <thead className="sticky top-0 z-10 border-b bg-background text-xs text-muted-foreground">
              <tr>
                {header(terms.project, "name")}
                {header(terms.owner, "client", "hidden md:table-cell")}
                <th
                  scope="col"
                  className="hidden px-4 text-left font-medium lg:table-cell"
                >
                  Address
                </th>
                {header("Status", "status")}
                {header("Progress", "progress", "hidden md:table-cell")}
                {header("Value", "value", "hidden md:table-cell")}
                <th scope="col" className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {page.rows.map((row) => {
                const summary = row.summary ?? progress.summaries[row.id];
                return (
                  <tr
                    key={row.id}
                    data-project-row={row.id}
                    className="hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${row.id}`}
                        prefetchOnIntent
                        className="font-medium hover:text-primary"
                      >
                        {row.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted-foreground lg:hidden">
                        {row.address}
                      </p>
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {row.client_name || "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                      {row.address || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={statusColors[row.status]}
                      >
                        {statusLabels[row.status]}
                      </Badge>
                    </td>
                    <td className="hidden w-40 px-4 py-3 md:table-cell">
                      {summary?.total ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2"
                          aria-label={`View schedule for ${row.name}`}
                          onClick={() =>
                            setScheduleProject({ ...row, summary })
                          }
                        >
                          <Progress
                            value={summary.percent}
                            className="h-1.5 flex-1"
                          />
                          <span className="text-xs tabular-nums">
                            {summary.percent}%
                          </span>
                        </button>
                      ) : progress.loading ? (
                        <Skeleton className="h-2 w-16" />
                      ) : progress.error ? (
                        <button
                          className="text-xs text-muted-foreground"
                          onClick={progress.retry}
                        >
                          Retry progress
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums md:table-cell">
                      {row.value_cents === null
                        ? "—"
                        : `$${(row.value_cents / 100).toLocaleString()}`}
                    </td>
                    <td className="px-2 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`Actions for ${row.name}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => setEditor({ id: row.id })}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleting(row)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {page && (
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {page.rows.length} {terms.projects.toLowerCase()} on this page
          </span>
          <div className="flex gap-2">
            {query.cursor && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => changeQuery({})}
              >
                First page
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!page.nextCursor}
              onClick={() =>
                changeQuery({ cursor: page.nextCursor ?? undefined })
              }
            >
              Next page
            </Button>
          </div>
        </div>
      )}
      {editor && (
        <ProjectEditor
          key={editor.id ?? "create"}
          projectId={editor.id}
          productTier={productTier}
          onClose={() => setEditor(null)}
          onSaved={retry}
        />
      )}
      {scheduleProject && (
        <ProjectScheduleSheet
          open
          onOpenChange={(open) => {
            if (!open) setScheduleProject(null);
          }}
          projectId={scheduleProject.id}
          projectName={scheduleProject.name}
          summary={scheduleProject.summary}
        />
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the project and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function useDirectoryProgress(
  page: ProjectDirectoryPage | null,
  enabled: boolean,
  sort: string,
  revision: number,
) {
  const ids =
    page?.rows
      .map((row) => row.id)
      .sort()
      .join(",") ?? "";
  const key = `${ids}:${revision}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    attempt: number;
    summaries: Record<string, ProjectScheduleSummary>;
    error: boolean;
  } | null>(null);
  const needsFetch = enabled && sort !== "progress" && !!ids;
  useEffect(() => {
    if (!needsFetch) return;
    const controller = new AbortController();
    readJson<Record<string, ProjectScheduleSummary>>(
      `/api/projects/directory/progress?ids=${ids}`,
      controller.signal,
    )
      .then((summaries) => {
        if (!controller.signal.aborted)
          setState({ key, attempt, summaries, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ key, attempt, summaries: {}, error: true });
      });
    return () => controller.abort();
  }, [key, ids, needsFetch, attempt]);
  const current =
    state?.key === key && state.attempt === attempt ? state : null;
  return {
    summaries: current?.summaries ?? {},
    loading: needsFetch && !current,
    error: !!current?.error,
    retry: () => setAttempt((n) => n + 1),
  };
}
