"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Copy, Layers, Plus, Ruler, Search, X, type LucideIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { PricingWorksheet, type LineFocus } from "@/components/precon/pricing-worksheet";
import { searchDealPriceSourcesAction, startDealPriceAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { useOptimisticNavigate } from "@/lib/navigation/optimistic-pathname";
import { compactMoney } from "@/lib/precon/format";
import type { DealPriceSource, DealPriceStart, getDealPricing } from "@/lib/services/precon-deals";
import { DealDocumentPane } from "./deal-document-pane";
import { useDealRoom } from "./deal-room";

type PricingData = Awaited<ReturnType<typeof getDealPricing>>;

/**
 * The price, at full width. Until it has lines it asks where they come from;
 * then it is the list of lines and one rail beside it, and the client's
 * document is a preview away, never a second pane to keep in step.
 */
export function DealPricing({ packages, quotes, costCodes, templates, focusRow }: PricingData & { focusRow: string | null }) {
  const room = useDealRoom();
  const { deal, state, intent, pricingStarted, move } = room;
  const [preview, setPreview] = useState(false);
  // A line named in the link (from plans or an email) opens once, then leaves the URL.
  const [linked] = useState<LineFocus | null>(focusRow ? { rowId: focusRow, at: 0 } : null);
  useEffect(() => {
    if (focusRow) window.history.replaceState(null, "", `/pipeline/${deal.id}/pricing`);
  }, [focusRow, deal.id]);
  const addLineAt = intent?.kind === "add_line" ? intent.at : null;
  useEffect(() => {
    if (addLineAt !== null && pricingStarted) document.getElementById("deal-add-line")?.focus();
  }, [addLineAt, pricingStarted]);
  const focus = intent?.kind === "line" ? intent.focus : linked;
  const who = deal.client.name.split(" ")[0] || "the client";

  return (
    <div className="space-y-6">
      {!pricingStarted && <DealPriceStarts templates={templates} />}
      {pricingStarted && move.firmness && (
        <section aria-label="Pricing">
          <PricingWorksheet
            projectId={deal.projectId}
            state={state}
            editable={room.editable}
            available={room.workspace.available}
            packages={packages}
            quotes={quotes}
            costCodes={costCodes}
            firmness={move.firmness}
            requests={room.requests}
            signable={move.signable}
            clientName={deal.client.name}
            focus={focus}
            onPreview={() => setPreview(true)}
            onBids={room.showBids}
            onMeasure={room.plans.measure}
            prefetchPlans={room.plans.prefetch}
          />
        </section>
      )}
      <Sheet open={preview} onOpenChange={setPreview}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
          <SheetHeader className="border-b">
            <SheetTitle>What {who} will see</SheetTitle>
            <SheetDescription>It updates as you price. Nothing is sent until you send it.</SheetDescription>
          </SheetHeader>
          <DealDocumentPane
            className="min-h-0 flex-1 border-l-0"
            dealName={deal.name}
            client={deal.client}
            worksheet={state.worksheet}
            signable={move.signable}
            range={move.firmness?.range ?? null}
            documents={room.documents}
            questions={room.questions}
            branding={room.branding}
            proposal={room.proposal.model.document}
            pricingDisplay={room.proposal.state.proposal.pricing_display}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

type Choosing = "template" | "deal" | null;

/** Where the lines come from, asked once: only while the deal has no price at all. */
function DealPriceStarts({ templates }: { templates: PricingData["templates"] }) {
  const room = useDealRoom();
  const router = useRouter();
  const navigate = useOptimisticNavigate();
  const [choosing, setChoosing] = useState<Choosing>(null);
  const [pending, startTransition] = useTransition();
  const disabled = !room.editable || pending;

  function start(choice: DealPriceStart, then?: () => void) {
    startTransition(async () => {
      try {
        const result = unwrapAction(await startDealPriceAction(room.deal.id, choice));
        if (result.lines) toast.success(`${result.lines} line${result.lines === 1 ? "" : "s"} to firm up.`);
        router.refresh();
        then?.();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to start the price");
      }
    });
  }

  const options: Array<{ key: string; icon: LucideIcon; title: string; body: string; tag: string; onClick: () => void }> = [
    {
      key: "template",
      icon: Layers,
      title: "From a template",
      body: "Your saved line structure for this kind of build.",
      tag: templates.length ? `${templates.length} template${templates.length === 1 ? "" : "s"}` : "No templates yet",
      onClick: () => setChoosing("template"),
    },
    {
      key: "plans",
      icon: Ruler,
      title: "From the plans",
      body: "Upload drawings and measure lines straight off the sheets.",
      tag: "Measured lines are firm",
      onClick: () => start({ kind: "plans" }, () => navigate(room.href("plans"))),
    },
    {
      key: "deal",
      icon: Copy,
      title: "Copy a past deal",
      body: "Start from a job like this one and adjust.",
      tag: "Its quotes stay behind",
      onClick: () => setChoosing("deal"),
    },
    {
      key: "blank",
      icon: Plus,
      title: "Start blank",
      body: "Add the first line yourself.",
      tag: "One line at a time",
      onClick: () => start({ kind: "blank" }, () => room.act({ kind: "add_line" })),
    },
  ];

  return (
    <section aria-labelledby="deal-price-start" className="space-y-4">
      <div>
        <h2 id="deal-price-start" className="text-lg font-semibold">
          How do you want to start the price?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick where the lines come from. Every line starts as your own number until a quote or a measurement firms it up.
        </p>
      </div>
      {choosing === "template" ? (
        <ChoicePanel title="Your estimate templates" onBack={() => setChoosing(null)}>
          {templates.length ? (
            templates.map((template) => (
              <ChoiceRow
                key={template.id}
                title={template.name}
                detail={[template.description, `${template.lines} line${template.lines === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                disabled={disabled}
                onClick={() => start({ kind: "template", templateId: template.id })}
              />
            ))
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No estimate templates yet. Save one from Settings, or start another way.
            </p>
          )}
        </ChoicePanel>
      ) : choosing === "deal" ? (
        <ChoicePanel title="Copy a past deal" onBack={() => setChoosing(null)}>
          <PastDeals disabled={disabled} onPick={(dealId) => start({ kind: "deal", dealId })} />
        </ChoicePanel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.key}
                type="button"
                disabled={disabled}
                onClick={option.onClick}
                className="group grid content-start gap-2 border bg-card p-4 text-left shadow-xs transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:border-primary/45 hover:shadow-sm disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="grid size-9 place-items-center bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="text-[15px] font-semibold">{option.title}</span>
                <span className="text-[13px] text-muted-foreground">{option.body}</span>
                <span className="text-[11px] font-semibold text-primary">{option.tag}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ChoicePanel({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="border bg-card shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onBack}>
          <X className="size-3.5" />
          Back
        </Button>
      </div>
      <div className="divide-y">{children}</div>
    </div>
  );
}

function ChoiceRow({
  title,
  detail,
  aside,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  aside?: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-150 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium group-hover:text-primary">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {aside}
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-primary" />
    </button>
  );
}

function PastDeals({ disabled, onPick }: { disabled: boolean; onPick: (dealId: string) => void }) {
  const { deal, now } = useDealRoom();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{ deals: DealPriceSource[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchDealPriceSourcesAction(deal.id, search).then((response) => {
        if (cancelled) return;
        if (response.success) {
          setResult(response.data);
          setError(null);
        } else setError(response.error ?? "Unable to load past deals");
      });
    }, search ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deal.id, search]);
  const year = new Date(now).getFullYear();
  return (
    <>
      <div className="relative px-4 py-3">
        <Search className="pointer-events-none absolute left-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search past deals"
          className="pl-9"
          placeholder="Search past deals by name"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="px-4 py-4 text-sm text-destructive">{error}</p>
      ) : !result ? (
        <div className="space-y-2 px-4 py-3" aria-busy="true">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-10 w-full" />
          ))}
        </div>
      ) : result.deals.length ? (
        <>
          {result.deals.map((source) => {
            const updated = new Date(source.updatedAt);
            return (
              <ChoiceRow
                key={source.id}
                title={source.name}
                detail={`${source.lines} line${source.lines === 1 ? "" : "s"} · updated ${updated.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  ...(updated.getFullYear() !== year && { year: "numeric" }),
                })}`}
                aside={<span className="text-sm font-medium tabular-nums">{source.cost ? compactMoney(source.cost) : "—"}</span>}
                disabled={disabled}
                onClick={() => onPick(source.id)}
              />
            );
          })}
          {result.truncated && (
            <p className="px-4 py-2.5 text-xs text-muted-foreground">
              Showing the {result.deals.length} most recent. Search to find older deals.
            </p>
          )}
        </>
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {search ? "No priced deal matches that name." : "No other deal has lines yet."}
        </p>
      )}
    </>
  );
}
