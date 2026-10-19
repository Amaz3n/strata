"use client";

import { useState } from "react";
import { AlertTriangle, Check, EyeOff, FileText, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { BidPricingPanel } from "@/components/bids/bid-pricing-panel";
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param";
import { bidSpread, levelBid, liveBids, type LevelCell } from "@/lib/precon/deal-bids";
import { money } from "@/lib/precon/format";
import type { BidScopeItem, BidSubmission } from "@/lib/services/bids";
import type { DealBidRequest } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";
import { placeholderCents } from "./deal-bids";
import { useDealRoom } from "./deal-room";
import type { BidActions } from "./use-bid-actions";

const toCents = (text: string) => {
  const value = Number(text.replace(/[$,\s]/g, ""));
  return text.trim() && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

const bidderName = (bid: BidSubmission) => bid.invite?.company?.name ?? bid.submitted_by_name ?? "Bidder";
const days = (value: number | null | undefined) => (value == null ? "—" : value % 7 === 0 && value ? `${value / 7} wk` : `${value} days`);

/** Seven days or fewer left on a price is worth saying out loud. */
function expiresSoon(validUntil: string | null | undefined, today: string) {
  if (!validUntil) return false;
  const left = (Date.parse(validUntil.slice(0, 10)) - Date.parse(today)) / 86_400_000;
  return left <= 7;
}

/**
 * Every bid against the same lines. Bidders price your lines on their bid
 * page, so the grid lines up by itself; where they excluded a line your plug
 * fills it, so every column covers the same scope. Their exclusions stay in
 * their words, because no two subs write them the same way.
 */
export function DealBidLeveling({ request, actions }: { request: DealBidRequest; actions: BidActions }) {
  const room = useDealRoom();
  const today = new Date(room.now).toISOString().slice(0, 10);
  const linked = room.state.worksheet.requests.find((item) => item.package_id === request.pkg.id);
  const [alternates, setAlternates] = useState<string[]>(linked?.quote?.accepted_alternate_ids ?? []);
  const [hidden, setHidden] = useState<string[]>([]);
  const [docId, setDoc] = useWorkspaceParam("bid");
  const live = liveBids(request.submissions, request.pkg.scope_revision, today);
  const editable = room.editable && !actions.pending;

  if (!live.length)
    return (
      <div className="grid justify-items-center gap-1 border border-dashed px-6 py-10 text-center">
        <p className="text-sm font-medium">No bids to level yet</p>
        <p className="max-w-sm text-xs text-muted-foreground">Bids land here line by line as bidders submit them, or when you enter one from Bidders.</p>
      </div>
    );

  const leveled = new Map(live.map((bid) => [bid.id, levelBid(bid, request.scope, alternates)]));
  const total = (bid: BidSubmission) => leveled.get(bid.id)?.leveled ?? 0;
  const shown = live.filter((bid) => !hidden.includes(bid.id)).sort((a, b) => total(a) - total(b));
  const spread = bidSpread(live.map(total));
  const best = shown.length ? Math.min(...shown.map(total)) : null;
  const held = placeholderCents(room.state.worksheet, linked?.row_ids ?? []) ?? request.scope.reduce((sum, item) => sum + (item.item_type === "unit_price" ? 0 : (item.budget_cents ?? 0)), 0);
  const groups: [string, BidScopeItem[]][] = [
    ["Base bid", request.scope.filter((item) => item.item_type === "base" || item.item_type === "allowance")],
    ["Alternates · tick to include", request.scope.filter((item) => item.item_type === "alternate")],
    ["Unit prices", request.scope.filter((item) => item.item_type === "unit_price")],
  ];
  const open = live.find((bid) => bid.id === docId) ?? null;
  const stale = request.submissions.filter((bid) => bid.is_current && !live.includes(bid)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {spread && (
          <span className="tabular-nums">
            Low <b className="text-foreground">{money(spread.low)}</b> · Median <b className="text-foreground">{money(spread.median)}</b> · High{" "}
            <b className="text-foreground">{money(spread.high)}</b> · your placeholder <b className="text-foreground">{money(held)}</b>
          </span>
        )}
        {hidden.length > 0 && (
          <span>
            {hidden.length} hidden{" "}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setHidden([])}>
              Show all
            </button>
          </span>
        )}
        {stale > 0 && <span className="text-age-2">{stale} bid{stale === 1 ? "" : "s"} priced old scope or expired; ask for a revision from Bidders.</span>}
      </div>

      <div className={cn("grid gap-4", open && "2xl:grid-cols-[minmax(0,1fr)_26rem]")}>
        <div className="overflow-x-auto border">
          <table className="w-max min-w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b bg-muted/40 align-bottom">
                <th className="sticky left-0 z-10 w-64 min-w-64 bg-muted px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Scope
                </th>
                <th className="w-28 border-l px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Yours</th>
                {shown.map((bid) => {
                  const sum = total(bid);
                  const chosen = linked?.quote?.submission_id === bid.id;
                  return (
                    <th key={bid.id} className={cn("w-44 min-w-44 border-l px-3 py-2 text-left align-bottom font-normal", docId === bid.id && "bg-primary/[0.06]")}>
                      <div className="flex items-start gap-1">
                        <button
                          type="button"
                          onClick={() => setDoc(docId === bid.id ? null : bid.id)}
                          title="Open their proposal"
                          className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold hover:text-primary hover:underline"
                        >
                          {bidderName(bid)}
                        </button>
                        <button
                          type="button"
                          aria-label={`Hide ${bidderName(bid)}`}
                          title="Hide from the comparison"
                          onClick={() => setHidden((current) => [...current, bid.id])}
                          className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
                        >
                          <EyeOff className="size-3.5" />
                        </button>
                      </div>
                      <span className="block text-[11px] text-muted-foreground">
                        {bid.version > 1 ? `v${bid.version} · ` : ""}
                        {leveled.get(bid.id)?.lump ? "Lump sum" : bid.source === "manual" ? "Entered by you" : "Priced by line"}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {chosen && <Tag tone="success">Chosen</Tag>}
                        {!chosen && sum === best && shown.length > 1 && <Tag tone="success">Lowest leveled</Tag>}
                        {spread?.isOutlier(sum) && <Tag tone="warning">Far below the rest</Tag>}
                        {bid.invite?.compliance_warning && <Tag tone="warning">{bid.invite.compliance_warning}</Tag>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {groups.map(([title, items]) =>
                items.length ? (
                  <Group key={title} title={title} columns={shown.length}>
                    {items.map((item) => {
                      const on = alternates.includes(item.id);
                      return (
                        <tr key={item.id} className="border-b">
                          <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                            {item.item_type === "alternate" ? (
                              <button
                                type="button"
                                aria-pressed={on}
                                onClick={() => setAlternates((current) => (on ? current.filter((id) => id !== item.id) : [...current, item.id]))}
                                className="flex items-center gap-2 text-left"
                              >
                                <span className={cn("grid size-3.5 shrink-0 place-items-center border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
                                  {on && <Check className="size-2.5" />}
                                </span>
                                {item.description}
                              </button>
                            ) : (
                              <>
                                {item.description}
                                {item.item_type === "unit_price" && <span className="ml-1 font-normal text-muted-foreground">per {item.unit?.toUpperCase() || "EA"}</span>}
                              </>
                            )}
                          </th>
                          <td className="border-l px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {item.budget_cents != null ? money(item.budget_cents) : "—"}
                          </td>
                          {shown.map((bid) => (
                            <Cell
                              key={bid.id}
                              cell={leveled.get(bid.id)?.cells[item.id]}
                              editable={editable && item.item_type !== "unit_price"}
                              onPlug={(itemId, cents) => actions.plug(request.pkg.id, itemId, cents)}
                              label={`${item.description} on ${bidderName(bid)}`}
                            />
                          ))}
                        </tr>
                      );
                    })}
                  </Group>
                ) : null,
              )}
              <tr className="border-b border-t-2 border-t-border">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-semibold">Their total</th>
                <td className="border-l" />
                {shown.map((bid) => (
                  <td key={bid.id} className="border-l px-3 py-2 text-right font-mono tabular-nums">
                    {money(leveled.get(bid.id)?.asBid ?? 0)}
                  </td>
                ))}
              </tr>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">Your plugs for gaps</th>
                <td className="border-l" />
                {shown.map((bid) => {
                  const plugs = leveled.get(bid.id)?.plugs ?? 0;
                  return (
                    <td key={bid.id} className={cn("border-l px-3 py-2 text-right font-mono tabular-nums", plugs ? "text-warning" : "text-muted-foreground")}>
                      {plugs ? `+${money(plugs)}` : "—"}
                    </td>
                  );
                })}
              </tr>
              <tr className="border-b bg-muted/30">
                <th className="sticky left-0 z-10 bg-muted px-3 py-2.5 text-left font-semibold">Leveled</th>
                <td className="border-l px-3 py-2.5 text-right font-mono font-semibold tabular-nums">{money(held)}</td>
                {shown.map((bid) => (
                  <td key={bid.id} className={cn("border-l px-3 py-2.5 text-right font-mono text-sm font-semibold tabular-nums", total(bid) === best && "text-success")}>
                    {money(total(bid))}
                  </td>
                ))}
              </tr>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">vs. your placeholder</th>
                <td className="border-l" />
                {shown.map((bid) => {
                  const delta = total(bid) - held;
                  return (
                    <td key={bid.id} className={cn("border-l px-3 py-2 text-right font-mono tabular-nums", delta > 0 ? "text-destructive" : "text-success")}>
                      {delta > 0 ? "+" : "−"}
                      {money(Math.abs(delta))}
                    </td>
                  );
                })}
              </tr>
              <tr className="border-b align-top">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                  Their exclusions + notes
                  <span className="block text-[11px] font-normal text-muted-foreground">In their words. Open a proposal to read it all.</span>
                </th>
                <td className="border-l" />
                {shown.map((bid) => (
                  <td key={bid.id} className="border-l px-3 py-2 text-xs text-muted-foreground">
                    <span className="line-clamp-4 whitespace-pre-wrap">{[bid.exclusions, bid.clarifications].filter(Boolean).join("\n") || "None stated"}</span>
                  </td>
                ))}
              </tr>
              <tr className="border-b align-top">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">Lead time · good until</th>
                <td className="border-l" />
                {shown.map((bid) => (
                  <td key={bid.id} className="border-l px-3 py-2 text-xs">
                    {days(bid.lead_time_days)} · {bid.valid_until ? new Date(`${bid.valid_until.slice(0, 10)}T12:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    {expiresSoon(bid.valid_until, today) && <span className="mt-0.5 block font-medium text-warning">Expires within a week</span>}
                  </td>
                ))}
              </tr>
              <tr>
                <th className="sticky left-0 z-10 bg-card px-3 py-2.5" />
                <td className="border-l" />
                {shown.map((bid) => (
                  <td key={bid.id} className="border-l px-3 py-2.5">
                    <Button
                      size="sm"
                      variant={total(bid) === best ? "default" : "outline"}
                      className="h-7 w-full text-xs"
                      disabled={!room.editable}
                      onClick={() => setDoc(bid.id)}
                    >
                      {linked?.quote?.submission_id === bid.id ? "Chosen" : "Use this bid"}
                    </Button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {open && (
          <Proposal
            key={open.id}
            request={request}
            bid={open}
            alternates={alternates}
            leveledTotal={total(open)}
            onClose={() => setDoc(null)}
            actions={actions}
          />
        )}
      </div>
    </div>
  );
}

function Tag({ tone, children }: { tone: "success" | "warning"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-px text-[10.5px] font-semibold",
        tone === "success" ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
      )}
    >
      {tone === "warning" && <AlertTriangle className="size-3" />}
      {children}
    </span>
  );
}

function Group({ title, columns, children }: { title: string; columns: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-b bg-muted/20">
        <th className="sticky left-0 z-10 bg-muted/60 px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</th>
        <td className="border-l" colSpan={columns + 1} />
      </tr>
      {children}
    </>
  );
}

function Cell({ cell, editable, onPlug, label }: { cell: LevelCell | undefined; editable: boolean; onPlug: (itemId: string, cents: number) => void; label: string }) {
  if (!cell) return <td className="border-l px-3 py-2 text-right text-muted-foreground">—</td>;
  if (cell.kind === "in_lump") return <td className="border-l px-3 py-2 text-right text-xs italic text-muted-foreground">In lump sum</td>;
  if (cell.kind === "priced") return <td className="border-l px-3 py-2 text-right font-mono tabular-nums">{money(cell.cents)}</td>;
  const reason = cell.reason === "no_bid" ? "No bid" : cell.reason === "excluded" ? "Excluded" : "Not priced";
  return (
    <td className="border-l bg-warning/[0.04] px-3 py-1.5">
      <span className="flex items-center justify-end gap-2">
        <span className="text-[11px] font-semibold text-warning">{reason}</span>
        {editable && cell.itemId ? (
          <label className="inline-flex h-6 items-center gap-0.5 border border-dashed bg-background px-1.5 focus-within:border-primary" title="Your number for this gap, added to their leveled total">
            <span className="text-[11px] text-muted-foreground">+</span>
            <input
              key={cell.plug}
              aria-label={`Plug for ${label}`}
              defaultValue={(cell.plug / 100).toLocaleString("en-US")}
              onBlur={(event) => {
                const cents = toCents(event.target.value);
                if (cents !== null && cents !== cell.plug && cell.itemId) onPlug(cell.itemId, cents);
              }}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              className="w-16 bg-transparent text-right font-mono text-xs tabular-nums outline-none"
            />
          </label>
        ) : (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">+{money(cell.plug)}</span>
        )}
      </span>
    </td>
  );
}

/** One bidder's proposal beside the grid: the file they sent, the version history, their terms, and the decision. */
function Proposal({
  request,
  bid,
  alternates,
  leveledTotal,
  onClose,
  actions,
}: {
  request: DealBidRequest;
  bid: BidSubmission;
  alternates: string[];
  leveledTotal: number;
  onClose: () => void;
  actions: BidActions;
}) {
  const room = useDealRoom();
  const versions = request.submissions.filter((item) => item.bid_invite_id === bid.bid_invite_id).sort((a, b) => b.version - a.version);
  const [shownId, setShownId] = useState(bid.id);
  const shown = versions.find((item) => item.id === shownId) ?? bid;
  const files = request.proposals[shown.id] ?? [];
  const [fileId, setFileId] = useState(files[0]?.id ?? null);
  const file = files.find((item) => item.id === fileId) ?? files[0];
  // Your plug stands in for each gap unless you change it in the decision.
  const decided: BidSubmission = {
    ...bid,
    items: bid.items?.map((item) => {
      const scope = request.scope.find((line) => line.id === item.bid_scope_item_id);
      return item.response === "priced" ? item : { ...item, gc_plug_cents: item.gc_plug_cents ?? scope?.budget_cents ?? 0 };
    }),
  };
  return (
    <aside aria-label={`${bidderName(bid)}'s proposal`} className="min-w-0 border bg-background">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{bidderName(bid)}</h3>
          <p className="text-xs text-muted-foreground">
            {bid.source === "manual" ? "Entered by you" : "Submitted on their bid page"}
            {bid.submitted_at && ` · ${new Date(bid.submitted_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
          </p>
        </div>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close the proposal" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="grid gap-4 p-4">
        {versions.length > 1 && (
          <div role="radiogroup" aria-label="Versions" className="flex flex-wrap gap-1">
            {versions.map((version) => (
              <button
                key={version.id}
                type="button"
                role="radio"
                aria-checked={version.id === shown.id}
                onClick={() => setShownId(version.id)}
                className={cn(
                  "h-7 border px-2 text-xs tabular-nums text-muted-foreground transition-colors duration-150 hover:text-foreground",
                  version.id === shown.id && "border-foreground/30 bg-muted font-medium text-foreground",
                )}
              >
                v{version.version} · {money(version.total_cents ?? 0)}
              </button>
            ))}
          </div>
        )}
        {file ? (
          <div className="grid gap-1.5">
            {file.mime === "application/pdf" ? (
              <iframe title={file.name} src={`/api/files/${file.id}/raw`} className="h-[26rem] w-full border bg-muted" />
            ) : null}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {files.map((item) => (
                <a
                  key={item.id}
                  href={`/api/files/${item.id}/raw`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (item.mime === "application/pdf" && item.id !== file.id) {
                      event.preventDefault();
                      setFileId(item.id);
                    }
                  }}
                  className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate">{item.name}</span>
                </a>
              ))}
            </div>
          </div>
        ) : (
          <p className="border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No proposal file. {bid.source === "manual" ? "Attach their PDF from the full package page so it is on file." : "They priced it on their bid page."}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Their total</dt>
          <dd className="text-right font-mono tabular-nums">{money(shown.total_cents ?? 0)}</dd>
          <dt className="text-muted-foreground">Leveled</dt>
          <dd className="text-right font-mono font-semibold tabular-nums">{money(leveledTotal)}</dd>
          <dt className="text-muted-foreground">Lead time</dt>
          <dd className="text-right">{days(shown.lead_time_days)}</dd>
          <dt className="text-muted-foreground">Good until</dt>
          <dd className="text-right">{shown.valid_until ? new Date(`${shown.valid_until.slice(0, 10)}T12:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</dd>
        </dl>
        {[
          ["Exclusions, in their words", shown.exclusions],
          ["Clarifications", shown.clarifications],
          ["Notes", shown.notes],
        ].map(([title, text]) =>
          text ? (
            <div key={title} className="grid gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</span>
              <p className="whitespace-pre-wrap bg-muted/50 px-3 py-2 text-xs">{text}</p>
            </div>
          ) : null,
        )}
      </div>
      {shown.id === bid.id && (
        <BidPricingPanel
          actionLabel="Use this bid for pricing"
          bidPackage={request.pkg}
          submission={decided}
          scopeItems={request.scope}
          context={{ projectId: request.pkg.project_id }}
          defaultAlternateIds={alternates}
          disabled={!room.editable || actions.pending}
          onSelect={(input) => actions.choose(request.pkg.id, input)}
        />
      )}
    </aside>
  );
}
