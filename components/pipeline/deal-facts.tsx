"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FIRM_PRICE_SHARE, type DealValue } from "@/lib/precon/deal-move";
import { compactMoney, money, waitingAge } from "@/lib/precon/format";
import type { PipelineDealFirmness } from "@/lib/services/precon-deals";
import { cn } from "@/lib/utils";

/** The facts a deal is read by, drawn the same way in the list and in the deal's own header. */

export type PipelineMember = { id: string; name: string; avatarUrl: string | null };

/** When anyone last touched the deal: days for the recent past, the date underneath. */
export function LastActivity({ at, today }: { at: string; today: Date }) {
  const { days } = waitingAge(at, today);
  const date = new Date(at);
  return (
    <div className="tabular-nums">
      <div
        className={cn(
          "text-sm font-medium",
          days >= 14 ? "text-age-2" : days >= 7 ? "text-age-1" : "text-foreground",
        )}
      >
        {days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== today.getFullYear() && { year: "numeric" }),
        })}
      </div>
    </div>
  );
}

/** Twenty cells of 5%: the firm line at 75% falls on a cell edge, so the last five are the firm zone. */
const FIRMNESS_CELLS = 20;
const firmnessZone = (index: number) => {
  const at = index / FIRMNESS_CELLS;
  if (at >= FIRM_PRICE_SHARE) return { lit: "bg-success", unlit: "bg-success/15" };
  if (at >= 0.4) return { lit: "bg-warning", unlit: "bg-muted-foreground/15" };
  return { lit: "bg-destructive", unlit: "bg-muted-foreground/15" };
};

/**
 * How much of the cost is firm (a quote or a measured quantity), as a level
 * meter: red while it is mostly guesses, amber as quotes come in, green once
 * it is a firm price. The unlit green cells show how far that is.
 */
export function FirmnessMeter({ firmness }: { firmness: PipelineDealFirmness | null }) {
  // Unpriced shows the empty meter, so the deal reads as at the start of the scale, not missing from it.
  const priced = firmness && firmness.cost > 0 ? firmness : null;
  const firm = Math.round((priced?.firmShare ?? 0) * 100);
  const lit = Math.round((priced?.firmShare ?? 0) * FIRMNESS_CELLS);
  const percent = (value: number) => (priced ? Math.round((value / priced.cost) * 100) : 0);
  const firmPrice = (priced?.firmShare ?? 0) >= FIRM_PRICE_SHARE;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2.5">
        <div
          role="img"
          aria-label={priced ? `${firm}% of cost is firm` : "Nothing priced yet"}
          title={
            priced
              ? `${firm}% firm · ${percent(priced.allowance)}% allowances · ${percent(priced.guess)}% guesses. Firm at ${FIRM_PRICE_SHARE * 100}%.`
              : `Nothing priced yet. Firm at ${FIRM_PRICE_SHARE * 100}%.`
          }
          className="flex h-6 flex-1 gap-[2px] bg-muted/60 p-[3px]"
        >
          {Array.from({ length: FIRMNESS_CELLS }, (_, index) => {
            const zone = firmnessZone(index);
            return <span key={index} className={cn("h-full flex-1", index < lit ? zone.lit : zone.unlit)} />;
          })}
        </div>
        <span
          className={cn(
            "w-9 text-right text-xs font-semibold tabular-nums",
            firmPrice ? "text-success" : priced ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {firm}%
        </span>
      </div>
      {!priced ? (
        <p className="text-[11px] text-muted-foreground">Not priced yet</p>
      ) : priced.unpriced > 0 && (
        <p className="text-[11px] tabular-nums text-warning">
          {priced.unpriced} {priced.unpriced === 1 ? "line" : "lines"} unpriced
        </p>
      )}
    </div>
  );
}

export function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function OwnerBadge({ member, you }: { member: PipelineMember | undefined; you: boolean }) {
  if (!member)
    return (
      <span className="inline-flex items-center gap-1.5 border border-dashed py-0.5 pl-0.5 pr-2.5 text-xs text-muted-foreground">
        <span className="size-5 rounded-full border border-dashed" aria-hidden />
        Unassigned
      </span>
    );
  return (
    <span
      title={member.name}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 border bg-background py-0.5 pl-0.5 pr-2.5 text-xs font-medium",
        you && "border-primary/30 bg-primary/5",
      )}
    >
      <Avatar className="size-5">
        {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
        <AvatarFallback className="bg-primary/10 text-[9px] font-semibold text-primary">{initials(member.name)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{you ? "You" : member.name}</span>
    </span>
  );
}

const PRICE_BASIS = { agreement: "Agreement", firm: "Firm price", proposal: "Proposal" } as const;

/** The number, then what it rests on, so a guess never reads like a contract. */
export function DealValueText({ value }: { value: DealValue }) {
  const caption = (text: string, tone = "text-muted-foreground") => (
    <div className={cn("mt-0.5 text-[11px]", tone)}>{text}</div>
  );
  switch (value.kind) {
    case "price":
      return (
        <div>
          <div className="text-sm font-semibold tabular-nums">{money(value.cents)}</div>
          {caption(PRICE_BASIS[value.basis], value.basis === "proposal" ? "text-muted-foreground" : "text-success")}
        </div>
      );
    case "range":
      return (
        <div>
          <div className="text-sm font-semibold tabular-nums">
            {compactMoney(value.low)}
            <span className="px-0.5 font-normal text-muted-foreground">–</span>
            {compactMoney(value.high)}
          </div>
          {caption("Budget range")}
        </div>
      );
    case "priced_so_far":
      return (
        <div>
          <div className="text-sm font-semibold tabular-nums">{compactMoney(value.cents)}+</div>
          {caption("Priced so far", "text-warning")}
        </div>
      );
    case "budget":
      return (
        <div>
          <div className="text-sm font-medium tabular-nums text-muted-foreground">{value.label}</div>
          {caption("Client's budget")}
        </div>
      );
    case "none":
      return <span className="text-sm text-muted-foreground">—</span>;
  }
}
