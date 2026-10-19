"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, Hammer } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { bidTrades, levelBid, liveBids, type BidTrade, type BidTradeStatus } from "@/lib/precon/deal-bids";
import { money } from "@/lib/precon/format";
import { rowPricing, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import type { DealBidRequest, DealBidsData } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";
import { DealBidBidders } from "./deal-bid-bidders";
import { DealBidLeveling } from "./deal-bid-leveling";
import { DealBidQuestions } from "./deal-bid-questions";
import { DealBidScope, DealBidUnassigned } from "./deal-bid-scope";
import { useDealRoom } from "./deal-room";
import { useBidActions, type BidActions } from "./use-bid-actions";

export type BidView = "scope" | "bidders" | "leveling" | "questions";

export const TRADE_TONE: Record<BidTradeStatus, string> = {
  choose: "text-warning",
  late: "text-age-2",
  draft: "text-primary",
  unassigned: "text-muted-foreground",
  out: "text-chart-2",
  chosen: "text-success",
};

const DEFAULT_VIEW: Record<BidTradeStatus, BidView> = {
  choose: "leveling",
  late: "bidders",
  draft: "scope",
  unassigned: "scope",
  out: "bidders",
  chosen: "leveling",
};

/** Your number for the lines a request covers: what Pricing carries until a bid replaces it. */
export function placeholderCents(worksheet: PricingWorksheet, rowIds: string[]) {
  let total: number | null = null;
  for (const id of rowIds) {
    const row = worksheet.rows.find((item) => item.id === id);
    // Ignore any chosen bid: this is the number Pricing falls back to.
    const cost = row ? rowPricing(row, { ...worksheet, requests: [] }).cost : null;
    if (cost !== null) total = (total ?? 0) + cost;
  }
  return total;
}

/** The lowest leveled bid on a request, alternates left out. */
function lowestLeveled(request: DealBidRequest, now: Date) {
  const live = liveBids(request.submissions, request.pkg.scope_revision, now.toISOString().slice(0, 10));
  return live.length ? Math.min(...live.map((bid) => levelBid(bid, request.scope, []).leveled)) : null;
}

/**
 * Bids: the trade side of the price. Each trade is one request; the list says
 * where every trade stands, and the workspace beside it is where its scope is
 * written, its bidders chased, its bids leveled and one chosen for Pricing.
 */
export function DealBids(data: DealBidsData) {
  const room = useDealRoom();
  const now = useMemo(() => new Date(room.now), [room.now]);
  const worksheet = room.state.worksheet;
  const trades = useMemo(
    () =>
      room.pricingStarted
        ? bidTrades({ worksheet, requests: data.requests, statuses: room.requests, costCodes: data.costCodes, now })
        : [],
    [room.pricingStarted, worksheet, data.requests, room.requests, data.costCodes, now],
  );
  const [selectedKey, select] = useWorkspaceParam("trade");
  const [views, setViews] = useState<Record<string, BidView>>({});
  const actions = useBidActions();

  // The header (or a line on Pricing) sent us here for one line: open the trade that carries it.
  const intent = room.intent?.kind === "bids" ? room.intent : null;
  useEffect(() => {
    if (!intent?.rowId) return;
    const trade = trades.find((item) => item.rowIds.includes(intent.rowId ?? ""));
    if (trade) select(trade.key);
    // An intent is consumed once, by its timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.at]);

  if (!trades.length)
    return (
      <div className="grid justify-items-center gap-2 border bg-card px-6 py-12 text-center shadow-xs">
        <span className="grid size-10 place-items-center bg-chart-2/10 text-chart-2">
          <Hammer className="size-5" />
        </span>
        <h2 className="text-base font-semibold">Nothing goes out for bids yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          On Pricing, open a line and choose Bids. It lands here under its trade, ready to send, and the bid you choose prices the line.
        </p>
        <Button asChild size="sm" className="mt-2">
          <OptimisticLink href={room.href("pricing")}>Go to pricing</OptimisticLink>
        </Button>
      </div>
    );

  const trade = trades.find((item) => item.key === selectedKey) ?? trades[0];
  const request = trade.packageId ? (data.requests.find((item) => item.pkg.id === trade.packageId) ?? null) : null;
  const view = views[trade.key] ?? DEFAULT_VIEW[trade.status];
  const setView = (next: BidView) => setViews((current) => ({ ...current, [trade.key]: next }));

  return (
    <div className="space-y-2">
      <div className="grid min-h-[34rem] border bg-card shadow-xs lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        <nav aria-label="Trades" className="border-b bg-muted/25 p-2 lg:border-b-0 lg:border-r">
          <div className="flex items-baseline justify-between px-2.5 pb-2 pt-1.5">
            <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Trades</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{trades.length}</span>
          </div>
          <ul className="grid gap-px">
            {trades.map((item) => (
              <li key={item.key}>
                <TradeItem
                  trade={item}
                  request={item.packageId ? (data.requests.find((entry) => entry.pkg.id === item.packageId) ?? null) : null}
                  selected={item.key === trade.key}
                  onSelect={() => select(item.key)}
                />
              </li>
            ))}
          </ul>
          <p className="px-2.5 pt-3 text-xs text-muted-foreground">
            Lines arrive here when you choose Bids on Pricing, grouped by their cost code.
          </p>
        </nav>
        <section aria-label={trade.name} className="min-w-0">
          {trade.status === "unassigned" ? (
            <DealBidUnassigned trade={trade} costCodes={data.costCodes} />
          ) : (
            <Workspace key={trade.key} trade={trade} request={request} data={data} view={view} setView={setView} actions={actions} />
          )}
        </section>
      </div>
      {data.truncated && (
        <p className="text-xs text-muted-foreground">Showing the newest {data.requests.length} requests. Older ones are on the project&apos;s Bids page.</p>
      )}
    </div>
  );
}

function TradeItem({ trade, request, selected, onSelect }: { trade: BidTrade; request: DealBidRequest | null; selected: boolean; onSelect: () => void }) {
  const room = useDealRoom();
  const now = new Date(room.now);
  const linked = room.state.worksheet.requests.find((item) => item.package_id === trade.packageId);
  const lowest = request && trade.status === "choose" ? lowestLeveled(request, now) : null;
  const held = placeholderCents(room.state.worksheet, trade.rowIds);
  const [amount, caption] = linked?.quote
    ? [linked.quote.normalized_total_cents, linked.quote.company_name ?? "Chosen bid"]
    : lowest !== null
      ? [lowest, "lowest leveled"]
      : [held, "placeholder"];
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-2.5 py-2 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring",
        selected && "bg-background shadow-xs hover:bg-background",
      )}
    >
      <span className={cn("truncate text-[13px]", selected ? "font-semibold" : "font-medium")}>{trade.name}</span>
      <span className={cn("text-right text-[13px] tabular-nums", caption === "placeholder" ? "text-muted-foreground" : "font-semibold")}>
        {amount !== null ? money(amount) : "—"}
      </span>
      <span className={cn("inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-medium", TRADE_TONE[trade.status])}>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
        {trade.label}
      </span>
      <span className="truncate text-right text-[11px] text-muted-foreground">{caption}</span>
    </button>
  );
}

