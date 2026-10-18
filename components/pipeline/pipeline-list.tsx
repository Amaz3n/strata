"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createDealAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { compactMoney, waitingAge } from "@/lib/precon/format";
import type { DealBall } from "@/lib/precon/deal-move";
import type { PipelineDeals } from "@/lib/services/precon-deals";
import { OptimisticLink, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname";
import { cn } from "@/lib/utils";

export const BALL_STYLE: Record<DealBall, { label: string; dot: string; chip: string }> = {
  you: { label: "Your move", dot: "bg-warning", chip: "bg-warning/15 text-warning" },
  trades: { label: "Waiting on trades", dot: "bg-chart-2", chip: "bg-chart-2/15 text-chart-2" },
  client: { label: "Waiting on clients", dot: "bg-primary", chip: "bg-primary/10 text-primary" },
  building: { label: "Started", dot: "bg-success", chip: "bg-success/15 text-success" },
  closed: { label: "Lost", dot: "bg-muted-foreground", chip: "bg-muted text-muted-foreground" },
};
const LANES: DealBall[] = ["you", "trades", "client", "building"];

export function PipelineList({
  data,
  canCreate,
  now,
}: {
  data: PipelineDeals;
  canCreate: boolean;
  now: string;
}) {
  const pathname = useOptimisticPathname();
  const selected = pathname.match(/^\/pipeline\/([^/]+)/)?.[1];
  const [adding, setAdding] = useState(false);
  const [showLost, setShowLost] = useState(false);
  const lanes = LANES.map((ball) => ({
    ball,
    deals: data.deals
      .filter((deal) => deal.ball === ball)
      .sort((a, b) =>
        ball === "building"
          ? b.waitingSince.localeCompare(a.waitingSince)
          : a.waitingSince.localeCompare(b.waitingSince),
      ),
  })).filter((lane) => lane.deals.length);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <p className="text-sm font-semibold">Deals</p>
        <span className="text-xs tabular-nums text-muted-foreground">{data.deals.length}</span>
        {canCreate && (
          <Button size="sm" className="ml-auto h-7" onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
            <Plus className="size-3.5" />
            New deal
          </Button>
        )}
      </div>
      {adding && <NewDealForm onDone={() => setAdding(false)} />}
      <nav aria-label="Deals" className="min-h-0 flex-1 overflow-y-auto pb-6">
        {data.truncated && (
          <p role="status" className="border-b px-4 py-2 text-xs text-warning">
            Showing the 300 most recently active deals.
          </p>
        )}
        {!lanes.length && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">No open deals</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a deal when someone asks you to build something.
            </p>
          </div>
        )}
        {lanes.map(({ ball, deals }) => (
          <section key={ball} aria-label={BALL_STYLE[ball].label} className="pt-4">
            <header className="flex items-center gap-2 px-4 pb-1.5">
              <span className={cn("size-2 rounded-full", BALL_STYLE[ball].dot)} aria-hidden />
              <h2 className="text-xs font-semibold">{BALL_STYLE[ball].label}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">{deals.length}</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                {compactMoney(deals.reduce((sum, deal) => sum + deal.valueCents, 0))}
              </span>
            </header>
            <ul>
              {deals.map((deal) => {
                const age = waitingAge(deal.waitingSince, new Date(now));
                const active = deal.id === selected;
                return (
                  <li key={deal.id}>
                    <OptimisticLink
                      href={`/pipeline/${deal.id}`}
                      prefetchOnIntent
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-y border-transparent py-2 pl-4 pr-4 transition-colors duration-150",
                        active
                          ? "border-border bg-background shadow-[inset_2px_0_0_var(--foreground)]"
                          : "hover:bg-background/60",
                      )}
                    >
                      <span className="truncate text-sm font-medium">{deal.name}</span>
                      <span className="text-right font-mono text-xs tabular-nums">
                        {deal.valueCents ? compactMoney(deal.valueCents) : "—"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{deal.sentence}</span>
                      <span
                        className={cn(
                          "text-right font-mono text-[11px] tabular-nums text-muted-foreground",
                          ball !== "building" && age.days >= 7 && "font-semibold text-age-2",
                          ball !== "building" && age.days >= 3 && age.days < 7 && "text-age-1",
                        )}
                      >
                        {age.label}
                      </span>
                    </OptimisticLink>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {data.lost.length > 0 && (
          <div className="px-4 pt-5">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showLost}
              onClick={() => setShowLost((value) => !value)}
            >
              Lost ({data.lost.length}){showLost ? " ▾" : " ▸"}
            </button>
            {showLost && (
              <ul className="mt-2 space-y-1">
                {data.lost.map((deal) => (
                  <li key={deal.id}>
                    <OptimisticLink
                      href={`/pipeline/${deal.id}`}
                      prefetchOnIntent
                      className="block truncate text-xs text-muted-foreground hover:text-foreground"
                    >
                      {deal.name}
                      {deal.reason ? ` · ${deal.reason}` : ""}
                    </OptimisticLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

function NewDealForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-2 border-b bg-background px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          try {
            const created = unwrapAction(await createDealAction({ name }));
            onDone();
            router.push(`/pipeline/${created.id}`);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to add the deal");
          }
        });
      }}
    >
      <label htmlFor="new-deal-name" className="text-xs font-medium">
        Who is it for?
      </label>
      <Input
        id="new-deal-name"
        autoFocus
        autoComplete="off"
        placeholder="The client's name, or the job"
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
        }}
      />
      <p className="text-xs text-muted-foreground">
        That is all Arc needs. Everything else is asked when it matters.
      </p>
    </form>
  );
}
