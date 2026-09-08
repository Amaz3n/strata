"use client";

import Link from "next/link";
import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

import { archiveCompanyAction, restoreCompanyAction } from "@/app/(app)/companies/actions";
import { archiveContactAction, restoreContactAction } from "@/app/(app)/contacts/actions";
import type { ProjectNavigationItem } from "@/lib/types";
import type {
  DirectoryEntry,
  DirectoryPageResult,
  DirectoryPageWindow,
  DirectorySortDirection,
  DirectorySortKey,
} from "@/lib/services/directory";
import type { PartyKind, RelationshipType } from "@/lib/directory/roles";
import type { DirectoryVendorData } from "@/lib/directory/vendor-data";
import type { terminology } from "@/lib/terminology";
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToastAction } from "@/components/ui/toast";
import { ComplianceAlert } from "@/components/directory/compliance-alert";
import { AddToDirectorySheet } from "@/components/directory/add-to-directory-sheet";
import { PortalInviteDialog } from "@/components/contacts/portal-invite-dialog";

import { DirectoryTable } from "@/components/directory/directory-table";
import { Download, Loader2, Plus, Search, SlidersHorizontal, Upload, X } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

import { unwrapAction } from "@/lib/action-result";
import { useOptimisticNavigate } from "@/lib/navigation/optimistic-pathname";

// The CSV wizard is the largest module on this route and most visits never open
// it, so it stays out of the initial list bundle.
const ImportContactsSheet = dynamic(() =>
  import("@/components/directory/import-contacts-sheet").then((m) => m.ImportContactsSheet),
);

interface DirectoryClientProps {
  entries: DirectoryEntry[];
  total: number;
  pageSize: number;
  relationshipTypes: RelationshipType[];
  /** First-page windows already paid for by the initial authenticated request. */
  initialPageCache: Record<string, DirectoryPageWindow>;
  /** Company-only decoration. It streams after rows and is never requested for Contacts. */
  vendorData?: Promise<DirectoryVendorData>;
  /** Tier vocabulary. The directory names the same table for three postures,
   *  so the nouns it prints have to come from the choke point. */
  terms: ReturnType<typeof terminology>;
  /** Commercial prequalification is division-scoped, so the list says which. */
  showPrequalTrades?: boolean;
  canCreate: boolean;
  canArchive?: boolean;
  kind: PartyKind;
  search: string;
  roleFilter: string;
  tradeFilter: string;
  sort: DirectorySortKey;
  direction: DirectorySortDirection;
  trades: string[];
}

/**
 * The directory's only navigation axis.
 *
 * This used to sit beside a second segmented control of role lenses (Vendors,
 * Clients, Design, Prospects, All). Two peer tab bars read as equals when they
 * are not — kind is WHICH LIST you are in, role is a filter on it — and the
 * 5x3 cross product had states that could never hold a row (a prospect is
 * never a company). Role now lives with Trade in the filter menu.
 */
const KIND_TABS: Array<{ key: PartyKind; label: string }> = [
  { key: "company", label: "Companies" },
  { key: "contact", label: "Contacts" },
];

function directoryPageKey(
  kind: PartyKind,
  search: string,
  role: string,
  trade: string,
  sort: DirectorySortKey,
  direction: DirectorySortDirection,
) {
  return [kind, search, role, trade, sort, direction].join("|");
}

function PendingComplianceAlert() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground"
    >
      <Loader2 className="size-3.5 animate-spin" />
      Checking vendor compliance…
    </div>
  );
}

function DeferredComplianceAlert({
  vendorData,
  terms,
}: {
  vendorData: Promise<DirectoryVendorData>;
  terms: ReturnType<typeof terminology>;
}) {
  const data = use(vendorData);
  return (
    <ComplianceAlert
      reviewQueue={data.complianceReviewQueue}
      companies={data.complianceWatchCompanies}
      complianceStatusByCompanyId={data.complianceStatusByCompanyId}
      watchTruncated={data.complianceWatchTruncated}
      watchTotal={data.complianceWatchTotal}
      statusUnavailable={data.statusUnavailable}
      vendorNoun={terms.vendor.toLowerCase()}
      vendorNounPlural={terms.vendors.toLowerCase()}
    />
  );
}

