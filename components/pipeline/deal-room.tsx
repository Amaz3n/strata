"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, MoreHorizontal } from "@/components/icons";
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
import { OptimisticLink, useOptimisticNavigate, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname";
import type { LineFocus } from "@/components/precon/pricing-worksheet";
import { usePricingWorksheet } from "@/components/precon/use-pricing-worksheet";
import {
  assignDealOwnerAction,
  countersignDealAction,
  remindDealClientAction,
  reopenDealAction,
} from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { DEAL_STOPS, dealMove, dealValue, priceFirmness, linesToBid, type DealAction, type DealDocument, type DealMove } from "@/lib/precon/deal-move";
import { budgetBand } from "@/lib/precon/format";
import { EMPTY_PRICING_WORKSHEET } from "@/lib/precon/pricing-worksheet";
import type { ProposalSectionKey } from "@/lib/precon/proposal-documents";
import type { DealRoomData } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";
import { DealClientSheet } from "./deal-client-sheet";
import { DealValueText, FirmnessMeter, LastActivity, OwnerBadge } from "./deal-facts";
import { followUpWhen, shortDay } from "./follow-up";
import { BALL_STYLE, STOP_STYLE } from "./deal-style";
import { MarkDealLostDialog } from "./mark-deal-lost-dialog";
import { dealProposalModel, type DealProposalModel } from "./proposal-model";
import { useDealProposal } from "./use-deal-proposal";
import { StartBuildingDialog } from "./start-building-dialog";
import { useDealDrawings } from "./deal-drawings";
import "./pipeline.css";

type Panel = "client" | "lost" | "start";

/** A request from the header to a tab: open a line, put the cursor in the new-line box, or open a line's bids. */
export type DealIntent =
  | { kind: "line"; focus: LineFocus }
  | { kind: "add_line"; at: number }
  | { kind: "bids"; rowId: string | null; at: number }
  | { kind: "proposal"; section: ProposalSectionKey; at: number }
  | { kind: "send"; at: number };

type DealRoomValue = Omit<DealRoomData, "proposal"> & {
  /** What the builder wrote around the price, the document it makes, and the client's comments. */
  proposal: DealRoomData["proposal"] & { state: ReturnType<typeof useDealProposal>; model: DealProposalModel };
  state: ReturnType<typeof usePricingWorksheet>;
  pricingStarted: boolean;
  editable: boolean;
  move: DealMove;
  documents: { proposal: DealDocument | null; agreement: DealDocument | null };
  intent: DealIntent | null;
  act: (action: DealAction) => void;
  /** The deal's drawings: read a sheet full screen, or measure a line onto Pricing. */
  plans: ReturnType<typeof useDealDrawings>["api"];
  /** Bids, opened at the request for a line (or the line's new request) when one is named. */
  showBids: (rowId?: string) => void;
  pending: boolean;
  openPanel: (panel: Panel) => void;
  href: (tab?: string) => string;
  /** The server's clock at render, so server and browser word ages the same. */
  now: string;
};

const DealRoomContext = createContext<DealRoomValue | null>(null);

/** The deal every tab shares: its records, the live worksheet and the one next move. */
export function useDealRoom() {
  const room = useContext(DealRoomContext);
  if (!room) throw new Error("useDealRoom must be used inside the deal room.");
  return room;
}

const TABS = [
  ["", "Overview"],
  ["pricing", "Pricing"],
  ["bids", "Bids"],
  ["proposal", "Proposal"],
  ["plans", "Plans"],
  ["files", "Files"],
] as const;

/**
 * One deal. The header is the deal's position: who it is for, what it is worth,
 * how firm the price is and the one thing to do next. The tabs below it are
 * routes, so each can be linked to, and the header holds across them.
 */
export function DealRoom({ children, now, ...data }: DealRoomData & { children: ReactNode; now: string }) {
  const { deal, workspace, canEdit } = data;
  const router = useRouter();
  const navigate = useOptimisticNavigate();
  const pathname = useOptimisticPathname();
  const closed = deal.status === "lost" || deal.status === "won" || deal.projectPhase === "delivery";
  const pricingStarted = workspace.worksheet !== null;
  const editable = canEdit && workspace.available && !closed;
  const state = usePricingWorksheet(
    deal.id,
    workspace.worksheet ?? EMPTY_PRICING_WORKSHEET,
    workspace.version,
    editable && pricingStarted,
    pricingStarted,
    `pricing-draft:${data.recoveryScope}:${deal.id}`,
  );
  const [panel, setPanel] = useState<Panel | null>(null);
  const [intent, setIntent] = useState<DealIntent | null>(null);
  const [pending, startTransition] = useTransition();
  const drawings = useDealDrawings({
    dealId: deal.id,
    projectId: deal.projectId,
    state,
    editable: editable && pricingStarted,
    canMeasure: data.canMeasure && editable,
    modelEnabled: data.modelEnabled,
    planChanges: data.planChanges,
  });
  const writing = useDealProposal(deal.id, data.proposal.content, data.proposal.version, editable && data.proposal.available);
  const edited =
    state.dirty ||
    state.version.current !== workspace.version ||
    writing.dirty ||
    writing.version.current !== data.proposal.version;
  const withEdits = (document: DealDocument | null) =>
    document && { ...document, changed_since: document.changed_since || edited };
  const documents = { proposal: withEdits(data.documents.proposal), agreement: withEdits(data.documents.agreement) };
  const moveInput = {
    now: new Date(now),
    clientName: deal.client.name || null,
    status: deal.status,
    lostReason: deal.lostReason,
    projectPhase: deal.projectPhase,
    worksheet: pricingStarted ? state.worksheet : null,
    requests: data.requests,
    proposal: documents.proposal,
    agreement: documents.agreement,
    openQuestions: data.questions.filter((question) => question.status === "open").length,
    priceMode: writing.proposal.price_mode,
    planChanges: { review: data.planChanges.review.length, changed: data.planChanges.changed.length },
  };
  const firmness = useMemo(
    () => (pricingStarted ? priceFirmness(state.worksheet, data.requests) : null),
    [pricingStarted, state.worksheet, data.requests],
  );
  const sender = data.members.find((member) => member.id === data.currentUserId)?.name ?? "";
  const model = useMemo(
    () =>
      dealProposalModel({
        proposal: writing.proposal,
        data: data.proposal,
        defaults: data.proposalDefaults,
        worksheet: pricingStarted ? state.worksheet : null,
        range: firmness?.range ?? null,
        total: firmness?.total ?? 0,
        client: deal.client,
        dealName: deal.name,
        builder: data.branding.name ?? "",
        sender,
        today: new Date(now),
      }),
    [writing.proposal, data.proposal, data.proposalDefaults, pricingStarted, state.worksheet, firmness, deal.client, deal.name, data.branding.name, sender, now],
  );
  const move = dealMove({
    ...moveInput,
    proposalNeeds: pricingStarted && state.worksheet.rows.length ? model.needs : undefined,
    unansweredComments: model.unanswered,
  });
  const base = `/pipeline/${deal.id}`;
  const href = (tab = "") => (tab ? `${base}/${tab}` : base);
  const go = (tab: string) => {
    if (pathname !== href(tab)) navigate(href(tab));
  };

  function run(work: () => Promise<void>) {
    startTransition(async () => {
      try {
        await work();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That did not work. Try again.");
      }
    });
  }

  function showBids(rowId?: string) {
    setIntent({ kind: "bids", rowId: rowId ?? null, at: Date.now() });
    go("bids");
  }

  function act(action: DealAction) {
    const at = Date.now();
    switch (action.kind) {
      case "start_price":
        return go("pricing");
      case "add_line":
        setIntent({ kind: "add_line", at });
        return go("pricing");
      case "price_line":
        setIntent({ kind: "line", focus: { rowId: action.rowId, at } });
        return go("pricing");
      case "request_bids":
        return showBids();
      case "send_request":
      case "review_quotes":
      case "follow_up_trades":
        return showBids(action.rowId);
      case "open_proposal":
        setIntent({ kind: "proposal", section: action.section, at });
        return go("proposal");
      case "revise":
        toast("Change the lines, then send the new version from the header.");
        return go("pricing");
      case "send":
        setIntent({ kind: "send", at });
        return go("proposal");
      case "remind_client":
        return run(async () => {
          const result = unwrapAction(await remindDealClientAction(deal.id, action.documentId));
          if (result.emailSent) toast.success(`Reminder sent to ${deal.client.email || "the client"}`);
          else toast.warning("The reminder email did not go out. Try again shortly.");
          router.refresh();
        });
      case "countersign":
        return run(async () => {
          const link = unwrapAction(await countersignDealAction(deal.id, action.documentId));
          window.location.assign(link.url);
        });
      case "review_plan_measurements":
        return drawings.api.reviewMeasurements();
      case "review_plan_quantities":
        return drawings.api.reviewQuantities();
      case "start_building":
        setPanel("start");
        return;
      case "open_project":
        if (deal.projectId) navigate(`/projects/${deal.projectId}`);
        return;
      case "reopen":
        return run(async () => {
          unwrapAction(await reopenDealAction(deal.id));
          toast.success("Deal reopened");
          router.refresh();
        });
    }
  }

  const value: DealRoomValue = {
    ...data,
    proposal: { ...data.proposal, state: writing, model },
    state,
    pricingStarted,
    editable,
    move,
    documents,
    intent,
    act,
    plans: drawings.api,
    showBids,
    pending: pending || drawings.api.busy,
    openPanel: setPanel,
    href,
    now,
  };
  const agreementId = data.documents.agreement?.id ?? null;

  return (
    <DealRoomContext.Provider value={value}>
      <div className="desk-rise mx-auto w-full max-w-[calc(50%+36rem)] space-y-5">
        <DealHeader />
        <DealTabs />
        <div className="min-w-0 pb-16 pt-2">{children}</div>
      </div>
      <DealClientSheet
        open={panel === "client"}
        onOpenChange={(open) => setPanel(open ? "client" : null)}
        dealId={deal.id}
        dealName={deal.name}
        client={deal.client}
      />
      <MarkDealLostDialog
        open={panel === "lost"}
        onOpenChange={(open) => setPanel(open ? "lost" : null)}
        dealId={deal.id}
        dealName={deal.name}
      />
      {drawings.overlay}
      {agreementId && (
        <StartBuildingDialog
          open={panel === "start"}
          onOpenChange={(open) => setPanel(open ? "start" : null)}
          dealId={deal.id}
          dealName={deal.name}
          agreementId={agreementId}
        />
      )}
    </DealRoomContext.Provider>
  );
}

function StageBadge({ move }: { move: DealMove }) {
  if (move.ball === "closed")
    return <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">Lost</Badge>;
  if (move.ball === "building")
    return <Badge variant="outline" className="border-success/30 bg-success/15 text-success">Won</Badge>;
  return (
    <Badge variant="outline" className={STOP_STYLE[move.stop].badge}>
      {DEAL_STOPS[move.stop]}
    </Badge>
  );
}

function DealHeader() {
  const room = useDealRoom();
  const { deal, move, documents, canEdit, editable, members, currentUserId } = room;
  const [assigning, startAssign] = useTransition();
  const router = useRouter();
  const owner = members.find((member) => member.id === deal.ownerId);
  const firmness = move.firmness;
  const band = budgetBand(deal.budget);
  const today = new Date(room.now);
  const followUp = deal.followUpAt ? followUpWhen(deal.followUpAt, today) : null;

  function assign(ownerId: string | null) {
    startAssign(async () => {
      try {
        unwrapAction(await assignDealOwnerAction(deal.id, ownerId));
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to reassign the deal");
      }
    });
  }

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-balance text-2xl font-semibold tracking-tight">{deal.name}</h1>
        <StageBadge move={move} />
        <div className="ml-auto flex items-center gap-1">
          {canEdit && !assigning ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="p-1 transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Owner: ${owner?.name ?? "unassigned"}. Change the owner`}
              >
                <OwnerBadge member={owner} you={deal.ownerId === currentUserId} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Owner</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={deal.ownerId ?? ""} onValueChange={(id) => assign(id || null)}>
                  {members.map((member) => (
                    <DropdownMenuRadioItem key={member.id} value={member.id}>
                      {member.id === currentUserId ? `${member.name} (you)` : member.name}
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value="">Unassigned</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="p-1">
              <OwnerBadge member={owner} you={deal.ownerId === currentUserId} />
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More deal actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!editable} onSelect={() => room.openPanel("client")}>
                Edit details
              </DropdownMenuItem>
              {deal.status === "lost" ? (
                <DropdownMenuItem disabled={!canEdit} onSelect={() => room.act({ kind: "reopen" })}>
                  Reopen deal
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={!editable}
                  className="text-destructive focus:text-destructive"
                  onSelect={() => room.openPanel("lost")}
                >
                  Mark lost…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <dl className="grid border bg-card shadow-xs sm:grid-cols-2 lg:grid-cols-[1.1fr_1.6fr_1fr_1fr_1fr]">
        <Fact label="Value">
          <DealValueText value={dealValue(move, documents, deal.budget)} />
        </Fact>
        <Fact label="Firmness">
          <FirmnessMeter firmness={firmness} />
        </Fact>
        <Fact label="Last activity">
          <LastActivity at={deal.lastActivityAt} today={today} />
        </Fact>
        <Fact label="Next follow-up">
          {followUp ? (
            <div className="tabular-nums">
              <div className={cn("text-sm font-medium", followUp.tone)}>{followUp.label}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{shortDay(deal.followUpAt ?? "", today)}</div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">None set</div>
          )}
        </Fact>
        <Fact label="Budget · timeframe">
          <div className="truncate text-sm font-semibold tabular-nums">{band ?? deal.budget ?? "—"}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{deal.timeframe ?? "No timeframe yet"}</div>
        </Fact>
      </dl>

      <DealNextMove />
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 border-t px-4 py-3 first:border-t-0 sm:[&:nth-child(2)]:border-t-0 lg:border-l lg:border-t-0 lg:first:border-l-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The one next move: whose it is, what it is, and the button that does it. */
function DealNextMove() {
  const room = useDealRoom();
  const { deal, move, canEdit, pending } = room;
  const ball = BALL_STYLE[move.ball];
  const firstName = deal.client.name.split(" ")[0];
  const label = move.ball === "client" ? `Waiting on ${firstName || "the client"}` : ball.label;
  const disabled = pending || !move.action || (move.action.kind !== "open_project" && !canEdit);
  return (
    <section
      aria-label="Next move"
      className={cn("flex flex-wrap items-center gap-x-6 gap-y-3 border border-l-2 bg-card py-3.5 pl-4 pr-3.5 shadow-xs", ball.edge)}
    >
      <div className="min-w-0 flex-[1_1_20rem] space-y-1">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", ball.chip)}>
          <span aria-hidden className={cn("size-1.5 rounded-full", ball.dot)} />
          {label}
        </span>
        <p className="text-[15px] font-semibold leading-snug" aria-live="polite">
          {move.sentence}
        </p>
        {move.detail && <p className="text-[13px] text-muted-foreground">{move.detail}</p>}
      </div>
      {move.label && move.action && (
        <Button className="h-9 px-4" disabled={disabled} onClick={() => move.action && room.act(move.action)}>
          {pending ? "Working…" : move.label}
          <ArrowRight className="size-4" />
        </Button>
      )}
    </section>
  );
}

function DealTabs() {
  const room = useDealRoom();
  const pathname = useOptimisticPathname();
  const lines = room.state.worksheet.rows.length;
  // Lines waiting for a request and bids waiting on a choice light the count: that is work on Bids.
  const toBid = room.pricingStarted ? linesToBid(room.state.worksheet, room.requests).length : 0;
  const toReview = new Set(
    [...(room.move.firmness?.lines.values() ?? [])].flatMap((line) => (line.kind === "quotes_in" ? [line.packageId] : [])),
  ).size;
  const planWork = room.planChanges.review.length + room.planChanges.changed.length;
  const counts: Partial<Record<(typeof TABS)[number][0], { count: number; hot?: boolean }>> = {
    pricing: room.pricingStarted && lines ? { count: lines } : undefined,
    bids: room.requests.length + toBid ? { count: room.requests.length + toBid, hot: toReview > 0 || toBid > 0 } : undefined,
    plans: planWork ? { count: planWork, hot: true } : undefined,
  };
  const active = TABS.find(([tab]) => {
    const target = room.href(tab);
    return tab ? pathname === target || pathname.startsWith(`${target}/`) : pathname === target;
  })?.[0];
  const nav = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number; ready: boolean } | null>(null);
  // The underline slides between tabs; it is placed without motion the first time.
  useLayoutEffect(() => {
    const element = nav.current;
    if (!element) return;
    const place = () => {
      const tab = element.querySelector<HTMLElement>('[aria-current="page"]');
      setBar((previous) =>
        tab ? { left: tab.offsetLeft + 10, width: tab.offsetWidth - 20, ready: previous !== null } : null,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return (
    <nav ref={nav} aria-label="Deal" className="relative flex gap-1 overflow-x-auto border-b [scrollbar-width:none]">
      {TABS.map(([tab, label]) => {
        const target = room.href(tab);
        const count = counts[tab];
        return (
          <OptimisticLink
            key={tab}
            href={target}
            aria-current={tab === active ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground",
              tab === active && "text-foreground",
            )}
          >
            {label}
            {count && (
              <span
                className={cn(
                  "inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                  count.hot ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                )}
              >
                {count.count}
              </span>
            )}
          </OptimisticLink>
        );
      })}
      {bar && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary",
            bar.ready && "transition-[transform,width] duration-200 ease-out",
          )}
          style={{ transform: `translateX(${bar.left}px)`, width: bar.width }}
        />
      )}
    </nav>
  );
}
