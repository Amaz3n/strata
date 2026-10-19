"use client";

import { Fragment, useMemo, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Filter,
  Hammer,
  PenLine,
  Plus,
  Search,
  Send,
  Timer,
  Users,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { DEAL_STOPS, dealValueCents, type DealBall } from "@/lib/precon/deal-move";
import { money, waitingAge } from "@/lib/precon/format";
import type { PipelineDeal, PipelineDeals } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";
import { DealValueText, FirmnessMeter, LastActivity, OwnerBadge, type PipelineMember } from "./deal-facts";
import { STOP_STYLE } from "./deal-style";
import { NewDealDialog } from "./new-deal-dialog";
import "./pipeline.css";

const PAGE_SIZE = 25;
/** A deal nobody has moved in two weeks is stalled, whoever holds it. */
const STALLED_AFTER_DAYS = 14;
/** Your moves lead; within a lane the longest wait leads. */
const BALL_ORDER: Record<DealBall, number> = { you: 0, trades: 1, client: 2, building: 3, closed: 4 };
/** The pipeline ends at Signed: once building starts, the deal is the project's. */
const OPEN_STOPS = DEAL_STOPS.slice(0, DEAL_STOPS.indexOf("Building"));

type AttentionKey = "followup_due" | "stalled" | "you" | "trades" | "client";
type PipelineFilter = "open" | "won" | "lost" | `stop-${number}` | AttentionKey;

const ATTENTION: Array<{
  key: AttentionKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone: string;
}> = [
  { key: "followup_due", label: "Follow-ups due", icon: Bell, tone: "text-destructive border-destructive/40 bg-destructive/10" },
  { key: "stalled", label: "Stalled", icon: Timer, tone: "text-age-2 border-age-2/40 bg-age-2/10" },
  { key: "you", label: "Your move", icon: PenLine, tone: "text-warning border-warning/40 bg-warning/10" },
  { key: "trades", label: "Waiting on trades", icon: Hammer, tone: "text-chart-2 border-chart-2/40 bg-chart-2/10" },
  { key: "client", label: "Waiting on clients", icon: Send, tone: "text-primary border-primary/40 bg-primary/10" },
];

const FILTER_LABELS: Record<string, string> = {
  open: "Open deals",
  won: "Won",
  lost: "Lost",
  ...Object.fromEntries(OPEN_STOPS.map((stop, index) => [`stop-${index}`, stop])),
  ...Object.fromEntries(ATTENTION.map((item) => [item.key, item.label])),
};

/**
 * Every deal on one page: the funnel counts each stop, the chips pull out what
 * needs someone, and the table says what each deal is waiting on. Stage is
 * derived by `dealMove()`, so nothing here moves a deal; opening one does.
 */
export function PipelineOverview({
  data,
  members,
  currentUserId,
  canCreate,
  now,
}: {
  data: PipelineDeals;
  members: PipelineMember[];
  currentUserId: string | null;
  canCreate: boolean;
  now: string;
}) {
  const router = useRouter();
  const today = useMemo(() => new Date(now), [now]);
  const [filter, setFilter] = useState<PipelineFilter>("open");
  const [owner, setOwner] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  const stalled = (deal: PipelineDeal) => waitingAge(deal.waitingSince, today).days >= STALLED_AFTER_DAYS;
  const followUpDue = (deal: PipelineDeal) => deal.followUpAt !== null && new Date(deal.followUpAt) <= today;
  const attentionCount: Record<AttentionKey, number> = {
    followup_due: data.deals.filter(followUpDue).length,
    stalled: data.deals.filter(stalled).length,
    you: data.deals.filter((deal) => deal.ball === "you").length,
    trades: data.deals.filter((deal) => deal.ball === "trades").length,
    client: data.deals.filter((deal) => deal.ball === "client").length,
  };

  const choose = (next: PipelineFilter) => {
    setFilter((current) => (current === next ? "open" : next));
    setPage(1);
  };
  const matchesOwner = (ownerId: string | null) =>
    owner === "all" || (owner === "unassigned" ? ownerId === null : ownerId === owner);
  const matchesSearch = (...text: Array<string | null>) =>
    !search.trim() || text.join(" ").toLowerCase().includes(search.trim().toLowerCase());

  const rows = data.deals
    .filter((deal) => {
      if (filter === "open" || filter === "won" || filter === "lost") return true;
      if (filter.startsWith("stop-")) return deal.stop === Number(filter.slice(5));
      if (filter === "followup_due") return followUpDue(deal);
      if (filter === "stalled") return stalled(deal);
      return deal.ball === filter;
    })
    .filter((deal) => matchesOwner(deal.ownerId) && matchesSearch(deal.name, deal.clientName))
    .sort((a, b) => BALL_ORDER[a.ball] - BALL_ORDER[b.ball] || a.waitingSince.localeCompare(b.waitingSince));
  const won = data.won.filter((deal) => matchesOwner(deal.ownerId) && matchesSearch(deal.name));
  const lost = data.lost.filter((deal) => matchesOwner(deal.ownerId) && matchesSearch(deal.name, deal.reason));
  const showingWon = filter === "won";
  const showingLost = filter === "lost";
  const total = showingWon ? won.length : showingLost ? lost.length : rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const activeFilterCount = (filter !== "open" ? 1 : 0) + (owner !== "all" ? 1 : 0);
  const open = (id: string) => router.push(`/pipeline/${id}`);

  return (
    <div className="space-y-5">
      <StopFunnel
        deals={data.deals}
        active={filter}
        onSelect={(stop) => choose(`stop-${stop}`)}
      />

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search deals..."
                aria-label="Search deals"
                className="pl-9"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <Filter className="h-4 w-4" />
                  Filter
                  {activeFilterCount > 0 && (
                    <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Stage</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => {
                    setFilter(value as PipelineFilter);
                    setPage(1);
                  }}
                >
                  {(["open", ...OPEN_STOPS.map((_, index) => `stop-${index}`), "won", "lost"] as PipelineFilter[]).map(
                    (option) => (
                      <DropdownMenuRadioItem key={option} value={option}>
                        {FILTER_LABELS[option]}
                      </DropdownMenuRadioItem>
                    ),
                  )}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Assigned to</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={owner}
                  onValueChange={(value) => {
                    setOwner(value);
                    setPage(1);
                  }}
                >
                  <DropdownMenuRadioItem value="all">Anyone</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="unassigned">Unassigned</DropdownMenuRadioItem>
                  {members.map((member) => (
                    <DropdownMenuRadioItem key={member.id} value={member.id}>
                      {member.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {activeFilterCount > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setFilter("open");
                        setOwner("all");
                        setPage(1);
                      }}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Reset filters
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {ATTENTION.filter((item) => attentionCount[item.key] > 0).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => choose(item.key)}
                  aria-pressed={filter === item.key}
                  className={cn(
                    "inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-sm font-medium transition-all duration-150",
                    item.tone,
                    filter === item.key ? "ring-1 ring-current/40" : "hover:brightness-[0.97]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="font-semibold tabular-nums">{attentionCount[item.key]}</span>
                  <span className="font-normal">{item.label}</span>
                </button>
              );
            })}
          </div>
          {canCreate && (
            <Button onClick={() => setAdding(true)} className="deal-cta shrink-0">
              <Plus className="mr-2 h-4 w-4" />
              New deal
            </Button>
          )}
        </div>

        {data.truncated && !showingWon && !showingLost && (
          <p role="status" className="text-xs text-warning">
            Showing the 300 most recently active deals. Search or filter to narrow the list.
          </p>
        )}
        {showingWon && data.wonTotal > data.won.length && (
          <p role="status" className="text-xs text-warning">
            Showing the {data.won.length} most recent of {data.wonTotal} wins in the last {data.wonDays} days.
          </p>
        )}

        <div className="overflow-x-auto border bg-card shadow-xs">
          <Table className="min-w-[52rem] table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="microlabel px-4 py-2.5">Deal</TableHead>
                <TableHead className="microlabel w-36 px-4 py-2.5">Stage</TableHead>
                <TableHead className="microlabel w-36 px-4 py-2.5">Last activity</TableHead>
                <TableHead className="microlabel w-52 px-4 py-2.5">Firmness</TableHead>
                <TableHead className="microlabel w-40 px-4 py-2.5">Owner</TableHead>
                <TableHead className="microlabel w-32 px-4 py-2.5 text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showingWon
                ? won.slice(start, start + PAGE_SIZE).map((deal) => {
                    const href = deal.projectId ? `/projects/${deal.projectId}` : `/pipeline/${deal.id}`;
                    return (
                      <TableRow key={deal.id} className="group cursor-pointer" onClick={() => router.push(href)}>
                        <TableCell className="relative px-4 py-3">
                          <RowEdge className="group-hover:bg-success" />
                          <DealLink href={href} name={deal.name} />
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {deal.projectId ? "Open the project" : "No project yet"}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <Badge variant="secondary" className="border border-success/30 bg-success/15 text-success">
                            Won
                          </Badge>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <LastActivity at={deal.wonAt} today={today} />
                        </TableCell>
                        <TableCell className="px-4 py-3 text-muted-foreground">—</TableCell>
                        <TableCell className="px-4 py-3">
                          <OwnerBadge member={deal.ownerId ? memberById.get(deal.ownerId) : undefined} you={deal.ownerId === currentUserId} />
                        </TableCell>
                        <TableCell className="px-4 py-3 text-right">
                          {deal.valueCents ? (
                            <div>
                              <div className="text-sm font-semibold tabular-nums">{money(deal.valueCents)}</div>
                              <div className="mt-0.5 text-[11px] text-success">Signed</div>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                : showingLost
                ? lost.slice(start, start + PAGE_SIZE).map((deal) => (
                    <TableRow key={deal.id} className="group cursor-pointer" onClick={() => open(deal.id)}>
                      <TableCell className="relative px-4 py-3">
                        <RowEdge className="group-hover:bg-muted-foreground" />
                        <DealLink href={`/pipeline/${deal.id}`} name={deal.name} />
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <Badge variant="secondary" className="border border-destructive/30 bg-destructive/15 text-destructive">
                          Lost
                        </Badge>
                        {deal.reason && <p className="mt-1 truncate text-xs text-muted-foreground">{deal.reason}</p>}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        {deal.lostAt ? <LastActivity at={deal.lostAt} today={today} /> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground">—</TableCell>
                      <TableCell className="px-4 py-3">
                        <OwnerBadge member={deal.ownerId ? memberById.get(deal.ownerId) : undefined} you={deal.ownerId === currentUserId} />
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right text-muted-foreground">—</TableCell>
                    </TableRow>
                  ))
                : rows.slice(start, start + PAGE_SIZE).map((deal) => (
                    <TableRow key={deal.id} className="group cursor-pointer" onClick={() => open(deal.id)}>
                      <TableCell className="relative px-4 py-3">
                        <RowEdge className={STOP_STYLE[deal.stop].accent} />
                        <DealLink href={`/pipeline/${deal.id}`} name={deal.name} />
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">{deal.clientName ?? "No client yet"}</div>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <Badge variant="secondary" className={cn("border", STOP_STYLE[deal.stop].badge)}>
                          {DEAL_STOPS[deal.stop]}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <LastActivity at={deal.lastActivityAt} today={today} />
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <FirmnessMeter firmness={deal.firmness} />
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <OwnerBadge member={deal.ownerId ? memberById.get(deal.ownerId) : undefined} you={deal.ownerId === currentUserId} />
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right">
                        <DealValueText value={deal.value} />
                      </TableCell>
                    </TableRow>
                  ))}
              {total === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <Users className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">No deals found</p>
                        <p className="text-sm">
                          {showingWon && !search && owner === "all"
                            ? `No deals won in the last ${data.wonDays} days.`
                            : activeFilterCount > 0 || search
                            ? "Nothing matches this filter."
                            : "Add a deal when someone asks you to build something."}
                        </p>
                      </div>
                      {activeFilterCount > 0 || search ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setFilter("open");
                            setOwner("all");
                            setSearch("");
                          }}
                        >
                          Clear filter
                        </Button>
                      ) : canCreate ? (
                        <Button onClick={() => setAdding(true)} className="deal-cta">
                          <Plus className="mr-2 h-4 w-4" />
                          New deal
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-3 px-1">
            <span className="text-xs text-muted-foreground">
              Showing {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <span className="px-1 text-xs tabular-nums text-muted-foreground">
                {currentPage} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <NewDealDialog open={adding} onOpenChange={setAdding} members={members} currentUserId={currentUserId} />
    </div>
  );
}

/** The four stops an open deal passes through, counted, with the money waiting in each. */
function StopFunnel({
  deals,
  active,
  onSelect,
}: {
  deals: PipelineDeal[];
  active: PipelineFilter;
  onSelect: (stop: number) => void;
}) {
  const stops = OPEN_STOPS.map((label, index) => {
    const inStop = deals.filter((deal) => deal.stop === index);
    return {
      label,
      count: inStop.length,
      valueCents: inStop.reduce((sum, deal) => sum + dealValueCents(deal.value), 0),
    };
  });
  const total = stops.reduce((sum, stop) => sum + stop.count, 0);
  const max = Math.max(0, ...stops.map((stop) => stop.count));

  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:gap-0">
      {stops.map((stop, index) => {
        const style = STOP_STYLE[index];
        const isActive = active === `stop-${index}`;
        return (
          <Fragment key={stop.label}>
            <button
              type="button"
              onClick={() => onSelect(index)}
              aria-pressed={isActive}
              className={cn(
                "group relative flex flex-1 flex-col border bg-gradient-to-br p-4 text-left transition-all duration-150",
                "hover:-translate-y-0.5 hover:shadow-md active:translate-y-0",
                style.card,
                isActive && cn("ring-2 ring-offset-1 ring-offset-background", style.ring),
                !isActive && stop.count === 0 && "opacity-60",
              )}
            >
              <div className={cn("text-2xl font-bold tabular-nums leading-none sm:text-3xl", style.text)}>{stop.count}</div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{stop.label}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {total > 0 ? Math.round((stop.count / total) * 100) : 0}%
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/5">
                <div
                  className={cn("h-full rounded-full transition-all duration-150", style.bar, stop.count === 0 && "opacity-0")}
                  style={{ width: `${max > 0 ? Math.round((stop.count / max) * 100) : 0}%` }}
                />
              </div>
              <div className="mt-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                {stop.valueCents > 0 ? money(stop.valueCents) : "—"}
              </div>
            </button>
            {index < stops.length - 1 && (
              <div className="hidden w-6 shrink-0 items-center justify-center sm:flex">
                <ChevronRight className="h-4 w-4 text-muted-foreground/40" />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function DealLink({ href, name }: { href: string; name: string }) {
  return (
    <OptimisticLink
      href={href}
      prefetchOnIntent
      onClick={(event) => event.stopPropagation()}
      className="block truncate font-semibold transition-colors duration-150 hover:text-primary"
    >
      {name}
    </OptimisticLink>
  );
}

/** The hover edge: a row lights in the colour of the stage it is in. */
function RowEdge({ className }: { className: string }) {
  return <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors duration-150", className)} />;
}