export function DirectoryClient({
  entries: initialEntries,
  total: initialTotal,
  pageSize,
  relationshipTypes,
  initialPageCache,
  vendorData,
  terms,
  showPrequalTrades = false,
  canCreate,
  canArchive = false,
  kind,
  search,
  roleFilter,
  tradeFilter,
  sort,
  direction,
  trades,
}: DirectoryClientProps) {
  const router = useRouter();
  const navigate = useOptimisticNavigate();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isArchivePending, startArchiveTransition] = useTransition();
  const [isNavigationPending, startNavigation] = useTransition();

  const [entries, setEntries] = useState<DirectoryEntry[]>(initialEntries);
  const [total, setTotal] = useState(initialTotal);
  const [loadedPage, setLoadedPage] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [activeKind, setActiveKind] = useState(kind);
  const [activeRoleFilter, setActiveRoleFilter] = useState(roleFilter);
  const [activeTradeFilter, setActiveTradeFilter] = useState(tradeFilter);
  const pageCache = useRef(new Map<string, DirectoryPageWindow>(Object.entries(initialPageCache)));

  const filterKey = `${kind}|${search}|${roleFilter}|${tradeFilter}|${sort}|${direction}`;
  const lastFilterKey = useRef(filterKey);
  const generation = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    // A new server render always resets the loaded window: either the filters
    // changed, or the same filters were re-fetched and page 1 is authoritative.
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      generation.current += 1;
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    }
    setEntries(initialEntries);
    setTotal(initialTotal);
    setLoadedPage(1);
    setIsLoadingMore(false);
    setActiveKind(kind);
    setActiveRoleFilter(roleFilter);
    setActiveTradeFilter(tradeFilter);
    for (const [key, page] of Object.entries(initialPageCache)) {
      pageCache.current.set(key, page);
    }
  }, [filterKey, initialEntries, initialPageCache, initialTotal, kind, roleFilter, tradeFilter]);

  const hasMore = entries.length < total;

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const fetchGeneration = generation.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    try {
      const next = loadedPage + 1;
      const params = new URLSearchParams({
        kind: activeKind,
        page: String(next),
        pageSize: String(pageSize),
        sort,
        direction,
      });
      if (search) params.set("q", search);
      if (activeRoleFilter !== "all") params.set("role", activeRoleFilter);
      if (activeTradeFilter !== "all") params.set("trade", activeTradeFilter);
      const response = await fetch(`/api/directory?${params.toString()}`, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("The next directory page could not be loaded.");
      const result = (await response.json()) as Pick<
        DirectoryPageResult,
        "entries" | "total" | "page" | "pageSize"
      >;
      if (fetchGeneration !== generation.current) return;
      setEntries((prev) => [...prev, ...result.entries]);
      setTotal(result.total);
      setLoadedPage(next);
    } catch (error) {
      if (fetchGeneration !== generation.current) return;
      if ((error as Error).name === "AbortError") return;
      toast({ title: "Couldn't load more", description: (error as Error).message });
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null;
      if (fetchGeneration === generation.current) setIsLoadingMore(false);
    }
  }, [
    hasMore,
    isLoadingMore,
    loadedPage,
    pageSize,
    activeKind,
    search,
    activeRoleFilter,
    activeTradeFilter,
    sort,
    direction,
    toast,
  ]);

  const [searchTerm, setSearchTerm] = useState(search);
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<PartyKind>("company");
  const [importOpen, setImportOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEntry, setInviteEntry] = useState<DirectoryEntry | undefined>();
  const [inviteProjects, setInviteProjects] = useState<
    Array<Pick<ProjectNavigationItem, "id" | "name">> | undefined
  >();
  const [projectsError, setProjectsError] = useState<string>();
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const projectsController = useRef<AbortController | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<DirectoryEntry | null>(null);
  const pendingNavigationHref = useRef<string | null>(null);

  useEffect(() => {
    setSearchTerm(search);
  }, [search]);

  useEffect(() => {
    return () => {
      loadMoreController.current?.abort();
      projectsController.current?.abort();
    };
  }, []);

  // Roles that can actually belong to the kind being listed. `applies_to` is
  // enforced in the database, so offering a company-only role while listing
  // contacts would be a filter that can never match.
  const roleOptions = useMemo(
    () =>
      relationshipTypes.filter(
        (type) => type.applies_to === "both" || type.applies_to === activeKind,
      ),
    [activeKind, relationshipTypes],
  );

  // Trade is a company fact; a person has a title instead.
  const showTradeFilter = activeKind === "company" && trades.length > 0;
  const activeFilterCount = [
    activeRoleFilter !== "all",
    activeTradeFilter !== "all",
  ].filter(Boolean).length;

  // Same query the server read, handed to the export route.
  const exportHref = (() => {
    const params = new URLSearchParams();
    params.set("kind", activeKind);
    if (search) params.set("q", search);
    if (activeRoleFilter !== "all") params.set("role", activeRoleFilter);
    if (activeTradeFilter !== "all") params.set("trade", activeTradeFilter);
    params.set("sort", sort);
    params.set("direction", direction);
    return `/directory/export?${params.toString()}`;
  })();

  const serializedSearchParams = searchParams.toString();
  const currentHref = serializedSearchParams
    ? `/directory?${serializedSearchParams}`
    : "/directory";

  useEffect(() => {
    if (pendingNavigationHref.current === currentHref) {
      pendingNavigationHref.current = null;
    }
  }, [currentHref]);

  const buildHref = useCallback(
    (updates: Record<string, string | number | undefined>) => {
      const params = new URLSearchParams(serializedSearchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "" || value === "all") params.delete(key);
        else params.set(key, String(value));
      }
      const suffix = params.toString();
      return suffix ? `/directory?${suffix}` : "/directory";
    },
    [serializedSearchParams],
  );

  const navigateHref = useCallback(
    (href: string) => {
      if (href === currentHref || pendingNavigationHref.current === href) return;
      pendingNavigationHref.current = href;
      startNavigation(() => {
        router.replace(href, { scroll: false });
      });
    },
    [currentHref, router],
  );

  const updateParams = useCallback(
    (updates: Record<string, string | number | undefined>) => {
      navigateHref(buildHref(updates));
    },
    [buildHref, navigateHref],
  );

  const kindHref = useCallback(
    (nextKind: PartyKind) =>
      buildHref({ kind: nextKind, role: undefined, trade: undefined }),
    [buildHref],
  );

  const setKind = useCallback(
    (nextKind: PartyKind) => {
      if (nextKind === activeKind) return;
      // Role and trade were chosen against the other list's vocabulary;
      // carrying them over would show an empty list for no visible reason.
      const href = kindHref(nextKind);
      const cacheKey = directoryPageKey(
        nextKind,
        search,
        "all",
        "all",
        sort,
        direction,
      );
      const cached = pageCache.current.get(cacheKey);
      if (!cached) {
        navigateHref(href);
        return;
      }

      generation.current += 1;
      loadMoreController.current?.abort();
      loadMoreController.current = null;
      setActiveKind(nextKind);
      setActiveRoleFilter("all");
      setActiveTradeFilter("all");
      setEntries(cached.entries);
      setTotal(cached.total);
      setLoadedPage(1);
      setIsLoadingMore(false);
      window.history.replaceState(null, "", href);
    },
    [activeKind, direction, kindHref, navigateHref, search, sort],
  );

  const openEntry = (entry: DirectoryEntry) => {
    navigate(`/directory/${entry.id}`);
  };

  const openNew = (nextKind: PartyKind) => {
    setAddKind(nextKind);
    setAddOpen(true);
  };

  const loadInviteProjects = useCallback(async () => {
    if (inviteProjects || projectsController.current) return;
    const controller = new AbortController();
    projectsController.current = controller;
    setIsLoadingProjects(true);
    setProjectsError(undefined);
    try {
      const response = await fetch("/api/projects", {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Projects could not be loaded.");
      const payload = (await response.json()) as {
        projects?: Array<Pick<ProjectNavigationItem, "id" | "name">>;
      };
      setInviteProjects(payload.projects ?? []);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setProjectsError((error as Error).message);
      }
    } finally {
      if (projectsController.current === controller) {
        projectsController.current = null;
        setIsLoadingProjects(false);
      }
    }
  }, [inviteProjects]);

  const openInvite = (entry: DirectoryEntry) => {
    setInviteEntry(entry);
    setInviteOpen(true);
    void loadInviteProjects();
  };

  const restoreArchived = async (entry: DirectoryEntry) => {
    try {
      if (entry.kind === "company") unwrapAction(await restoreCompanyAction(entry.id));
      else unwrapAction(await restoreContactAction(entry.id));
      router.refresh();
      toast({
        title: `${entry.kind === "company" ? "Company" : "Contact"} restored`,
        description: entry.name,
      });
    } catch (error) {
      toast({ title: "Unable to restore", description: (error as Error).message });
    }
  };

  const confirmArchive = () => {
    if (!archiveTarget) return;
    const target = archiveTarget;
    setArchiveTarget(null);
    startArchiveTransition(async () => {
      try {
        if (target.kind === "company") unwrapAction(await archiveCompanyAction(target.id));
        else unwrapAction(await archiveContactAction(target.id));
        setEntries((prev) =>
          prev.filter((entry) => !(entry.kind === target.kind && entry.id === target.id)),
        );
        setTotal((prev) => Math.max(0, prev - 1));
        toast({
          title: `${target.kind === "company" ? "Company" : "Contact"} archived`,
          description: target.name,
          action: (
            <ToastAction
              altText={`Restore ${target.name}`}
              onClick={() => void restoreArchived(target)}
            >
              Undo
            </ToastAction>
          ),
        });
      } catch (error) {
        toast({ title: "Unable to archive", description: (error as Error).message });
      }
    });
  };

  const filtersMenu = (
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel>Role</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={activeRoleFilter}
        onValueChange={(value) => updateParams({ role: value })}
      >
        <DropdownMenuRadioItem value="all">All roles</DropdownMenuRadioItem>
        {roleOptions.map((type) => (
          <DropdownMenuRadioItem key={type.key} value={type.key}>
            {type.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>

      {showTradeFilter ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{terms.trade}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeTradeFilter}
            onValueChange={(value) => updateParams({ trade: value })}
          >
            <DropdownMenuRadioItem value="all">All trades</DropdownMenuRadioItem>
            {trades.map((trade) => (
              <DropdownMenuRadioItem key={trade} value={trade}>
                {trade}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </>
      ) : null}

      {activeFilterCount > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => updateParams({ role: undefined, trade: undefined })}>
            <X className="mr-2 h-4 w-4" />
            Clear filters
          </DropdownMenuItem>
        </>
      ) : null}

      <DropdownMenuSeparator />
      {/* Exports exactly what these filters select, so the file matches the
          screen rather than being a second, differently-scoped list. */}
      <DropdownMenuItem asChild>
        <a href={exportHref} download>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </a>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const addMenu = canCreate ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="default" className="h-10 w-10 shrink-0">
          <Plus className="h-4 w-4" />
          <span className="sr-only">Add to directory</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openNew("company")}>Add company</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNew("contact")}>Add person</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setImportOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          Import from CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const submitSearch = () => updateParams({ q: searchTerm.trim() || undefined });

  const searchField = (
    <div className="relative w-full sm:w-96">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submitSearch();
        }}
        onBlur={submitSearch}
        placeholder="Search name, company, trade, email, phone…"
        className="h-10 pl-8"
        inputMode="search"
      />
      {searchTerm ? (
        <button
          type="button"
          onClick={() => {
            setSearchTerm("");
            updateParams({ q: undefined });
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );

  const kindTabs = (
    <div className="flex shrink-0 border bg-muted/20 p-1">
      {KIND_TABS.map((tab) => {
        const href = kindHref(tab.key);
        const cached = pageCache.current.has(
          directoryPageKey(tab.key, search, "all", "all", sort, direction),
        );
        return (
          <Link
            key={tab.key}
            href={href}
            replace
            scroll={false}
            prefetch={false}
            onMouseEnter={() => {
              if (tab.key !== activeKind && !cached) router.prefetch(href);
            }}
            onFocus={() => {
              if (tab.key !== activeKind && !cached) router.prefetch(href);
            }}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              setKind(tab.key);
            }}
            aria-current={activeKind === tab.key ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center px-4 text-xs font-medium transition-colors",
              activeKind === tab.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );

  const filterButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="relative h-10 w-10 shrink-0">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="sr-only">Filters</span>
          {activeFilterCount > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      {filtersMenu}
    </DropdownMenu>
  );

  return (
    <div
      data-instant-shell="directory"
      aria-busy={isNavigationPending || undefined}
      className="flex min-h-full flex-col bg-background"
    >
      {/* Mobile header */}
      <div className="shrink-0 border-y bg-background md:hidden">
        <div className="flex items-center gap-2 px-3 pt-3">
          {searchField}
          {filterButton}
          {addMenu}
        </div>
        <div className="px-3 py-2.5">{kindTabs}</div>
      </div>

      {/* Desktop header */}
      <div className="hidden shrink-0 border-y bg-background px-4 py-3 md:block">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 items-center">{kindTabs}</div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            {searchField}
            {filterButton}
            {addMenu}
          </div>
        </div>
      </div>

      {activeKind === "company" && vendorData ? (
        <Suspense fallback={<PendingComplianceAlert />}>
          <DeferredComplianceAlert vendorData={vendorData} terms={terms} />
        </Suspense>
      ) : null}

      <DirectoryTable
        entries={entries}
        vendorData={vendorData}
        tradeLabel={terms.trade}
        showPrequalTrades={showPrequalTrades}
        kind={activeKind}
        sort={sort}
        direction={direction}
        total={total}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        isRefreshing={isNavigationPending}
        refreshingLabel={`Loading ${activeKind === "company" ? "companies" : "contacts"}…`}
        onLoadMore={loadMore}
        onSortChange={(nextSort) => {
          const nextDirection = sort === nextSort && direction === "asc" ? "desc" : "asc";
          updateParams({ sort: nextSort, direction: nextDirection });
        }}
        onSelect={openEntry}
        onInvite={canCreate ? openInvite : undefined}
        onArchive={canArchive && !isArchivePending ? setArchiveTarget : undefined}
        hasActiveFilters={activeFilterCount > 0 || search.length > 0}
        onClearFilters={() => {
          // The input holds its own state, so clearing the URL alone would
          // leave stale text sitting above an unfiltered list.
          setSearchTerm("");
          updateParams({ role: undefined, trade: undefined, q: undefined });
        }}
      />

      <AddToDirectorySheet
        open={addOpen}
        onOpenChange={setAddOpen}
        kind={addKind}
        onKindChange={setAddKind}
        terms={terms}
      />

      <PortalInviteDialog
        contact={
          inviteEntry?.kind === "contact"
            ? { id: inviteEntry.id, full_name: inviteEntry.name }
            : undefined
        }
        projects={inviteProjects ?? []}
        projectsLoading={isLoadingProjects}
        projectsError={projectsError}
        onRetryProjects={() => void loadInviteProjects()}
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) setInviteEntry(undefined);
        }}
      />

      {canCreate ? <ImportContactsSheet open={importOpen} onOpenChange={setImportOpen} /> : null}

      <AlertDialog
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive {archiveTarget?.kind === "company" ? "company" : "contact"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget?.name ?? "This record"} will be hidden from the directory and its
              roles will end, so it stops appearing as a live vendor or client. Undo restores
              both.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isArchivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isArchivePending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmArchive}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
