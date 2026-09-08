"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ComplianceStatusSummary } from "@/lib/types";
import type {
  DirectoryEntry,
  DirectoryRoleState,
  DirectorySortDirection,
  DirectorySortKey,
} from "@/lib/services/directory";
import { roleStatusLabel } from "@/lib/directory/roles";
import type { PrequalificationGlance } from "@/lib/services/prequalification";
import type { DirectoryVendorData } from "@/lib/directory/vendor-data";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { cn } from "@/lib/utils";
import { initialsFor } from "@/lib/directory/initials";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Building2,
  Loader2,
  Mail,
  MoreHorizontal,
  Phone,
  Send,
} from "@/components/icons";

interface DirectoryTableProps {
  entries: DirectoryEntry[];
  /** Company-only status arrives after rows through a narrow Suspense consumer. */
  vendorData?: Promise<DirectoryVendorData>;
  /** Tier vocabulary for the secondary column: Trade, or Division commercially. */
  tradeLabel?: string;
  /** Commercial orgs show the CSI divisions a prequalification actually covers. */
  showPrequalTrades?: boolean;
  /** Drives the empty state's copy and its way out of a filtered-to-nothing list. */
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  /** Which party kind is listed; decides the secondary column and its label. */
  kind: "company" | "contact";
  sort: DirectorySortKey;
  direction: DirectorySortDirection;
  total: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  isRefreshing?: boolean;
  refreshingLabel?: string;
  onLoadMore: () => void;
  onSortChange: (sort: DirectorySortKey) => void;
  /** Opens the party's account, which is where editing lives. */
  onSelect: (entry: DirectoryEntry) => void;
  onInvite?: (entry: DirectoryEntry) => void;
  onArchive?: (entry: DirectoryEntry) => void;
}

/**
 * A party's roles, with lifecycle state shown only where it carries meaning.
 * "Subcontractor · Active" is noise — active is the expected state; "Prospect ·
 * Under contract" is the whole point of the row.
 */
function RoleChips({ roles }: { roles: DirectoryRoleState[] }) {
  if (roles.length === 0) {
    return <span className="text-sm text-muted-foreground">No role</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((role) => {
        const showStatus = role.status !== "active";
        return (
          <Badge key={role.key} variant="outline" className="font-normal">
            {role.label}
            {showStatus ? (
              <span className="ml-1.5 text-muted-foreground">
                {roleStatusLabel(role.status)}
              </span>
            ) : null}
          </Badge>
        );
      })}
    </div>
  );
}

function ContactMethods({ email, phone }: { email?: string; phone?: string }) {
  if (!email && !phone)
    return <span className="text-sm text-muted-foreground">No contact info</span>;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      {email ? (
        <a
          className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
          href={`mailto:${email}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{email}</span>
        </a>
      ) : null}
      {phone ? (
        <a
          className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
          href={`tel:${phone}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Phone className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{phone}</span>
        </a>
      ) : null}
    </div>
  );
}

/**
 * Exception reporting: a compliant vendor says nothing, because that is expected.
 *
 * A vendor nobody enrolled is a third case, and it is not silence. `is_compliant`
 * is true for them — nothing is outstanding because nothing was ever asked — so
 * this row used to look identical to a vendor with a current certificate on file.
 */
function ComplianceFlag({ status }: { status?: ComplianceStatusSummary }) {
  if (!status) return null;
  if (status.enrollment === "unenrolled") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        Compliance not enrolled
      </span>
    );
  }
  if (status.is_compliant) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
      <AlertTriangle className="h-3 w-3" />
      Action required
    </span>
  );
}

