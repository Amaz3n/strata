"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { Home, MoreHorizontal, Search, X } from "@/components/icons";
import { DealAttentionStrip } from "@/components/sales/deal-attention-strip";
import { DealFunnelBar } from "@/components/sales/deal-funnel-bar";
import { DealViewFilter } from "@/components/sales/deal-view-filter";
import { FindAHomeDialog } from "@/components/sales/find-a-home-dialog";
import { FollowUpControl } from "@/components/sales/follow-up-control";
import { LogActivityDialog } from "@/components/sales/log-activity-dialog";
import type { HoldBuyer } from "@/components/sales/lot-hold-form";
import { MarkLostDialog } from "@/components/sales/mark-lost-dialog";
import { NextActionCell } from "@/components/sales/next-action-cell";
import { StageMeter } from "@/components/sales/stage-meter";
import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildBoard,
  DEAL_BUCKET_LABELS,
  type BoardDeal,
  type DealView,
} from "@/lib/sales/board";
import { formatLostReason } from "@/lib/sales/lost-reasons";
import { DEAL_FILTER_LABELS, type DealFilter } from "@/lib/sales/next-action";
import { STAGE_ACCENT, STAGE_LABELS } from "@/lib/sales/stages";
import type { SalesDeal, SalesDealStage } from "@/lib/services/sales-deals";
import { cn } from "@/lib/utils";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Backlog value is read at a glance, not audited — millions with one decimal. */
function compactMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`;
  return money.format(dollars);
}

interface DealBoardProps {
  deals: SalesDeal[];
  view: DealView;
  filter: DealFilter;
  /** Owner display names by user id. */
  owners: Record<string, string>;
  /** Lost reasons by prospect id — only loaded for the Lost view. */
  lostReasons: Record<string, string>;
  communities: PipelineCommunityOption[];
  /** True when the query hit its row cap, so the footer can say so. */
  truncated: boolean;
  /** Page-level buttons, rendered at the end of the toolbar. */
  actions?: React.ReactNode;
  now: Date;
}

/**
 * The consultant's book. The funnel and the attention pills are two lenses on
 * one list — never separate pages — and both run in the browser, because the
 * Monday ritual is a hundred small narrowings and a server round-trip each is
 * what makes people stop using a tool.
 */
export function DealBoard({
  deals,
  view,
  filter: initialFilter,
  owners,
  lostReasons,
  communities,
  truncated,
  actions,
  now,
}: DealBoardProps) {
  const [filter, setFilter] = useState<DealFilter>(initialFilter);
  const [stage, setStage] = useState<SalesDealStage | null>(null);
  const [search, setSearch] = useState("");

  // One dialog of each kind for the whole table: 500 rows must not each mount
  // their own copies of three dialogs.
  const [logDeal, setLogDeal] = useState<SalesDeal | null>(null);
  const [lostDeal, setLostDeal] = useState<SalesDeal | null>(null);
  const [homesDeal, setHomesDeal] = useState<SalesDeal | null>(null);

  const board = useMemo(
    () => buildBoard(deals, { view, filter, stage, search, now }),
    [deals, view, filter, stage, search, now],
  );

  // The two lenses are exclusive — holding both at once produces empty lists
  // nobody can explain.
  const selectStage = (next: SalesDealStage) => {
    setStage((current) => (current === next ? null : next));
    setFilter("all");
  };
  const selectFilter = (next: DealFilter) => {
    setFilter(next);
    setStage(null);
  };
  const clearAll = () => {
    setFilter("all");
    setStage(null);
    setSearch("");
  };

  const holdBuyer: HoldBuyer | null = homesDeal?.prospectId
    ? {
        prospectId: homesDeal.prospectId,
        name: homesDeal.buyerName,
        communityId: homesDeal.communityId,
        hasContact: Boolean(homesDeal.buyerPhone || homesDeal.buyerEmail),
      }
    : null;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search buyer, lot, plan…"
            aria-label="Search deals"
            className="h-9 rounded-none pr-8 pl-9 text-[13px]"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <DealViewFilter view={view} />
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>

      {view === "open" ? (
        <DealFunnelBar
          stages={board.funnel}
          activeStage={stage}
          onSelect={selectStage}
        />
      ) : null}

      {view === "open" ? (
        <DealAttentionStrip
          counts={board.counts}
          activeFilter={filter}
          onSelect={selectFilter}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {board.summary.count}
          </span>{" "}
          {view === "closed" ? "closed" : "lost"}
          {view === "closed" && board.summary.valueCents > 0 ? (
            <>
              {" · "}
              <span className="font-medium text-foreground tabular-nums">
                {compactMoney(board.summary.valueCents)}
              </span>{" "}
              settled
            </>
          ) : null}
        </p>
      )}

      {board.rows.length === 0 ? (
        <div className="overflow-hidden border">
          <EmptyState
            view={view}
            filter={filter}
            stage={stage}
            search={search}
            viewTotal={board.viewTotal}
            onClear={clearAll}
          />
        </div>
      ) : (
        <div className="overflow-hidden border">
          <div className="overflow-x-auto">
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-3 py-2">Buyer</TableHead>
                  <TableHead className="px-3 py-2">Home</TableHead>
                  <TableHead className="px-3 py-2">Stage</TableHead>
                  <TableHead className="px-3 py-2">Owner</TableHead>
                  <TableHead className="px-3 py-2 text-right">Price</TableHead>
                  <TableHead className="px-3 py-2">
                    {view === "lost" ? "Reason" : "Next action"}
                  </TableHead>
                  <TableHead className="sticky right-0 w-10 bg-muted px-2 py-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {view === "open"
                  ? board.groups.map((group) => (
                      <Fragment key={group.bucket}>
                        <TableRow className="hover:bg-transparent">
                          <TableCell
                            colSpan={7}
                            className={cn(
                              "bg-muted/40 px-3 py-1.5 text-[10px] font-semibold tracking-wider uppercase",
                              group.bucket === "overdue"
                                ? "text-destructive"
                                : "text-muted-foreground",
                            )}
                          >
                            {DEAL_BUCKET_LABELS[group.bucket]}
                            <span className="ml-2 font-normal tabular-nums opacity-60">
                              {group.deals.length}
                            </span>
                          </TableCell>
                        </TableRow>
                        {group.deals.map((row) => (
                          <DealRow
                            key={row.deal.dealId}
                            row={row}
                            view={view}
                            owners={owners}
                            lostReasons={lostReasons}
                            onLog={setLogDeal}
                            onMarkLost={setLostDeal}
                            onFindHome={setHomesDeal}
                          />
                        ))}
                      </Fragment>
                    ))
                  : board.rows.map((row) => (
                      <DealRow
                        key={row.deal.dealId}
                        row={row}
                        view={view}
                        owners={owners}
                        lostReasons={lostReasons}
                        onLog={setLogDeal}
                        onMarkLost={setLostDeal}
                        onFindHome={setHomesDeal}
                      />
                    ))}
              </TableBody>
            </Table>
          </div>

          {truncated ? (
            <p className="border-t px-3 py-2.5 text-[11px] text-muted-foreground">
              Showing the first {deals.length} deals. Narrow the community lens
              or search to see the rest.
            </p>
          ) : null}
        </div>
      )}

      {logDeal?.prospectId ? (
        <LogActivityDialog
          prospectId={logDeal.prospectId}
          buyerName={logDeal.buyerName}
          open
          onOpenChange={(next) => !next && setLogDeal(null)}
        />
      ) : null}
      {lostDeal?.prospectId ? (
        <MarkLostDialog
          prospectId={lostDeal.prospectId}
          open
          onOpenChange={(next) => !next && setLostDeal(null)}
        />
      ) : null}
      {holdBuyer ? (
        <FindAHomeDialog
          buyer={holdBuyer}
          communities={communities}
          open
          onOpenChange={(next) => !next && setHomesDeal(null)}
        />
      ) : null}
    </div>
  );
}

function DealRow({
  row,
  view,
  owners,
  lostReasons,
  onLog,
  onMarkLost,
  onFindHome,
}: {
  row: BoardDeal;
  view: DealView;
  owners: Record<string, string>;
  lostReasons: Record<string, string>;
  onLog: (deal: SalesDeal) => void;
  onMarkLost: (deal: SalesDeal) => void;
  onFindHome: (deal: SalesDeal) => void;
}) {
  const { deal, action } = row;
  const home = [
    deal.communityName,
    deal.lotLabel ? `Lot ${deal.lotLabel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const contact = [deal.buyerPhone, deal.source].filter(Boolean).join(" · ");
  const lostReason = deal.prospectId
    ? formatLostReason(lostReasons[deal.prospectId] ?? null)
    : null;
  const owner = deal.ownerUserId ? (owners[deal.ownerUserId] ?? null) : null;
  const shopping = deal.stage === "inquiry" || deal.stage === "working";

  return (
    <TableRow
      className={cn(
        "group border-l-2",
        view === "open" && action.tone === "overdue"
          ? "border-l-destructive"
          : view === "open" && action.tone === "soon"
            ? "border-l-warning"
            : "border-l-transparent",
      )}
    >
      <TableCell className="px-3 py-3">
        <Link
          href={`/sales/${encodeURIComponent(deal.dealId)}`}
          className="block truncate text-[13px] font-semibold transition-colors hover:text-primary"
        >
          {deal.buyerName}
        </Link>
        {contact ? (
          <p className="truncate text-[11px] text-muted-foreground tabular-nums">
            {contact}
          </p>
        ) : null}
      </TableCell>

      <TableCell className="px-3 py-3">
        {home ? (
          <p className="truncate text-[13px]">{home}</p>
        ) : (
          <p className="truncate text-[13px] text-muted-foreground italic">
            No home yet
          </p>
        )}
        {deal.planName ? (
          <p className="truncate text-[11px] text-muted-foreground">
            {deal.planName}
          </p>
        ) : null}
      </TableCell>

      <TableCell className="px-3 py-3">
        <Badge
          variant="secondary"
          className={cn(
            "mb-1.5 rounded-none border font-normal",
            STAGE_ACCENT[deal.stage].chip,
          )}
        >
          {STAGE_LABELS[deal.stage]}
        </Badge>
        <StageMeter rank={deal.stageRank} />
      </TableCell>

      <TableCell className="max-w-[9rem] px-3 py-3 text-[13px] text-muted-foreground">
        <span className="block truncate">{owner ?? "Unassigned"}</span>
      </TableCell>

      <TableCell className="px-3 py-3 text-right text-[13px] font-medium tabular-nums">
        {deal.priceCents === null ? (
          <span className="font-normal text-muted-foreground">—</span>
        ) : (
          money.format(deal.priceCents / 100)
        )}
      </TableCell>

      <TableCell className="px-3 py-3">
        {view === "lost" ? (
          <p className="truncate text-[12px] text-muted-foreground">
            {lostReason ?? "No reason recorded"}
          </p>
        ) : (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <NextActionCell action={action} className="min-w-0" />
            {view === "open" ? (
              <FollowUpControl
                prospectId={deal.prospectId}
                followUpAt={deal.nextFollowUpAt}
              />
            ) : null}
          </div>
        )}
      </TableCell>

      <TableCell
        // Pinned so the actions menu stays reachable when the table has to
        // scroll — it is the row's only affordance that is not a link.
        className="sticky right-0 w-10 bg-background px-2 py-3 text-right group-hover:bg-muted/50"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 rounded-none">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Actions for {deal.buyerName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 rounded-none">
            <DropdownMenuItem asChild>
              <Link href={`/sales/${encodeURIComponent(deal.dealId)}`}>
                Open deal
              </Link>
            </DropdownMenuItem>
            {deal.prospectId ? (
              <DropdownMenuItem onSelect={() => onLog(deal)}>
                Log activity
              </DropdownMenuItem>
            ) : null}
            {deal.prospectId && shopping ? (
              <DropdownMenuItem onSelect={() => onFindHome(deal)}>
                Find a home…
              </DropdownMenuItem>
            ) : null}
            {deal.prospectId &&
            deal.stage !== "closed" &&
            deal.stage !== "lost" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onMarkLost(deal)}
                >
                  Mark lost
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({
  view,
  filter,
  stage,
  search,
  viewTotal,
  onClear,
}: {
  view: DealView;
  filter: DealFilter;
  stage: SalesDealStage | null;
  search: string;
  viewTotal: number;
  onClear: () => void;
}) {
  const narrowed =
    filter !== "all" || stage !== null || search.trim().length > 0;

  if (narrowed) {
    const what = search.trim()
      ? `No deals for “${search.trim()}”`
      : stage
        ? `No deals in “${STAGE_LABELS[stage]}”`
        : `No deals in “${DEAL_FILTER_LABELS[filter]}”`;
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search />
          </EmptyMedia>
          <EmptyTitle className="text-base">Nothing matches</EmptyTitle>
          <EmptyDescription className="text-xs">
            {what}
            {viewTotal > 0 ? ` out of ${viewTotal}.` : "."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium underline underline-offset-2 hover:text-primary"
          >
            Clear filters
          </button>
        </EmptyContent>
      </Empty>
    );
  }

  if (view !== "open") {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Home />
          </EmptyMedia>
          <EmptyTitle className="text-base">
            {view === "closed" ? "No closings yet" : "Nothing lost"}
          </EmptyTitle>
          <EmptyDescription className="text-xs">
            {view === "closed"
              ? "Homes land here once the closing coordinator settles them."
              : "A deal appears here when you close it out with a reason."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link
            href="/sales"
            className="text-xs font-medium underline underline-offset-2 hover:text-primary"
          >
            Back to open deals
          </Link>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Home />
        </EmptyMedia>
        <EmptyTitle className="text-base">No open deals</EmptyTitle>
        <EmptyDescription className="text-xs">
          A deal starts the moment you register an inquiry, and follows the
          buyer all the way to settlement. Register one with{" "}
          <span className="font-medium text-foreground">New inquiry</span>.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