function Workspace({
  trade,
  request,
  data,
  view,
  setView,
  actions,
}: {
  trade: BidTrade;
  request: DealBidRequest | null;
  data: DealBidsData;
  view: BidView;
  setView: (view: BidView) => void;
  actions: BidActions;
}) {
  const room = useDealRoom();
  const now = new Date(room.now);
  const linked = room.state.worksheet.requests.find((item) => item.package_id === trade.packageId);
  const held = placeholderCents(room.state.worksheet, trade.rowIds);
  const live = request ? liveBids(request.submissions, request.pkg.scope_revision, now.toISOString().slice(0, 10)) : [];
  const waiting = request
    ? request.invites.filter(
        (invite) => !["declined", "withdrawn", "submitted"].includes(invite.status) && !live.some((bid) => bid.bid_invite_id === invite.id),
      )
    : [];
  const open = request?.questions.filter((question) => !question.answers.length).length ?? 0;
  const sent = !!request && request.pkg.status !== "draft" && request.invites.length > 0;
  const views: [BidView, string, number | null, boolean][] = sent
    ? [
        ["scope", "Scope", null, false],
        ["bidders", "Bidders", request.invites.length, false],
        ["leveling", "Leveling", live.length, trade.status === "choose"],
        ["questions", "Questions", request.questions.length || null, open > 0],
      ]
    : [["scope", "Scope", null, false]];
  const current = sent ? view : "scope";
  const due = request?.pkg.due_at ? new Date(request.pkg.due_at) : null;
  const lines = request ? request.scope.length : trade.rowIds.length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3.5">
        <h2 className="text-base font-semibold tracking-tight">{trade.name}</h2>
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", TRADE_TONE[trade.status])}>
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {trade.label}
        </span>
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {linked?.quote ? (
            <div className="flex gap-1">
              <dt>Using</dt>
              <dd className="font-medium text-foreground">
                {linked.quote.company_name} · <span className="tabular-nums">{money(linked.quote.normalized_total_cents)}</span>
              </dd>
            </div>
          ) : (
            <div className="flex gap-1">
              <dt>Placeholder</dt>
              <dd className="font-medium tabular-nums text-foreground">{held !== null ? money(held) : "None yet"}</dd>
            </div>
          )}
          {sent && due && (
            <div className="flex gap-1">
              <dt>Due</dt>
              <dd className={cn("font-medium", due < now ? "text-age-2" : "text-foreground")}>
                {due.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </dd>
            </div>
          )}
          <div>
            {lines} line{lines === 1 ? "" : "s"}
            {request?.terms.sheet_ids.length ? ` · ${request.terms.sheet_ids.length} sheets` : ""}
          </div>
        </dl>
        {sent && waiting.length > 0 && room.editable && !linked?.quote && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 text-xs"
            disabled={actions.pending}
            onClick={() => actions.remind(request.pkg.id, waiting.map((invite) => invite.id))}
          >
            <Bell className="size-3.5" />
            Remind {waiting.length}
          </Button>
        )}
      </header>
      {views.length > 1 && (
        <div role="tablist" aria-label={`${trade.name} views`} className="flex gap-1 border-b px-4">
          {views.map(([key, label, count, hot]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={current === key}
              onClick={() => setView(key)}
              className={cn(
                "relative inline-flex h-10 items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground",
                current === key && "text-foreground after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:bg-foreground",
              )}
            >
              {label}
              {count !== null && (
                <span
                  className={cn(
                    "min-w-5 rounded-full px-1.5 text-center text-[11px] tabular-nums",
                    hot ? "bg-warning/15 font-semibold text-warning" : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="min-w-0 flex-1 p-5">
        {current === "scope" && <DealBidScope trade={trade} request={request} data={data} actions={actions} />}
        {current === "bidders" && request && <DealBidBidders request={request} actions={actions} bidders={data.bidders} onLevel={() => setView("leveling")} />}
        {current === "leveling" && request && <DealBidLeveling request={request} actions={actions} />}
        {current === "questions" && request && <DealBidQuestions request={request} actions={actions} />}
      </div>
    </div>
  );
}