function PrequalFlag({
  glance,
  showTrades = false,
}: {
  glance?: PrequalificationGlance;
  showTrades?: boolean;
}) {
  if (!glance) return null;
  if (glance.status === "approved" || glance.status === "approved_with_limits") {
    // Commercial prequalification is scoped by CSI division: approved for
    // concrete says nothing about approved for electrical. On a commercial org
    // an unqualified "approved" overstates what was actually granted, so the
    // divisions ride along; residential orgs stay quiet as before.
    if (!showTrades || glance.trades.length === 0) return null;
    const shown = glance.trades.slice(0, 3);
    const rest = glance.trades.length - shown.length;
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        Prequalified: {shown.join(", ")}
        {rest > 0 ? ` +${rest}` : null}
      </span>
    );
  }
  const label =
    glance.status === "requested"
      ? "Prequal requested"
      : glance.status === "submitted" || glance.status === "under_review"
        ? "Prequal in review"
        : glance.status === "declined"
          ? "Prequal declined"
          : glance.status === "waived"
            ? "Prequal waived"
            : "Prequal expired";
  const tone =
    glance.status === "declined" || glance.status === "expired"
      ? "text-destructive"
      : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", tone)}>
      {label}
    </span>
  );
}

function PendingVendorSignals() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      Checking status…
    </span>
  );
}

function VendorSignals({
  companyId,
  vendorData,
  showPrequalTrades,
}: {
  companyId: string;
  vendorData: Promise<DirectoryVendorData>;
  showPrequalTrades: boolean;
}) {
  const data = use(vendorData);
  if (data.statusUnavailable) {
    return <span className="text-[11px] text-muted-foreground">Status unavailable</span>;
  }

  const compliance = data.complianceStatusByCompanyId[companyId];
  const prequal = data.prequalificationByCompanyId[companyId];
  if (!compliance && !prequal) return null;

  return (
    <>
      <ComplianceFlag status={compliance} />
      <PrequalFlag glance={prequal} showTrades={showPrequalTrades} />
    </>
  );
}

function DeferredVendorSignals({
  entry,
  vendorData,
  showPrequalTrades,
}: {
  entry: DirectoryEntry;
  vendorData?: Promise<DirectoryVendorData>;
  showPrequalTrades: boolean;
}) {
  if (
    entry.kind !== "company" ||
    !entry.role_categories.includes("vendor") ||
    !vendorData
  ) {
    return null;
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3">
      <Suspense fallback={<PendingVendorSignals />}>
        <VendorSignals
          companyId={entry.id}
          vendorData={vendorData}
          showPrequalTrades={showPrequalTrades}
        />
      </Suspense>
    </div>
  );
}

