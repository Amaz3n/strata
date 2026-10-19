"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Check, MapPin, Plus, Search, Send, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { liveBids, suggestedBidders, suggestedSheetIds, type BidTrade } from "@/lib/precon/deal-bids";
import { money } from "@/lib/precon/format";
import { requestScopeChanged, rowPricing } from "@/lib/precon/pricing-worksheet";
import type { DealBidRequest, DealBidder, DealBidsData } from "@/lib/services/precon-deals";
import { DISCIPLINE_LABELS, drawingDisciplineSchema } from "@/lib/validation/drawings";
import { cn } from "@/lib/utils";
import { useDealRoom } from "./deal-room";
import type { BidActions } from "./use-bid-actions";

type Extra = { item_type: "alternate" | "unit_price"; description: string; details: string; quantity: number | null; unit: string | null };

type ScopeDraft = {
  title: string;
  dueDate: string;
  walk: string;
  instructions: string;
  extras: Extra[];
  sheetIds: string[];
  fileIds: string[];
  invite: string[];
  emails: string[];
};

const KIND_LABEL = { base: "Base", allowance: "Allowance", alternate: "Alternate", unit_price: "Unit price" } as const;
const KIND_TONE = { base: "text-muted-foreground", allowance: "text-muted-foreground", alternate: "text-chart-2", unit_price: "text-primary" } as const;

const toDay = (iso: string | null | undefined) => (iso ? format(new Date(iso), "yyyy-MM-dd") : "");
const toLocalTime = (iso: string | null | undefined) => (iso ? format(new Date(iso), "yyyy-MM-dd'T'HH:mm") : "");
// Bids are due at the end of the working day the builder picks, in their time zone.
const dueIso = (day: string) => (day ? new Date(`${day}T17:00`).toISOString() : null);

function draftFrom(trade: BidTrade, request: DealBidRequest | null, data: DealBidsData, now: Date): ScopeDraft {
  if (request)
    return {
      title: request.pkg.title,
      dueDate: toDay(request.pkg.due_at),
      walk: toLocalTime(request.terms.site_walk_at),
      instructions: request.pkg.instructions ?? "",
      extras: [],
      sheetIds: request.terms.sheet_ids,
      fileIds: request.fileIds,
      invite: [],
      emails: [],
    };
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  return {
    title: trade.name,
    dueDate: format(week, "yyyy-MM-dd"),
    walk: "",
    instructions: "",
    extras: [],
    sheetIds: suggestedSheetIds(data.sheets, trade.name),
    fileIds: [],
    invite: [],
    emails: [],
  };
}

/** A draft survives switching trades within the session; it is the viewer's own and never shared. */
function useScopeDraft(key: string, initial: ScopeDraft) {
  const storage = `deal-bid-draft:${key}`;
  const [draft, setDraft] = useState<ScopeDraft>(() => {
    try {
      const saved = sessionStorage.getItem(storage);
      return saved ? { ...initial, ...JSON.parse(saved) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storage, JSON.stringify(draft));
    } catch {
      // Private windows refuse storage; the draft then lives until the trade is switched.
    }
  }, [storage, draft]);
  const clear = () => {
    try {
      sessionStorage.removeItem(storage);
    } catch {
      // Nothing was stored.
    }
  };
  return [draft, setDraft, clear] as const;
}

/**
 * What a trade is asked to price, and who it goes to. Lines come from Pricing;
 * the request adds what bidders need to price them the same way: the sheets,
 * notes, other documents, alternates and a site walk.
 */
