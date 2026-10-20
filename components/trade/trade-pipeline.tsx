"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createTradeOpportunityAction,
  trackBuilderInvitationAction,
} from "@/app/(app)/pipeline/trade-actions";
import type { TradeOpportunityList } from "@/lib/services/trade-quotes";
import { QUOTE_STAGES, type QuoteStage } from "@/lib/trade/quote";
import {
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_SOURCE_LABELS,
} from "@/lib/validation/trade-quotes";
import { cn, formatLocalDate, formatMoneyCents } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const INVITATION_CAP = 20;

function NewOpportunity() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New opportunity
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-labelledby="trade-new-opportunity-title"
          className="overflow-y-auto p-6 sm:max-w-lg"
          mobileFullscreen
        >
          <SheetHeader>
            <SheetTitle id="trade-new-opportunity-title">
              New opportunity
            </SheetTitle>
            <SheetDescription>
              Someone asked for a price. Track it from here to a signed quote.
            </SheetDescription>
          </SheetHeader>
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const due = form.get("due_date");
              setError(null);
              startTransition(async () => {
                const result = await createTradeOpportunityAction({
                  name: form.get("name"),
                  customer_name: form.get("customer_name"),
                  customer_company: form.get("customer_company"),
                  customer_email: form.get("customer_email"),
                  customer_phone: form.get("customer_phone"),
                  address: form.get("address"),
                  scope: form.get("scope"),
                  source: form.get("source"),
                  due_at:
                    typeof due === "string" && due
                      ? new Date(`${due}T17:00`).toISOString()
                      : null,
                });
                if (!result.success) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.push(`/pipeline/${result.data.id}`);
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="opp-name">Job name</Label>
              <Input
                id="opp-name"
                name="name"
                required
                maxLength={200}
                placeholder="Oak Street — electrical installation"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="opp-customer">Customer name</Label>
                <Input
                  id="opp-customer"
                  name="customer_name"
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="opp-company">Company</Label>
                <Input
                  id="opp-company"
                  name="customer_company"
                  maxLength={200}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="opp-email">Email</Label>
                <Input id="opp-email" name="customer_email" type="email" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="opp-phone">Phone</Label>
                <Input
                  id="opp-phone"
                  name="customer_phone"
                  type="tel"
                  maxLength={40}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="opp-address">Job address</Label>
              <Input id="opp-address" name="address" maxLength={500} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="opp-due">Price due</Label>
                <Input id="opp-due" name="due_date" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="opp-source">Came in by</Label>
                <select
                  id="opp-source"
                  name="source"
                  defaultValue="phone"
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  {OPPORTUNITY_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {OPPORTUNITY_SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="opp-scope">Scope</Label>
              <Textarea
                id="opp-scope"
                name="scope"
                maxLength={4000}
                placeholder="What they asked you to price"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create opportunity"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Invitations({
  invitations,
}: {
  invitations: TradeOpportunityList["invitations"];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = invitations.slice(0, INVITATION_CAP);
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold">
        {invitations.length} bid{" "}
        {invitations.length === 1 ? "invitation" : "invitations"} not on your
        list yet
      </h2>
      <div className="divide-y border-y">
        {shown.map((invitation) => (
          <div
            key={invitation.id}
            className="flex items-center justify-between gap-4 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {invitation.builder} · {invitation.project}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {invitation.dueAt
                  ? `Bids due ${formatLocalDate(invitation.dueAt, "MMM d")}`
                  : "No due date"}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setTrackingId(invitation.id);
                startTransition(async () => {
                  const result = await trackBuilderInvitationAction(
                    invitation.id,
                  );
                  if (!result.success) {
                    setError(result.error);
                    setTrackingId(null);
                    return;
                  }
                  router.push(`/pipeline/${result.data.id}`);
                });
              }}
            >
              {pending && trackingId === invitation.id ? "Tracking…" : "Track"}
            </Button>
          </div>
        ))}
      </div>
      {invitations.length > shown.length && (
        <p className="mt-2 text-xs text-muted-foreground">
          and {invitations.length - shown.length} more
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function TradePipeline({ data }: { data: TradeOpportunityList }) {
  const [stage, setStage] = useState<QuoteStage | null>(null);
  const rows = stage
    ? data.opportunities.filter((row) => row.move.stage === stage)
    : data.opportunities;
  const empty = data.opportunities.length === 0 && data.invitations.length === 0;

  if (empty) {
    return (
      <div className="space-y-9">
        <section className="max-w-xl space-y-3 py-8">
          <h2 className="text-base font-semibold">Nothing out for a price</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Add an opportunity when someone asks you for a price. You will see
            what is out, what came back, and what needs a follow-up here.
            Bid invitations that builders share with your email appear here
            too.{" "}
            <Link href="/trade/connections" className="underline">
              Builder connections
            </Link>
          </p>
          {data.canWrite && <NewOpportunity />}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-9">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          What is out for a price and what came back.
        </p>
        {data.canWrite && <NewOpportunity />}
      </div>

      <div className="grid grid-cols-2 border-y sm:grid-cols-5 sm:divide-x">
        {QUOTE_STAGES.map((entry) => {
          const cell = data.funnel[entry.key];
          const selected = stage === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setStage(selected ? null : entry.key)}
              className={cn(
                "px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                selected && "bg-muted",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {entry.label}
                </span>
                <span
                  className={cn(
                    "text-lg font-semibold tabular-nums",
                    entry.key === "won" && cell.count > 0 && "text-success",
                  )}
                >
                  {cell.count}
                </span>
              </span>
              <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                {formatMoneyCents(cell.valueCents)}
              </span>
            </button>
          );
        })}
      </div>

      {data.invitations.length > 0 && (
        <Invitations invitations={data.invitations} />
      )}

      <section>
        {rows.length ? (
          <div className="overflow-x-auto border-y">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Opportunity</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Next</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/30">
                    <td className="max-w-72 px-3 py-2.5">
                      <Link
                        href={`/pipeline/${row.id}`}
                        className="flex items-center gap-2 font-medium hover:underline"
                      >
                        <span className="truncate">{row.name}</span>
                        {row.fromInvitation && (
                          <span className="shrink-0 border px-1.5 text-[11px] font-normal text-muted-foreground">
                            Invitation
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5 text-muted-foreground">
                      {row.customer || "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          "inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium",
                          row.move.stage === "won" && "text-success",
                          row.move.stage === "lost" &&
                            "text-muted-foreground",
                        )}
                      >
                        {row.move.label}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5",
                        row.move.tone === "late" && "text-destructive",
                        row.move.tone === "soon" && "text-warning",
                        row.move.tone === "none" && "text-muted-foreground",
                      )}
                    >
                      {row.move.sentence}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                      {row.dueAt ? formatLocalDate(row.dueAt, "MMM d") : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      {row.move.valueCents > 0
                        ? formatMoneyCents(row.move.valueCents)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing at this stage.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => setStage(null)}
            >
              Show all
            </button>
          </p>
        )}
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {data.openTotal > data.openCap && (
            <p>
              Showing the first {data.openCap} of {data.openTotal} open
              opportunities, by due date.
            </p>
          )}
          <p>
            Won and lost in the last {data.closedDays} days
            {data.closedTotal > data.closedCap
              ? `. Showing the latest ${data.closedCap} of ${data.closedTotal}.`
              : "."}
          </p>
        </div>
      </section>
    </div>
  );
}
