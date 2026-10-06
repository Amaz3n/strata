"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, FileText, History, Map as PlansIcon, MoreHorizontal, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { PricingWorksheet, type LineFocus } from "@/components/precon/pricing-worksheet";
import { usePricingWorksheet } from "@/components/precon/use-pricing-worksheet";
import { BALL_STYLE } from "./pipeline-list";
import { DealNotes } from "./deal-notes";
import { DealQuestions, type DealQuestion } from "./deal-questions";
import { DealDocumentPane } from "./deal-document-pane";
import { DealClientSheet, type DealClient } from "./deal-client-sheet";
import { DealActivitySheet } from "./deal-activity-sheet";
import { MarkDealLostDialog } from "./mark-deal-lost-dialog";
import { StartBuildingDialog } from "./start-building-dialog";
import {
  countersignDealAction,
  remindDealClientAction,
  reopenDealAction,
  sendDealPriceAction,
  startDealPricingAction,
} from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import {
  DEAL_STOPS,
  dealMove,
  type DealAction,
  type DealDocument,
  type QuoteRequestStatus,
} from "@/lib/precon/deal-move";
import { EMPTY_PRICING_WORKSHEET, type PricingWorksheet as Worksheet } from "@/lib/precon/pricing-worksheet";
import type { ProspectStatus } from "@/lib/validation/prospects";
import type { BidPackage, ProspectBidQuote } from "@/lib/services/bids";
import type { Company, CostCode } from "@/lib/types";
import type { EstimatePreviewBranding } from "@/components/estimates/estimate-live-preview";
import { cn } from "@/lib/utils";

export type DealWorkbenchProps = {
  deal: {
    id: string;
    name: string;
    status: ProspectStatus;
    lostReason: string | null;
    projectId: string | null;
    projectPhase: "precon" | "delivery" | null;
    notes: string;
    client: DealClient;
  };
  workspace: { worksheet: Worksheet | null; version: number; available: boolean };
  canEdit: boolean;
  packages: BidPackage[];
  quotes: ProspectBidQuote[];
  companies: Company[];
  costCodes: CostCode[];
  branding?: EstimatePreviewBranding;
  recoveryScope: string;
  requests: QuoteRequestStatus[];
  documents: { proposal: DealDocument | null; agreement: DealDocument | null };
  questions: DealQuestion[];
  focusRow: string | null;
  now: string;
};

/**
 * One deal, one page. The header says whose move it is and offers the one thing
 * to do next; the work and the client's document sit side by side underneath.
 */