function SortHead({
  label,
  sortKey,
  activeSort,
  direction,
  className,
  onSortChange,
}: {
  label: string;
  sortKey: DirectorySortKey;
  activeSort: DirectorySortKey;
  direction: DirectorySortDirection;
  className?: string;
  onSortChange: (sort: DirectorySortKey) => void;
}) {
  const active = activeSort === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="flex items-center gap-1.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSortChange(sortKey)}
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

function InfiniteScrollSentinel({
  hasMore,
  isLoading,
  onLoadMore,
  rootRef,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoading) return;
    const observer = new IntersectionObserver(
      (observed) => {
        for (const entry of observed) {
          if (entry.isIntersecting) {
            onLoadMoreRef.current();
            break;
          }
        }
      },
      { root: rootRef.current ?? null, rootMargin: "400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, rootRef]);

  return <div ref={sentinelRef} aria-hidden className="h-px w-full" />;
}

function InfiniteScrollStatus({
  hasMore,
  isLoading,
  loadedCount,
  total,
  compact,
}: {
  hasMore: boolean;
  isLoading: boolean;
  loadedCount: number;
  total: number;
  compact?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading more…
      </div>
    );
  }
  if (hasMore) {
    return <div className={compact ? "h-16" : "h-12"} aria-hidden />;
  }
  return (
    <div className="px-4 py-4 text-center text-xs text-muted-foreground">
      {loadedCount === 0
        ? "No entries"
        : `Showing all ${total} ${total === 1 ? "entry" : "entries"}`}
    </div>
  );
}

function EntryAvatar({ entry }: { entry: DirectoryEntry }) {
  if (entry.kind === "company") {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted/40">
        <Building2 className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <Avatar className="h-9 w-9 rounded-none border">
      <AvatarFallback className="rounded-none text-xs font-semibold text-muted-foreground">
        {initialsFor(entry.name)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * One register row.
 *
 * It is its own component so the "this row is where the pointer is" state stays
 * local. Under Partial Prefetching every row shares a single App Shell prefetch
 * for `/directory/[id]`, but the runtime data that decides whether the account
 * opens instantly is per-party — prefetching that for 25 rows on viewport entry
 * would be 25 server renders to open one. Hover or focus anywhere on the row
 * upgrades that row's link to a full prefetch, and it stays upgraded.
 */
function DirectoryTableRow({
  entry,
  vendorData,
  showPrequalTrades,
  onSelect,
  onInvite,
  onArchive,
}: {
  entry: DirectoryEntry;
  vendorData?: Promise<DirectoryVendorData>;
  showPrequalTrades: boolean;
  onSelect: (entry: DirectoryEntry) => void;
  onInvite?: (entry: DirectoryEntry) => void;
  onArchive?: (entry: DirectoryEntry) => void;
}) {
  const [warmed, setWarmed] = useState(false);
  const warm = () => setWarmed(true);

  return (
    <TableRow
      className="group cursor-pointer align-middle hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      // The row is the primary navigation of this page, so it has to
      // be reachable without a mouse. A div-role row gets neither
      // focus nor Enter for free.
      tabIndex={0}
      role="link"
      aria-label={entry.name}
      onMouseEnter={warm}
      onFocus={warm}
      onClick={() => onSelect(entry)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(entry);
        }
      }}
    >
      <TableCell className="pl-4">
        <OptimisticLink
          href={`/directory/${entry.id}`}
          prefetch={warmed ? true : "auto"}
          onClick={(event) => event.stopPropagation()}
          className="flex min-w-0 items-center gap-3"
        >
          <EntryAvatar entry={entry} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{entry.name}</div>
            {entry.primary_company_name ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {entry.primary_company_name}
              </div>
            ) : null}
            {/* Exception reporting: a vendor in good standing says
                nothing, so this costs no row height when all is well
                and needs no column of its own. */}
            <DeferredVendorSignals
              entry={entry}
              vendorData={vendorData}
              showPrequalTrades={showPrequalTrades}
            />
          </div>
        </OptimisticLink>
      </TableCell>
      <TableCell>
        <RoleChips roles={entry.roles} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{entry.detail || "—"}</TableCell>
      <TableCell>
        <ContactMethods email={entry.email} phone={entry.phone} />
      </TableCell>
      <TableCell className="pr-4 text-right" onClick={(event) => event.stopPropagation()}>
        <EntryActions entry={entry} onInvite={onInvite} onArchive={onArchive} />
      </TableCell>
    </TableRow>
  );
}

function EntryActions({
  entry,
  onInvite,
  onArchive,
}: {
  entry: DirectoryEntry;
  onInvite?: (entry: DirectoryEntry) => void;
  onArchive?: (entry: DirectoryEntry) => void;
}) {
  if (!onInvite && !onArchive) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions for {entry.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onInvite && entry.kind === "contact" ? (
          <DropdownMenuItem disabled={!entry.email} onSelect={() => onInvite(entry)}>
            <Send className="mr-2 h-4 w-4" />
            Portal invite
          </DropdownMenuItem>
        ) : null}
        {onArchive ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onArchive(entry)}
          >
            <Archive className="mr-2 h-4 w-4" />
            Archive
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DirectoryTable({
  entries,
  vendorData,
  tradeLabel = "Trade",
  showPrequalTrades = false,
  kind,
  sort,
  direction,
  total,
  hasMore,
  isLoadingMore,
  isRefreshing = false,
  refreshingLabel = "Refreshing directory…",
  onLoadMore,
  onSortChange,
  onSelect,
  onInvite,
  onArchive,
  hasActiveFilters = false,
  onClearFilters,
}: DirectoryTableProps) {
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const desktopScrollRef = useRef<HTMLDivElement>(null);
  const loadedCount = entries.length;

  // `detail` is a company's trade and a person's title.
  const isCompanyList = kind === "company";
  const secondaryLabel = isCompanyList ? tradeLabel : "Title";

  const empty = (
    <div className="flex h-56 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium text-foreground">Nothing here yet</p>
      <p className="text-sm text-muted-foreground">
        {hasActiveFilters
          ? `${isCompanyList ? "No companies" : "No contacts"} match these filters.`
          : `No ${isCompanyList ? "companies" : "contacts"} in the directory yet.`}
      </p>
      {/* An empty list caused by a filter needs the way back out of it; without
          this the reader has to remember which menu they set it in. */}
      {hasActiveFilters && onClearFilters ? (
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-directory-kind={kind}
    >
      {isRefreshing ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-7 items-center justify-center gap-2 border-b bg-background/90 text-[11px] font-medium text-muted-foreground backdrop-blur-sm"
        >
          <Loader2 className="size-3 animate-spin" />
          {refreshingLabel}
        </div>
      ) : null}
      {/* Mobile list */}
      <div ref={mobileScrollRef} className="min-h-0 flex-1 overflow-auto md:hidden">
        {entries.length === 0 ? (
          empty
        ) : (
          <>
            <ul className="divide-y">
              {entries.map((entry) => {
                const meta = [entry.detail, entry.primary_company_name].filter(Boolean);
                return (
                  <li key={`${entry.kind}-${entry.id}`} className="flex items-stretch">
                    <OptimisticLink
                      href={`/directory/${entry.id}`}
                      prefetchOnIntent
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
                    >
                      <EntryAvatar entry={entry} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {entry.name}
                        </p>
                        {meta.length > 0 ? (
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {meta.join(" · ")}
                          </p>
                        ) : null}
                        <div className="mt-1.5">
                          <RoleChips roles={entry.roles} />
                        </div>
                        <DeferredVendorSignals
                          entry={entry}
                          vendorData={vendorData}
                          showPrequalTrades={showPrequalTrades}
                        />
                      </div>
                    </OptimisticLink>
                    <div className="flex items-center pr-1">
                      <EntryActions
                        entry={entry}
                        onInvite={onInvite}
                        onArchive={onArchive}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            {hasMore ? (
              <InfiniteScrollSentinel
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={onLoadMore}
                rootRef={mobileScrollRef}
              />
            ) : null}
            <InfiniteScrollStatus
              hasMore={hasMore}
              isLoading={isLoadingMore}
              loadedCount={loadedCount}
              total={total}
              compact
            />
          </>
        )}
      </div>

      {/* Desktop table */}
      <div ref={desktopScrollRef} className="hidden min-h-0 flex-1 overflow-auto md:block">
        <Table className="min-w-[960px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <SortHead
                label="Name"
                sortKey="name"
                activeSort={sort}
                direction={direction}
                onSortChange={onSortChange}
                className="w-[30%] pl-4"
              />
              <TableHead className="w-[22%]">Roles</TableHead>
              <SortHead
                label={secondaryLabel}
                sortKey="detail"
                activeSort={sort}
                direction={direction}
                onSortChange={onSortChange}
                className="w-[16%]"
              />
              <TableHead className="w-[30%]">Contact</TableHead>
              <TableHead className="w-12 pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <DirectoryTableRow
                key={`${entry.kind}-${entry.id}`}
                entry={entry}
                vendorData={vendorData}
                showPrequalTrades={showPrequalTrades}
                onSelect={onSelect}
                onInvite={onInvite}
                onArchive={onArchive}
              />
            ))}
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-56 p-0">
                  {empty}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        {entries.length > 0 ? (
          <>
            {hasMore ? (
              <InfiniteScrollSentinel
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={onLoadMore}
                rootRef={desktopScrollRef}
              />
            ) : null}
            <InfiniteScrollStatus
              hasMore={hasMore}
              isLoading={isLoadingMore}
              loadedCount={loadedCount}
              total={total}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