export function DealBidScope({ trade, request, data, actions }: { trade: BidTrade; request: DealBidRequest | null; data: DealBidsData; actions: BidActions }) {
  const room = useDealRoom();
  const now = new Date(room.now);
  const sent = !!request && request.pkg.status !== "draft" && request.invites.length > 0;
  const initial = useMemo(() => draftFrom(trade, request, data, now), [trade, request, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft, clearDraft] = useScopeDraft(`${room.deal.id}:${trade.key}:${request?.pkg.updated_at ?? ""}`, initial);
  const patch = (change: Partial<ScopeDraft>) => setDraft((current) => ({ ...current, ...change }));
  const editable = room.editable && !actions.pending;
  const closed = !!request && ["closed", "awarded", "cancelled"].includes(request.pkg.status);
  const changed =
    sent &&
    JSON.stringify([draft.title, draft.dueDate, draft.walk, draft.instructions, [...draft.sheetIds].sort(), [...draft.fileIds].sort()]) !==
      JSON.stringify([initial.title, initial.dueDate, initial.walk, initial.instructions, [...initial.sheetIds].sort(), [...initial.fileIds].sort()]);

  const terms = data.termsAvailable
    ? { site_walk_at: draft.walk ? new Date(draft.walk).toISOString() : null, sheet_ids: draft.sheetIds }
    : null;
  const details = {
    title: draft.title.trim() || trade.name,
    due_at: dueIso(draft.dueDate),
    due_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    instructions: draft.instructions,
    file_ids: draft.fileIds,
    ...(terms ? { terms } : {}),
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-6">
        {sent && !closed && (
          <p className="flex items-start gap-2 border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
            <span>
              This went to {request.invites.length} bidder{request.invites.length === 1 ? "" : "s"}. Changes here go out as an addendum; a change to the
              notes asks each bidder to revise their price.
            </span>
          </p>
        )}
        <ScopeLines trade={trade} request={request} draft={draft} patch={patch} editable={editable && !sent && !request} actions={actions} />
        <Block title="Plans" hint={data.sheets.length ? `${draft.sheetIds.length} of ${data.sheets.length} sheets · bidders see only these` : undefined}>
          <SheetPicker data={data} selected={draft.sheetIds} disabled={!editable || closed} onChange={(sheetIds) => patch({ sheetIds })} />
        </Block>
        <div className={cn("grid gap-6", data.documents.length > 0 && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
          <Block title="Notes to bidders" hint="Every bidder reads these first">
            <Textarea
              aria-label="Notes to bidders"
              disabled={!editable || closed}
              value={draft.instructions}
              onChange={(event) => patch({ instructions: event.target.value })}
              placeholder="Site access, working hours, schedule, how you want it broken out, what you supply…"
              className="min-h-36 text-[13px] leading-relaxed"
            />
          </Block>
          {data.documents.length > 0 && (
            <Block title="Other documents" hint={`${draft.fileIds.length} of ${data.documents.length} attached`}>
              <ul className="max-h-36 divide-y overflow-y-auto border">
                {data.documents.map((file) => {
                  const on = draft.fileIds.includes(file.id);
                  return (
                    <li key={file.id}>
                      <button
                        type="button"
                        disabled={!editable || closed}
                        aria-pressed={on}
                        onClick={() => patch({ fileIds: on ? draft.fileIds.filter((id) => id !== file.id) : [...draft.fileIds, file.id] })}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors duration-150 hover:bg-muted/50 disabled:cursor-default",
                          on && "bg-primary/[0.05] hover:bg-primary/[0.08]",
                        )}
                      >
                        <span className={cn("grid size-3.5 shrink-0 place-items-center border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
                          {on && <Check className="size-2.5" />}
                        </span>
                        <span className={cn("min-w-0 truncate", on ? "font-medium text-foreground" : "text-muted-foreground")}>{file.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Block>
          )}
        </div>
      </div>

      <aside aria-label="Send" className="xl:sticky xl:top-4 xl:self-start">
        <div className="divide-y border bg-background">
          {sent ? (
            <SentCard request={request} draft={draft} patch={patch} termsAvailable={data.termsAvailable} editable={editable && !closed} changed={changed} onSave={() => actions.saveDetails(request.pkg.id, details, true)} />
          ) : (
            <SendCard
              trade={trade}
              data={data}
              draft={draft}
              patch={patch}
              editable={editable}
              lines={request ? request.scope.length : trade.rowIds.length + draft.extras.length}
              onSend={(invites) =>
                actions.issue(
                  {
                    package_id: request?.pkg.id ?? null,
                    trade: trade.name,
                    cost_code_id: trade.costCodeId,
                    row_ids: trade.rowIds,
                    extra_items: draft.extras,
                    invites,
                    ...details,
                    terms,
                  },
                  clearDraft,
                )
              }
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
        {hint && <span className="text-xs tabular-nums text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function ScopeLines({
  trade,
  request,
  draft,
  patch,
  editable,
  actions,
}: {
  trade: BidTrade;
  request: DealBidRequest | null;
  draft: ScopeDraft;
  patch: (change: Partial<ScopeDraft>) => void;
  editable: boolean;
  actions: BidActions;
}) {
  const room = useDealRoom();
  const worksheet = room.state.worksheet;
  const [adding, setAdding] = useState<{ kind: Extra["item_type"]; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const linked = request ? worksheet.requests.find((item) => item.package_id === request.pkg.id) : undefined;
  const drifted = !!linked && request?.pkg.status !== "draft" && requestScopeChanged(linked, worksheet.rows);
  const setNotes = (rowId: string, notes: string) =>
    room.state.setWorksheet((current) => ({ ...current, rows: current.rows.map((row) => (row.id === rowId ? { ...row, notes } : row)) }));

  type Line = { id: string; kind: keyof typeof KIND_LABEL; name: string; details: string; qty: string; budget: number | null; rowId: string | null };
  const qty = (quantity: number | null | undefined, unit: string | null | undefined) =>
    !unit || unit === "ls" ? "Lump sum" : `${(quantity ?? 0).toLocaleString("en-US")} ${unit.toUpperCase()}`;
  const lines: Line[] = request
    ? request.scope.map((item) => ({
        id: item.id,
        kind: item.item_type,
        name: item.description,
        details: item.details ?? "",
        qty: item.item_type === "unit_price" ? `per ${item.unit?.toUpperCase() || "EA"}` : qty(item.quantity, item.unit),
        budget: item.budget_cents ?? null,
        rowId: null,
      }))
    : [
        ...trade.rowIds.flatMap((id) => {
          const row = worksheet.rows.find((item) => item.id === id);
          return row
            ? [{ id, kind: "base" as const, name: row.description, details: row.notes, qty: qty(row.quantity, row.unit), budget: rowPricing(row, { ...worksheet, requests: [] }).cost, rowId: id }]
            : [];
        }),
        ...draft.extras.map((extra, index) => ({
          id: `extra-${index}`,
          kind: extra.item_type,
          name: extra.description,
          details: extra.details,
          qty: extra.item_type === "unit_price" ? `per ${extra.unit?.toUpperCase() || "EA"}` : "Lump sum",
          budget: null,
          rowId: null,
        })),
      ];

  return (
    <Block title="Scope lines" hint="Bidders price each line, or say they exclude it">
      {drifted && (
        <form
          className="grid gap-2 border border-warning/30 bg-warning/5 p-3 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            if (request && reason.trim()) actions.revise(request.pkg.id, reason.trim());
          }}
        >
          <span className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-3.5 text-warning" />
            These lines changed on Pricing after the request went out. Bidders are still pricing the old ones.
          </span>
          <div className="flex gap-2">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What changed, in a sentence for the bidders" className="h-8 text-xs" />
            <Button size="sm" className="h-8" disabled={!room.editable || actions.pending || !reason.trim()}>
              Send revision
            </Button>
          </div>
        </form>
      )}
      <div className="divide-y border">
        {lines.map((line, index) => (
          <div key={line.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_7rem_6rem]">
            <span className={cn("pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]", KIND_TONE[line.kind])}>{KIND_LABEL[line.kind]}</span>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium">{line.name}</span>
                {editable && line.id.startsWith("extra-") && (
                  <button
                    type="button"
                    aria-label={`Remove ${line.name}`}
                    onClick={() => patch({ extras: draft.extras.filter((_, i) => i !== index - trade.rowIds.length) })}
                    className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              {editable && line.rowId ? (
                <Textarea
                  aria-label={`What's included in ${line.name}`}
                  value={line.details}
                  onChange={(event) => line.rowId && setNotes(line.rowId, event.target.value)}
                  placeholder="What's included, finishes, quantities…"
                  className="min-h-8 resize-y border-dashed bg-transparent px-2 py-1 text-xs shadow-none"
                  rows={1}
                />
              ) : editable && line.id.startsWith("extra-") ? (
                <Input
                  aria-label={`What's included in ${line.name}`}
                  value={line.details}
                  onChange={(event) =>
                    patch({ extras: draft.extras.map((extra, i) => (i === index - trade.rowIds.length ? { ...extra, details: event.target.value } : extra)) })
                  }
                  placeholder="What's included…"
                  className="h-7 border-dashed bg-transparent px-2 text-xs shadow-none"
                />
              ) : (
                line.details && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{line.details}</p>
              )}
            </div>
            <span className="hidden pt-0.5 text-right text-xs tabular-nums text-muted-foreground sm:block">{line.qty}</span>
            <span className="pt-0.5 text-right text-xs tabular-nums text-muted-foreground" title="Your placeholder. Bidders never see it.">
              {line.budget !== null ? money(line.budget) : "—"}
            </span>
          </div>
        ))}
        {editable &&
          (adding ? (
            <form
              className="flex flex-wrap items-center gap-2 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                const name = adding.name.trim();
                if (!name) return;
                const alternates = draft.extras.filter((extra) => extra.item_type === "alternate").length;
                patch({
                  extras: [
                    ...draft.extras,
                    {
                      item_type: adding.kind,
                      description: adding.kind === "alternate" ? `Alt ${alternates + 1} · ${name}` : name,
                      details: "",
                      quantity: null,
                      unit: adding.kind === "unit_price" ? "ea" : null,
                    },
                  ],
                });
                setAdding(null);
              }}
            >
              <Input
                autoFocus
                value={adding.name}
                onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                placeholder={adding.kind === "alternate" ? "e.g. Upgrade to smart switches" : "e.g. Additional outlet"}
                className="h-8 min-w-0 flex-1 text-[13px]"
              />
              <Button size="sm" className="h-8">
                Add
              </Button>
              <Button size="sm" variant="ghost" type="button" className="h-8" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding({ kind: "alternate", name: "" })}>
                <Plus className="size-3.5" />
                Alternate
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding({ kind: "unit_price", name: "" })}>
                <Plus className="size-3.5" />
                Unit price
              </Button>
              <span className="ml-auto pr-1 text-xs text-muted-foreground">Base lines come from Pricing</span>
            </div>
          ))}
      </div>
    </Block>
  );
}

function SheetPicker({ data, selected, disabled, onChange }: { data: DealBidsData; selected: string[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const room = useDealRoom();
  const [discipline, setDiscipline] = useState<string>("all");
  if (!data.termsAvailable)
    return <p className="border border-dashed px-3 py-3 text-xs text-muted-foreground">Choosing sheets for a request needs a database update that is waiting for approval.</p>;
  if (!data.sheets.length)
    return (
      <p className="border border-dashed px-3 py-3 text-xs text-muted-foreground">
        No plan sheets yet. Upload the plans on the{" "}
        <a href={room.href("plans")} className="font-medium text-foreground underline-offset-2 hover:underline">
          Plans tab
        </a>{" "}
        and choose the sheets each trade prices from.
      </p>
    );
  const present = drawingDisciplineSchema.options.filter((code) => data.sheets.some((sheet) => sheet.discipline === code));
  const shown = data.sheets.filter((sheet) => discipline === "all" || sheet.discipline === discipline);
  const allShown = shown.every((sheet) => selected.includes(sheet.id));
  return (
    <div className="border">
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
        {["all", ...present].map((code) => (
          <button
            key={code}
            type="button"
            aria-pressed={discipline === code}
            onClick={() => setDiscipline(code)}
            className={cn(
              "h-6 px-2 text-xs font-medium text-primary transition-colors duration-150 hover:bg-primary/10",
              discipline === code && "bg-primary text-primary-foreground hover:bg-primary",
            )}
          >
            {code === "all" ? "All" : DISCIPLINE_LABELS[code as keyof typeof DISCIPLINE_LABELS]}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange(allShown ? selected.filter((id) => !shown.some((sheet) => sheet.id === id)) : [...new Set([...selected, ...shown.map((sheet) => sheet.id)])])
          }
          className="ml-auto h-6 px-2 text-xs font-medium text-primary transition-colors duration-150 hover:text-primary/80 disabled:opacity-60"
        >
          {allShown ? "Clear these" : "Select these"}
        </button>
      </div>
      <div className="grid max-h-96 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-px overflow-y-auto bg-border">
        {shown.map((sheet) => {
          const on = selected.includes(sheet.id);
          return (
            <button
              key={sheet.id}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((id) => id !== sheet.id) : [...selected, sheet.id])}
              className={cn(
                "flex min-w-0 items-center gap-2 bg-card px-2.5 py-2 text-left transition-colors duration-150 hover:bg-muted/50 disabled:cursor-default",
                on && "bg-primary/[0.05] hover:bg-primary/[0.08]",
              )}
            >
              <span className={cn("grid size-3.5 shrink-0 place-items-center border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
                {on && <Check className="size-2.5" />}
              </span>
              <span className="w-14 shrink-0 font-mono text-[11.5px] font-semibold">{sheet.number}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{sheet.title ?? "Untitled"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SendCard({
  trade,
  data,
  draft,
  patch,
  editable,
  lines,
  onSend,
}: {
  trade: BidTrade;
  data: DealBidsData;
  draft: ScopeDraft;
  patch: (change: Partial<ScopeDraft>) => void;
  editable: boolean;
  lines: number;
  onSend: (invites: { company_id?: string; contact_id?: string; invite_email?: string }[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const suggested = suggestedBidders(data.bidders, trade.name);
  const found = query.trim()
    ? data.bidders.filter((bidder) => `${bidder.name} ${bidder.trade ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  const picked = data.bidders.filter((bidder) => draft.invite.includes(bidder.companyId));
  const rows = [...new Map([...picked, ...suggested.slice(0, 8), ...found].map((bidder) => [bidder.companyId, bidder])).values()];
  const total = draft.invite.length + draft.emails.length;
  const toggle = (bidder: DealBidder) =>
    patch({ invite: draft.invite.includes(bidder.companyId) ? draft.invite.filter((id) => id !== bidder.companyId) : [...draft.invite, bidder.companyId] });

  return (
    <>
      <div className="grid gap-3 p-4">
        <DateField label="Bids due" value={draft.dueDate} onChange={(dueDate) => patch({ dueDate })} disabled={!editable} />
        {data.termsAvailable && <SiteWalkField value={draft.walk} disabled={!editable} onChange={(walk) => patch({ walk })} />}
      </div>
      <div className="grid gap-2 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Send to</span>
          <span className="text-xs tabular-nums text-muted-foreground">{total} picked</span>
        </div>
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your directory" aria-label="Search bidders" className="h-8 pl-7 text-[13px]" />
        </label>
        <ul className="grid">
          {rows.map((bidder) => {
            const on = draft.invite.includes(bidder.companyId);
            return (
              <li key={bidder.companyId}>
                <button
                  type="button"
                  disabled={!editable}
                  aria-pressed={on}
                  onClick={() => toggle(bidder)}
                  className="grid w-full grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 px-1 py-1.5 text-left transition-colors duration-150 hover:bg-muted/50"
                >
                  <span className={cn("mt-0.5 grid size-3.5 place-items-center border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
                    {on && <Check className="size-2.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{bidder.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[bidder.trade, bidder.invited ? `answered ${bidder.answered} of ${bidder.invited}` : "first bid with you"].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {draft.emails.map((address) => (
            <li key={address} className="flex items-center gap-2 px-1 py-1.5 text-[13px]">
              <Check className="size-3.5 text-primary" />
              <span className="min-w-0 flex-1 truncate">{address}</span>
              <button type="button" aria-label={`Remove ${address}`} onClick={() => patch({ emails: draft.emails.filter((item) => item !== address) })} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          {!rows.length && !draft.emails.length && (
            <li className="px-1 py-1.5 text-xs text-muted-foreground">No {trade.name.toLowerCase()} trades in your directory yet. Search, or add one by email.</li>
          )}
        </ul>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const address = email.trim().toLowerCase();
            if (!/^\S+@\S+\.\S+$/.test(address) || draft.emails.includes(address)) return;
            patch({ emails: [...draft.emails, address] });
            setEmail("");
          }}
        >
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Add by email" aria-label="Add a bidder by email" className="h-8 text-[13px]" />
          <Button size="sm" variant="outline" className="h-8" disabled={!editable || !email.trim()}>
            Add
          </Button>
        </form>
      </div>
      <div className="grid gap-3 p-4">
        <p className="text-xs text-muted-foreground">
          Each bidder gets a private bid page with the <b className="text-foreground">{lines} line{lines === 1 ? "" : "s"}</b>
          {draft.sheetIds.length ? (
            <>
              , <b className="text-foreground">{draft.sheetIds.length} sheets</b>
            </>
          ) : null}
          {draft.fileIds.length ? (
            <>
              , <b className="text-foreground">{draft.fileIds.length} files</b>
            </>
          ) : null}
          , your notes and the due date. They price it there or upload their own proposal.
        </p>
        <Button
          disabled={!editable || !total || !draft.dueDate}
          onClick={() =>
            onSend([
              ...picked.map((bidder) => ({ company_id: bidder.companyId, contact_id: bidder.contactId ?? undefined, invite_email: bidder.email })),
              ...draft.emails.map((address) => ({ invite_email: address })),
            ])
          }
        >
          <Send className="size-3.5" />
          {total ? `Send to ${total} bidder${total === 1 ? "" : "s"}` : "Pick bidders"}
        </Button>
      </div>
    </>
  );
}

function SentCard({
  request,
  draft,
  patch,
  termsAvailable,
  editable,
  changed,
  onSave,
}: {
  request: DealBidRequest;
  draft: ScopeDraft;
  patch: (change: Partial<ScopeDraft>) => void;
  termsAvailable: boolean;
  editable: boolean;
  changed: boolean;
  onSave: () => void;
}) {
  const room = useDealRoom();
  const bids = liveBids(request.submissions, request.pkg.scope_revision, new Date(room.now).toISOString().slice(0, 10)).length;
  return (
    <>
      <div className="grid gap-1 p-4 text-xs">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Out to bidders</span>
        <span className="text-[13px]">
          <b className="tabular-nums">{request.invites.length}</b> invited · <b className="tabular-nums">{bids}</b> bid{bids === 1 ? "" : "s"} in
        </span>
        {request.terms.site_walk_at && (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-3" />
            Site walk {new Date(request.terms.site_walk_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div className="grid gap-3 p-4">
        <DateField label="Bids due" value={draft.dueDate} onChange={(dueDate) => patch({ dueDate })} disabled={!editable} />
        {termsAvailable && <SiteWalkField value={draft.walk} disabled={!editable} onChange={(walk) => patch({ walk })} />}
        <Button variant={changed ? "default" : "outline"} disabled={!editable || !changed} onClick={onSave}>
          <Send className="size-3.5" />
          Send changes as an addendum
        </Button>
      </div>
    </>
  );
}

const WALK_TIMES = Array.from({ length: 25 }, (_, index) => {
  const minutes = 6 * 60 + index * 30;
  const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { value, label: format(new Date(`2000-01-01T${value}`), "h:mm a") };
});

/** Optional, so it starts empty: nothing is scheduled until a day is picked, and removing it clears both. */
function SiteWalkField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (walk: string) => void }) {
  const [open, setOpen] = useState(!!value);
  const day = value.slice(0, 10);
  const time = value.slice(11, 16) || "09:00";
  if (!open && !value)
    return (
      <Button variant="ghost" size="sm" className="h-8 justify-start px-1.5 text-xs text-primary hover:text-primary" disabled={disabled} onClick={() => setOpen(true)}>
        <MapPin className="size-3.5" />
        Add a site walk
      </Button>
    );
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>Site walk</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
          className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-60"
        >
          <X className="size-3" />
          No site walk
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-1.5">
        <DateField value={day} placeholder="Pick a day" disabled={disabled} onChange={(next) => onChange(next ? `${next}T${time}` : "")} />
        <Select value={time} disabled={disabled || !day} onValueChange={(next) => onChange(`${day}T${next}`)}>
          <SelectTrigger aria-label="Site walk time" className="h-9 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WALK_TIMES.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** Lines marked for bids without a cost code: Arc can't tell which trade prices them until you say. */
export function DealBidUnassigned({ trade, costCodes }: { trade: BidTrade; costCodes: DealBidsData["costCodes"] }) {
  const room = useDealRoom();
  const rows = room.state.worksheet.rows.filter((row) => trade.rowIds.includes(row.id));
  return (
    <div className="grid gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Not grouped yet</h2>
        <p className="text-xs text-muted-foreground">
          {rows.length} line{rows.length === 1 ? "" : "s"} without a cost code, so Arc can&apos;t tell which trade prices {rows.length === 1 ? "it" : "them"}.
          Choose one and the line joins that trade.
        </p>
      </div>
      <div className="divide-y border">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.description}</span>
            <Select
              disabled={!room.editable}
              onValueChange={(costCodeId) =>
                room.state.setWorksheet((current) => ({
                  ...current,
                  rows: current.rows.map((item) => (item.id === row.id ? { ...item, cost_code_id: costCodeId } : item)),
                }))
              }
            >
              <SelectTrigger aria-label={`Trade for ${row.description}`} className="h-8 w-56 text-xs">
                <SelectValue placeholder="Choose a trade…" />
              </SelectTrigger>
              <SelectContent>
                {costCodes.map((code) => (
                  <SelectItem key={code.id} value={code.id} className="text-xs">
                    {code.code} · {code.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </div>
  );
}
