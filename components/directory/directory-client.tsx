"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

import { archiveCompanyAction, restoreCompanyAction } from "@/app/(app)/companies/actions";
import { archiveContactAction, restoreContactAction } from "@/app/(app)/contacts/actions";
import { listDirectoryPageAction } from "@/app/(app)/directory/actions";
import type { ComplianceStatusSummary, Project } from "@/lib/types";
import type {
  DirectoryEntry,
  DirectorySortDirection,
  DirectorySortKey,
} from "@/lib/services/directory";
import type { PartyKind, RelationshipType } from "@/lib/directory/roles";
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
import type { PrequalificationGlance } from "@/lib/services/prequalification";
import { AddToDirectorySheet } from "@/components/directory/add-to-directory-sheet";
import { PortalInviteDialog } from "@/components/contacts/portal-invite-dialog";

import { DirectoryTable } from "@/components/directory/directory-table";
import { Download, Plus, Search, SlidersHorizontal, Upload, X } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

import { unwrapAction } from "@/lib/action-result";

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
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>;
  prequalificationByCompanyId?: Record<string, PrequalificationGlance>;
  complianceWatchCompanies: Array<{ id: string; name: string }>;
  complianceWatchTruncated: boolean;
  complianceWatchTotal: number;
  /** A status read failed. Rows must not render "clear" from missing data. */
  vendorStatusUnavailable?: boolean;
  /** Tier vocabulary. The directory names the same table for three postures,
   *  so the nouns it prints have to come from the choke point. */
  terms: ReturnType<typeof terminology>;
  /** Commercial prequalification is division-scoped, so the list says which. */
  showPrequalTrades?: boolean;
  projects: Project[];
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

export function DirectoryClient({
  entries: initialEntries,
  total: initialTotal,
  pageSize,
  relationshipTypes,
  complianceStatusByCompanyId,
  prequalificationByCompanyId = {},
  complianceWatchCompanies,
  complianceWatchTruncated,
  complianceWatchTotal,
  vendorStatusUnavailable = false,
  terms,
  showPrequalTrades = false,
  projects,
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
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [entries, setEntries] = useState<DirectoryEntry[]>(initialEntries);
  const [total, setTotal] = useState(initialTotal);
  const [loadedPage, setLoadedPage] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const filterKey = `${kind}|${search}|${roleFilter}|${tradeFilter}|${sort}|${direction}`;
  const lastFilterKey = useRef(filterKey);
  const generation = useRef(0);

  useEffect(() => {
    // A new server render always resets the loaded window: either the filters
    // changed, or the same filters were re-fetched and page 1 is authoritative.
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      generation.current += 1;
    }
    setEntries(initialEntries);
    setTotal(initialTotal);
    setLoadedPage(1);
    setIsLoadingMore(false);
  }, [filterKey, initialEntries, initialTotal]);

  const hasMore = entries.length < total;

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const fetchGeneration = generation.current;
    try {
      const next = loadedPage + 1;
      const result = await listDirectoryPageAction({
        kind,
        page: next,
        pageSize,
        search,
        role: roleFilter,
        trade: tradeFilter,
        sort,
        direction,
      });
      if (fetchGeneration !== generation.current) return;
      setEntries((prev) => [...prev, ...result.entries]);
      setTotal(result.total);
      setLoadedPage(next);
    } catch (error) {
      if (fetchGeneration !== generation.current) return;
      toast({ title: "Couldn't load more", description: (error as Error).message });
    } finally {
      if (fetchGeneration === generation.current) setIsLoadingMore(false);
    }
  }, [
    hasMore,
    isLoadingMore,
    loadedPage,
    pageSize,
    kind,
    search,
    roleFilter,
    tradeFilter,
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
  const [archiveTarget, setArchiveTarget] = useState<DirectoryEntry | null>(null);

  // Roles that can actually belong to the kind being listed. `applies_to` is
  // enforced in the database, so offering a company-only role while listing
  // contacts would be a filter that can never match.
  const roleOptions = useMemo(
    () =>
      relationshipTypes.filter(
        (type) => type.applies_to === "both" || type.applies_to === kind,
      ),
    [relationshipTypes, kind],
  );

  // Trade is a company fact; a person has a title instead.
  const showTradeFilter = kind === "company" && trades.length > 0;
  const activeFilterCount = [roleFilter !== "all", tradeFilter !== "all"].filter(Boolean).length;

  // Same query the server read, handed to the export route.
  const exportHref = (() => {
    const params = new URLSearchParams();
    params.set("kind", kind);
    if (search) params.set("q", search);
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (tradeFilter !== "all") params.set("trade", tradeFilter);
    params.set("sort", sort);
    params.set("direction", direction);
    return `/directory/export?${params.toString()}`;
  })();

  const updateParams = (updates: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "" || value === "all") params.delete(key);
      else params.set(key, String(value));
    }
    const suffix = params.toString();
    router.replace(suffix ? `/directory?${suffix}` : "/directory");
  };

  const setKind = (nextKind: PartyKind) => {
    // Role and trade were chosen against the other list's vocabulary; carrying
    // them over would show an empty list for no visible reason.
    updateParams({ kind: nextKind, role: undefined, trade: undefined });
  };

  const openEntry = (entry: DirectoryEntry) => {
    router.push(`/directory/${entry.id}`);
  };

  const openNew = (nextKind: PartyKind) => {
    setAddKind(nextKind);
    setAddOpen(true);
  };

  const openInvite = (entry: DirectoryEntry) => {
    setInviteEntry(entry);
    setInviteOpen(true);
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
    startTransition(async () => {
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
        value={roleFilter}
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
            value={tradeFilter}
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
      {KIND_TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => setKind(tab.key)}
          aria-current={kind === tab.key ? "page" : undefined}
          className={cn(
            "flex h-8 shrink-0 items-center px-4 text-xs font-medium transition-colors",
            kind === tab.key
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
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
    <div className="flex min-h-full flex-col bg-background">
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

      <ComplianceAlert
        companies={complianceWatchCompanies}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        watchTruncated={complianceWatchTruncated}
        watchTotal={complianceWatchTotal}
        statusUnavailable={vendorStatusUnavailable}
        vendorNoun={terms.vendor.toLowerCase()}
        vendorNounPlural={terms.vendors.toLowerCase()}
      />

      <DirectoryTable
        entries={entries}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        prequalificationByCompanyId={prequalificationByCompanyId}
        statusUnavailable={vendorStatusUnavailable}
        tradeLabel={terms.trade}
        showPrequalTrades={showPrequalTrades}
        kind={kind}
        sort={sort}
        direction={direction}
        total={total}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={loadMore}
        onSortChange={(nextSort) => {
          const nextDirection = sort === nextSort && direction === "asc" ? "desc" : "asc";
          updateParams({ sort: nextSort, direction: nextDirection });
        }}
        onSelect={openEntry}
        onInvite={canCreate ? openInvite : undefined}
        onArchive={canArchive && !isPending ? setArchiveTarget : undefined}
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
        projects={projects}
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
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
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
