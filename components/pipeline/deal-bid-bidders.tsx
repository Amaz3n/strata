"use client";

import { useState } from "react";
import { Bell, Edit, FileText, Plus, Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bidderStatus, levelBid, liveBids, suggestedBidders } from "@/lib/precon/deal-bids";
import { money } from "@/lib/precon/format";
import type { DealBidRequest, DealBidder } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";
import { useDealRoom } from "./deal-room";
import type { BidActions } from "./use-bid-actions";

const RANK = { in: 0, opened: 1, waiting: 2, declined: 3 } as const;

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

const toCents = (text: string) => {
  const value = Number(text.replace(/[$,\s]/g, ""));
  return text.trim() && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

/** Everyone a request went to, best bid first, then who opened it, who hasn't, and who said no. */
export function DealBidBidders({ request, actions, bidders, onLevel }: { request: DealBidRequest; actions: BidActions; bidders: DealBidder[]; onLevel: () => void }) {
  const room = useDealRoom();
  const today = new Date(room.now).toISOString().slice(0, 10);
  const live = liveBids(request.submissions, request.pkg.scope_revision, today);
  const [entering, setEntering] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const editable = room.editable && !["closed", "awarded", "cancelled"].includes(request.pkg.status);
  const [, openBid] = useWorkspaceParam("bid");

  const rows = request.invites
    .map((invite) => {
      const current = request.submissions.find((bid) => bid.bid_invite_id === invite.id && bid.is_current);
      const bid = live.find((item) => item.bid_invite_id === invite.id) ?? null;
      const status = bidderStatus(invite, !!current);
      return { invite, current, bid, status, leveled: bid ? levelBid(bid, request.scope, []).leveled : null };
    })
    .sort((a, b) => RANK[a.status.key] - RANK[b.status.key] || (a.leveled ?? 0) - (b.leveled ?? 0));
  const waiting = rows.filter((row) => row.status.key === "waiting" || row.status.key === "opened");
  const declined = rows.filter((row) => row.status.key === "declined").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[13px] tabular-nums">
          <b>{live.length}</b> bid{live.length === 1 ? "" : "s"} in · <b>{waiting.length}</b> waiting · <b>{declined}</b> declined
        </p>
        {editable && <EnterBid request={request} bidders={bidders} actions={actions} />}
        {editable && <InviteMore request={request} bidders={bidders} actions={actions} />}
        {editable && waiting.length > 0 && (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={actions.pending} onClick={() => actions.remind(request.pkg.id, waiting.map((row) => row.invite.id))}>
            <Bell className="size-3.5" />
            Remind {waiting.length} waiting
          </Button>
        )}
      </div>
      <div className="overflow-x-auto border">
        <Table className="min-w-[48rem]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {["Bidder", "Status", "Their total", "Leveled", "Proposal", ""].map((label, index) => (
                <TableHead
                  key={index}
                  className={cn("h-9 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground", (index === 2 || index === 3) && "text-right")}
                >
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ invite, current, bid, status, leveled }) => {
              const name = invite.company?.name ?? invite.contact?.full_name ?? invite.invite_email ?? "Bidder";
              const file = current ? request.proposals[current.id]?.[0] : undefined;
              const note =
                status.key === "in"
                  ? current?.source === "manual"
                    ? `Entered by you ${when(current.entered_at ?? current.created_at) ?? ""}`
                    : `${current && current.version > 1 ? `Revised (v${current.version})` : "Submitted"} ${when(current?.submitted_at) ?? ""}`
                  : status.key === "declined"
                    ? `${when(invite.declined_at) ?? ""}`
                    : status.key === "opened"
                      ? `Opened ${when(invite.last_viewed_at) ?? ""}, no bid`
                      : invite.sent_at
                        ? `Sent ${when(invite.sent_at)}, not opened`
                        : "";
              return (
                <TableRow key={invite.id} className={cn(status.key === "declined" && "text-muted-foreground")}>
                  <TableCell className="py-2.5">
                    <span className="block truncate text-[13px] font-semibold">{name}</span>
                    {(invite.compliance_warning || invite.prequalification_warning) && (
                      <span className="block truncate text-[11px] font-medium text-warning">{invite.compliance_warning ?? invite.prequalification_warning}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", status.tone)}>
                      <span aria-hidden className="size-1.5 rounded-full bg-current" />
                      {status.label}
                    </span>
                    {note.trim() && <span className="block text-[11px] text-muted-foreground">{note.trim()}</span>}
                    {current && !bid && status.key === "in" && <span className="block text-[11px] font-medium text-age-2">Needs a revised bid</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums">{current?.total_cents != null ? money(current.total_cents) : "—"}</TableCell>
                  <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums">{leveled !== null ? money(leveled) : "—"}</TableCell>
                  <TableCell className="max-w-48">
                    {file ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (bid) openBid(bid.id);
                          onLevel();
                        }}
                        className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                        <FileText className="size-3.5 shrink-0" />
                        <span className="truncate">{file.name}</span>
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable && (status.key === "waiting" || status.key === "opened") ? (
                      entering === invite.id ? (
                        <form
                          className="inline-flex items-center gap-1.5"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const cents = toCents(amount);
                            if (cents === null) return;
                            actions.record(request.pkg.id, { bid_invite_id: invite.id, company_id: null, total_cents: cents, valid_until: null, exclusions: "", notes: "" });
                            setEntering(null);
                          }}
                        >
                          <Input autoFocus value={amount} onChange={(event) => setAmount(event.target.value)} aria-label={`${name}'s total`} placeholder="Their total" className="h-7 w-28 text-right text-xs tabular-nums" />
                          <Button size="sm" className="h-7 text-xs" disabled={actions.pending || toCents(amount) === null}>
                            Save
                          </Button>
                          <Button size="sm" type="button" variant="ghost" className="h-7 text-xs" onClick={() => setEntering(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={actions.pending} onClick={() => actions.remind(request.pkg.id, [invite.id])}>
                            Remind
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => {
                              setAmount("");
                              setEntering(invite.id);
                            }}
                          >
                            Enter a bid
                          </Button>
                        </span>
                      )
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

type From = { kind: "invite"; id: string; name: string } | { kind: "company"; id: string; name: string };

/**
 * A bid that came by email or phone, from anyone: an invited bidder (email-only
 * invites included) or a directory company that wasn't asked. Recorded as a lump sum.
 */
function EnterBid({ request, bidders, actions }: { request: DealBidRequest; bidders: DealBidder[]; actions: BidActions }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState<From | null>(null);
  const [amount, setAmount] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [exclusions, setExclusions] = useState("");
  const asked = new Set(request.invites.map((invite) => invite.company_id).filter(Boolean));
  const needle = query.trim().toLowerCase();
  const invited: From[] = request.invites.map((invite) => ({
    kind: "invite",
    id: invite.id,
    name: invite.company?.name ?? invite.contact?.full_name ?? invite.invite_email ?? "Bidder",
  }));
  const others: From[] = needle
    ? bidders
        .filter((bidder) => !asked.has(bidder.companyId) && `${bidder.name} ${bidder.trade ?? ""}`.toLowerCase().includes(needle))
        .slice(0, 6)
        .map((bidder) => ({ kind: "company", id: bidder.companyId, name: bidder.name }))
    : [];
  const choices = [...invited.filter((choice) => !needle || choice.name.toLowerCase().includes(needle)), ...others];
  const cents = toCents(amount);
  const reset = () => {
    setQuery("");
    setFrom(null);
    setAmount("");
    setValidUntil("");
    setExclusions("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 text-xs">
          <Edit className="size-3.5" />
          Enter a bid
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <form
          className="grid gap-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!from || cents === null) return;
            actions.record(request.pkg.id, {
              bid_invite_id: from.kind === "invite" ? from.id : null,
              company_id: from.kind === "company" ? from.id : null,
              total_cents: cents,
              valid_until: validUntil || null,
              exclusions: exclusions.trim(),
              notes: "",
            });
            setOpen(false);
            reset();
          }}
        >
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">From</span>
            {from ? (
              <div className="flex h-8 items-center justify-between gap-2 border px-2 text-[13px]">
                <span className="min-w-0 truncate font-medium">{from.name}</span>
                <button type="button" onClick={() => setFrom(null)} className="text-xs text-primary hover:underline">
                  Change
                </button>
              </div>
            ) : (
              <>
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="An invited bidder, or search your directory" aria-label="Who the bid is from" className="h-8 pl-7 text-[13px]" />
                </label>
                <ul className="grid max-h-44 overflow-y-auto border">
                  {choices.map((choice) => (
                    <li key={`${choice.kind}:${choice.id}`}>
                      <button
                        type="button"
                        onClick={() => setFrom(choice)}
                        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted/60"
                      >
                        <span className="min-w-0 truncate">{choice.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{choice.kind === "invite" ? "Invited" : "Not invited"}</span>
                      </button>
                    </li>
                  ))}
                  {!choices.length && <li className="px-2 py-2 text-xs text-muted-foreground">{needle ? "No match in your directory." : "Search your directory."}</li>}
                </ul>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Their total
              <Input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="$0" className="h-9 text-right text-[13px] tabular-nums" />
            </label>
            <DateField label="Good until" value={validUntil} onChange={setValidUntil} placeholder="Optional" clearable className="text-xs" />
          </div>
          <label className="grid gap-1.5 text-xs font-medium">
            <span>
              Exclusions <span className="font-normal text-muted-foreground">(optional, in their words)</span>
            </span>
            <Textarea value={exclusions} onChange={(event) => setExclusions(event.target.value)} rows={2} className="min-h-14 text-xs" />
          </label>
          <Button size="sm" disabled={actions.pending || !from || cents === null}>
            Record bid
          </Button>
          <p className="text-[11px] text-muted-foreground">Recorded as one total. Exclusions show on Leveling in their words.</p>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function InviteMore({ request, bidders, actions }: { request: DealBidRequest; bidders: DealBidder[]; actions: BidActions }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const asked = new Set(request.invites.map((invite) => invite.company_id));
  const available = bidders.filter((bidder) => !asked.has(bidder.companyId));
  const name = request.pkg.trade || request.pkg.title;
  const shown = query.trim()
    ? available.filter((bidder) => `${bidder.name} ${bidder.trade ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 10)
    : suggestedBidders(available, name).slice(0, 10);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 text-xs">
          <Plus className="size-3.5" />
          Invite more
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your directory" aria-label="Search bidders" className="h-8 pl-7 text-[13px]" />
        </label>
        <ul className="mt-1.5 grid max-h-64 overflow-y-auto">
          {shown.map((bidder) => (
            <li key={bidder.companyId}>
              <button
                type="button"
                disabled={actions.pending}
                onClick={() => {
                  actions.invite(request.pkg.id, [{ company_id: bidder.companyId, contact_id: bidder.contactId ?? undefined, invite_email: bidder.email }]);
                  setOpen(false);
                }}
                className="grid w-full px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/60"
              >
                <span className="truncate text-[13px] font-medium">{bidder.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {[bidder.trade, bidder.invited ? `answered ${bidder.answered} of ${bidder.invited}` : "first bid with you"].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="px-2 py-2 text-xs text-muted-foreground">{query ? "No match in your directory." : "Search your directory to invite a trade."}</li>}
        </ul>
        <p className="border-t px-2 pt-2 text-[11px] text-muted-foreground">They get the same lines, sheets and due date, and are emailed at once.</p>
      </PopoverContent>
    </Popover>
  );
}