export function DealWorkbench(props: DealWorkbenchProps) {
  const { deal, workspace, canEdit, documents } = props;
  const router = useRouter();
  const closed = deal.status === "lost" || deal.status === "won" || deal.projectPhase === "delivery";
  const pricingStarted = workspace.worksheet !== null;
  const editable = canEdit && workspace.available && !closed;
  const state = usePricingWorksheet(
    deal.id,
    workspace.worksheet ?? EMPTY_PRICING_WORKSHEET,
    workspace.version,
    editable && pricingStarted,
    pricingStarted,
    `pricing-draft:${props.recoveryScope}:${deal.id}`,
  );
  const [notes, setNotes] = useState(deal.notes);
  const [view, setView] = useState<"work" | "document">("work");
  const [focus, setFocus] = useState<LineFocus | null>(
    props.focusRow ? { rowId: props.focusRow, mode: "expand", at: 0 } : null,
  );
  const [panel, setPanel] = useState<"client" | "activity" | "lost" | "start" | null>(null);
  const [pending, startTransition] = useTransition();
  const edited = state.dirty || state.version.current !== workspace.version;
  const openQuestions = props.questions.filter((question) => question.status === "open").length;
  const withEdits = (document: DealDocument | null) =>
    document && { ...document, changed_since: document.changed_since || edited };
  const move = dealMove({
    now: new Date(props.now),
    clientName: deal.client.name || null,
    status: deal.status,
    lostReason: deal.lostReason,
    projectPhase: deal.projectPhase,
    scope: notes,
    worksheet: pricingStarted ? state.worksheet : null,
    requests: props.requests,
    proposal: withEdits(documents.proposal),
    agreement: withEdits(documents.agreement),
    openQuestions,
  });
  const ball = BALL_STYLE[move.ball];
  // A focused line comes from the URL once; consume it so a refresh does not repeat it.
  useEffect(() => {
    if (!props.focusRow) return;
    window.history.replaceState(null, "", `/pipeline/${deal.id}`);
  }, [props.focusRow, deal.id]);
  const firmness = move.firmness;

  function run(work: () => Promise<void>) {
    startTransition(async () => {
      try {
        await work();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That did not work. Try again.");
      }
    });
  }

  function act(action: DealAction) {
    const now = Date.now();
    switch (action.kind) {
      case "describe":
        document.getElementById("deal-notes")?.focus();
        return;
      case "add_line":
        setView("work");
        document.getElementById("deal-add-line")?.focus();
        return;
      case "price_line":
      case "firm_up":
        setView("work");
        setFocus({ rowId: action.rowId, mode: "expand", at: now });
        return;
      case "send_request":
      case "review_quotes":
      case "follow_up_trades":
        setView("work");
        setFocus({ rowId: action.rowId, mode: "quotes", at: now });
        return;
      case "answer_questions":
        setView("work");
        document.getElementById("deal-questions")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      case "revise":
        setView("work");
        document.getElementById("deal-work")?.scrollIntoView({ behavior: "smooth", block: "start" });
        toast("Change the lines, then send the new version from the top.");
        return;
      case "start_pricing":
        return run(async () => {
          const result = unwrapAction(await startDealPricingAction(deal.id, notes));
          toast.success(`${result.lines} line${result.lines === 1 ? "" : "s"} to price. Start with the first one.`);
          router.refresh();
        });
      case "send":
        if (!deal.client.email) {
          toast("Add the client's email first. Arc sends the document there.");
          setPanel("client");
          return;
        }
        return run(async () => {
          const version = await state.save();
          const result = unwrapAction(await sendDealPriceAction(deal.id, action.document, version));
          if (result.emailSent) toast.success(`Sent to ${deal.client.email}`);
          else toast.warning("The document is ready, but the email did not go out. Use Remind to send it again.");
          router.refresh();
        });
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
      case "start_building":
        setPanel("start");
        return;
      case "open_project":
        if (deal.projectId) router.push(`/projects/${deal.projectId}`);
        return;
      case "reopen":
        return run(async () => {
          unwrapAction(await reopenDealAction(deal.id));
          toast.success("Deal reopened");
          router.refresh();
        });
    }
  }

  const disabled =
    pending ||
    !move.action ||
    (move.action.kind === "describe" && !notes.trim()) ||
    (move.action.kind !== "open_project" && !canEdit);
  const agreementId = documents.agreement?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b bg-background px-4 pt-3 sm:px-6">
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <OptimisticLink href="/pipeline" className="inline-flex items-center gap-1 hover:text-foreground lg:hidden">
            <ArrowLeft className="size-3.5" />
            Deals
          </OptimisticLink>
          <span className="font-medium text-foreground">{deal.client.name || "No client yet"}</span>
          {deal.client.phone && <span className="font-mono tabular-nums">{deal.client.phone}</span>}
          {deal.client.email && <span className="truncate">{deal.client.email}</span>}
          {deal.client.address && <span className="truncate">{deal.client.address}</span>}
          <span className="ml-auto flex items-center gap-0.5">
            {deal.projectId && (
              <>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <OptimisticLink href={`/pipeline/${deal.id}/plans`} prefetchOnIntent>
                    <PlansIcon className="size-3.5" />
                    Plans
                  </OptimisticLink>
                </Button>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <OptimisticLink href={`/pipeline/${deal.id}/files`} prefetchOnIntent>
                    <FileText className="size-3.5" />
                    Files
                  </OptimisticLink>
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPanel("activity")}>
              <History className="size-3.5" />
              Activity
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="More deal actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!canEdit || closed} onSelect={() => setPanel("client")}>
                  <UserRound className="size-4" />
                  Client details
                </DropdownMenuItem>
                {deal.status !== "lost" && !closed && (
                  <DropdownMenuItem disabled={!canEdit} onSelect={() => setPanel("lost")}>
                    Mark lost…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 pb-3 pt-1.5">
          <div className="min-w-0 flex-1 basis-80">
            <h1 className="text-balance text-xl font-semibold tracking-tight">{deal.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <span className={cn("inline-flex h-6 items-center gap-1.5 px-2 text-xs font-semibold", ball.chip)}>
                <span className={cn("size-1.5 rounded-full", ball.dot)} aria-hidden />
                {move.ball === "client" ? `Waiting on ${deal.client.name?.split(" ")[0] || "the client"}` : move.ball === "you" ? "Your move" : ball.label}
              </span>
              <p className="text-sm" aria-live="polite">{move.sentence}</p>
            </div>
          </div>
          {move.label && (
            <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
              <Button size="lg" className="h-10 px-5" disabled={disabled} onClick={() => move.action && act(move.action)}>
                {pending ? "Working…" : move.label}
                <ArrowRight className="size-4" />
              </Button>
              {move.detail && <p className="max-w-xs text-xs text-muted-foreground sm:text-right">{move.detail}</p>}
            </div>
          )}
        </div>
        <ol className="grid grid-cols-5 gap-0.5" aria-label="Where this deal is">
          {DEAL_STOPS.map((stop, index) => (
            <li
              key={stop}
              aria-current={index === move.stop ? "step" : undefined}
              className={cn(
                "border-t-[3px] pb-2.5 pt-1.5 text-[11px] sm:text-xs",
                index < move.stop && "border-foreground/40 text-muted-foreground",
                index === move.stop && "border-foreground font-semibold text-foreground",
                index > move.stop && "border-border text-muted-foreground/70",
              )}
            >
              {stop}
            </li>
          ))}
        </ol>
      </header>
      <div className="flex shrink-0 border-b bg-background px-4 sm:px-6 xl:hidden" role="tablist" aria-label="Deal view">
        {(
          [
            ["work", "The work"],
            ["document", `${deal.client.name?.split(" ")[0] || "Client"}'s view`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs font-semibold transition-colors duration-150",
              view === key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,34rem)]">
        <section
          id="deal-work"
          aria-label="The work"
          className={cn("desk-rise min-h-0 overflow-y-auto px-4 py-5 sm:px-6", view !== "work" && "hidden xl:block")}
        >
          {!pricingStarted ? (
            <DealNotes dealId={deal.id} notes={notes} onNotesChange={setNotes} editable={editable} clientName={deal.client.name} />
          ) : (
            <div className="space-y-8 pb-24">
              {firmness && (
                <PricingWorksheet
                  prospectId={deal.id}
                  projectId={deal.projectId}
                  state={state}
                  editable={editable}
                  available={workspace.available}
                  packages={props.packages}
                  companies={props.companies}
                  quotes={props.quotes}
                  costCodes={props.costCodes}
                  firmness={firmness}
                  focus={focus}
                />
              )}
              <DealQuestions dealId={deal.id} clientName={deal.client.name} questions={props.questions} editable={editable} />
              {deal.notes && (
                <section aria-label="Notes">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your notes</h2>
                  <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-muted-foreground">{deal.notes}</p>
                </section>
              )}
            </div>
          )}
        </section>
        <DealDocumentPane
          className={cn(view !== "document" && "hidden xl:flex")}
          dealName={deal.name}
          client={deal.client}
          notes={notes}
          worksheet={pricingStarted ? state.worksheet : null}
          signable={move.signable}
          range={move.firmness?.range ?? null}
          documents={{ proposal: withEdits(documents.proposal), agreement: withEdits(documents.agreement) }}
          questions={props.questions}
          branding={props.branding}
        />
      </div>
      <DealClientSheet open={panel === "client"} onOpenChange={(open) => setPanel(open ? "client" : null)} dealId={deal.id} dealName={deal.name} client={deal.client} />
      <DealActivitySheet open={panel === "activity"} onOpenChange={(open) => setPanel(open ? "activity" : null)} dealId={deal.id} canLog={editable} />
      <MarkDealLostDialog open={panel === "lost"} onOpenChange={(open) => setPanel(open ? "lost" : null)} dealId={deal.id} dealName={deal.name} />
      {agreementId && (
        <StartBuildingDialog
          open={panel === "start"}
          onOpenChange={(open) => setPanel(open ? "start" : null)}
          dealId={deal.id}
          dealName={deal.name}
          agreementId={agreementId}
        />
      )}
    </div>
  );
}
