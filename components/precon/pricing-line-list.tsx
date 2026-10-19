"use client";

import { useState } from "react";
import { ChevronDown, Plus } from "@/components/icons";
import { isMeasured, type LineStatus, type PriceFirmness } from "@/lib/precon/deal-move";
import { money } from "@/lib/precon/format";
import {
  parseQuickLine,
  pricingRowSchema,
  requestScopeChanged,
  rowPricing,
  type PricingRow,
  type PricingWorksheet,
} from "@/lib/precon/pricing-worksheet";
import { cn } from "@/lib/utils";

/** What a line's mark says. Firm is a quote or a measurement; the dashed marks still need someone. */
export type LineMark = "firm" | "allowance" | "guess" | "included" | "open" | "bid" | "waiting" | "pick";

export const MARK_LABEL: Record<LineMark, string> = {
  firm: "Firm",
  allowance: "Allowance",
  guess: "Your guess",
  included: "In another line's quote",
  open: "Needs a price",
  bid: "Goes out for bids",
  waiting: "Waiting on bids",
  pick: "Bids to pick",
};

const MARK_STYLE: Record<LineMark, string> = {
  firm: "bg-success",
  allowance: "border-2 border-muted-foreground/70",
  guess: "firmness-guess",
  included: "bg-success/35",
  open: "border-[1.5px] border-dashed border-muted-foreground/55",
  bid: "border-[1.5px] border-chart-2",
  waiting: "border-[1.5px] border-dashed border-chart-2",
  pick: "bg-warning/25 shadow-[inset_0_0_0_1.5px_var(--warning)]",
};

export function lineMark(status: LineStatus): LineMark {
  switch (status.kind) {
    case "priced":
      return status.firmness;
    case "included":
      return "included";
    case "to_bid":
    case "request_draft":
      return "bid";
    case "awaiting_quotes":
      return "waiting";
    case "quotes_in":
      return "pick";
    case "open":
      return "open";
  }
}

export function FirmnessMark({ mark, className }: { mark: LineMark; className?: string }) {
  return (
    <span
      role="img"
      aria-label={MARK_LABEL[mark]}
      title={MARK_LABEL[mark]}
      className={cn("inline-block size-3 shrink-0", MARK_STYLE[mark], className)}
    />
  );
}

/** Lines with no price and no plan for one, in list order. Bids are the Bids tab's work. */
export function linesToPrice(worksheet: PricingWorksheet, firmness: PriceFirmness) {
  return worksheet.rows.filter((row) => !row.is_optional && (firmness.lines.get(row.id)?.kind ?? "open") === "open");
}

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const rate = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });
const quantity = (row: PricingRow) => `${row.quantity.toLocaleString("en-US")} ${row.unit.toUpperCase()}`;
export const isLumpSum = (row: PricingRow) => row.quantity === 1 && ["", "ls", "lump sum"].includes(row.unit.toLowerCase());

/** The quiet line under a line's name: what its price rests on, or what it is waiting for. */
export function lineCaption(row: PricingRow, status: LineStatus, worksheet: PricingWorksheet): { text: string; tone: string } {
  const pricing = rowPricing(row, worksheet);
  switch (status.kind) {
    case "included": {
      const first = worksheet.rows.find((item) => item.id === pricing.request?.row_ids[0]);
      return { text: `In ${first?.description ?? "another line"}'s quote`, tone: "text-muted-foreground" };
    }
    case "to_bid":
      return { text: "Goes out for bids · not requested yet", tone: "text-chart-2" };
    case "request_draft":
      return { text: "Bid request not sent", tone: "text-chart-2" };
    case "awaiting_quotes":
      return {
        text: `Asked ${status.invited} trade${status.invited === 1 ? "" : "s"}${status.dueAt ? ` · due ${shortDate(status.dueAt)}` : ""}`,
        tone: "text-chart-2",
      };
    case "quotes_in":
      return { text: `${status.received} bid${status.received === 1 ? "" : "s"} in · pick one`, tone: "text-warning" };
    case "open":
      return { text: "Needs a price", tone: "text-warning" };
    case "priced": {
      if (pricing.basis === "quote") return { text: `${pricing.source || "A trade"}'s quote`, tone: "text-muted-foreground" };
      const measure = isLumpSum(row) || row.unit_cost_cents === null ? "" : ` · ${quantity(row)} × ${rate(row.unit_cost_cents)}`;
      if (row.basis === "allowance") return { text: `Allowance${measure}`, tone: "text-muted-foreground" };
      if (row.basis === "quote") {
        return { text: `Your number until the bid${pricing.request ? "" : " · not requested yet"}`, tone: "text-chart-2" };
      }
      return { text: `${isMeasured(row) ? "Measured" : "Your number"}${measure || " · lump sum"}`, tone: "text-muted-foreground" };
    }
  }
}

const ACTION_LABEL: Partial<Record<LineStatus["kind"], { text: string; tone: string }>> = {
  open: { text: "Price it", tone: "text-warning" },
  to_bid: { text: "To bid", tone: "text-chart-2" },
  request_draft: { text: "Not sent", tone: "text-chart-2" },
  quotes_in: { text: "Pick a bid", tone: "text-warning" },
  awaiting_quotes: { text: "Waiting", tone: "text-chart-2" },
};

/**
 * The work, by section: each line is its name, what its price rests on and
 * the amount. Opening one is the only way to change it, so the list stays a
 * list. Sections fold and carry their subtotal and how firm they are.
 */
export function PricingLineList({
  worksheet,
  firmness,
  openRowId,
  editable,
  onOpen,
  onAdd,
}: {
  worksheet: PricingWorksheet;
  firmness: PriceFirmness;
  openRowId: string | null;
  editable: boolean;
  onOpen: (rowId: string) => void;
  onAdd: (section: string, rows: PricingRow[]) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<string[]>([]);
  const [naming, setNaming] = useState("");
  const sections = [...new Set(worksheet.rows.map((row) => row.section))];
  const pending = drafts.filter((name) => !sections.includes(name));

  return (
    <div className="space-y-2.5">
      <div className="border bg-card shadow-xs">
        {!worksheet.rows.length && !pending.length && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No lines yet. Type the first piece of work below.
          </p>
        )}
        {(sections.length || pending.length ? [...sections, ...pending] : [""]).map((section, index) => {
          const rows = worksheet.rows.filter((row) => row.section === section);
          const sums = { firm: 0, allowance: 0, guess: 0 };
          for (const row of rows) {
            const status = firmness.lines.get(row.id);
            if (status?.kind === "priced" && !row.is_optional) sums[status.firmness] += status.cost;
          }
          const subtotal = sums.firm + sums.allowance + sums.guess;
          const isClosed = closed.has(section);
          const share = (value: number) => `${subtotal ? (value / subtotal) * 100 : 0}%`;
          return (
            <section key={section || "unsectioned"} aria-label={section || "Lines"} className={cn(index > 0 && "border-t")}>
              {(section || sections.length > 1 || pending.length > 0) && (
                <button
                  type="button"
                  aria-expanded={!isClosed}
                  onClick={() =>
                    setClosed((current) => {
                      const next = new Set(current);
                      if (next.has(section)) next.delete(section);
                      else next.add(section);
                      return next;
                    })
                  }
                  className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-2.5 bg-muted/45 py-2.5 pl-3 pr-4 text-left transition-colors duration-150 hover:bg-muted"
                >
                  <ChevronDown
                    className={cn("size-3.5 text-muted-foreground transition-transform duration-150", isClosed && "-rotate-90")}
                  />
                  <span className="truncate text-xs font-semibold tracking-wide">
                    {section || "Other"}
                    <span className="ml-1.5 font-medium tabular-nums text-muted-foreground">{rows.length}</span>
                  </span>
                  <span className="flex h-1 w-16 overflow-hidden bg-muted" title="How firm this section is">
                    <span className="h-full bg-success" style={{ width: share(sums.firm) }} />
                    <span className="h-full bg-muted-foreground/45" style={{ width: share(sums.allowance) }} />
                    <span className="h-full bg-warning" style={{ width: share(sums.guess) }} />
                  </span>
                  <span className="min-w-24 text-right font-mono text-[13px] font-semibold tabular-nums">
                    {subtotal ? money(subtotal) : "—"}
                  </span>
                </button>
              )}
              {!isClosed && (
                <>
                  {rows.map((row) => (
                    <PricingLine
                      key={row.id}
                      row={row}
                      worksheet={worksheet}
                      status={firmness.lines.get(row.id) ?? { kind: "open" }}
                      open={openRowId === row.id}
                      onOpen={() => onOpen(row.id)}
                    />
                  ))}
                  {editable && <AddLine section={section} first={index === 0} onAdd={(added) => onAdd(section, added)} />}
                </>
              )}
            </section>
          );
        })}
      </div>
      {editable && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = naming.trim();
            if (!name) return;
            if (!sections.includes(name)) setDrafts((current) => [...current, name]);
            setNaming("");
          }}
        >
          <Plus className="size-3.5 text-muted-foreground" aria-hidden />
          <input
            aria-label="Add a section"
            placeholder="Add a section"
            value={naming}
            onChange={(event) => setNaming(event.target.value)}
            className="h-8 w-56 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:border-b focus-visible:border-primary"
          />
        </form>
      )}
    </div>
  );
}

function PricingLine({
  row,
  worksheet,
  status,
  open,
  onOpen,
}: {
  row: PricingRow;
  worksheet: PricingWorksheet;
  status: LineStatus;
  open: boolean;
  onOpen: () => void;
}) {
  const caption = lineCaption(row, status, worksheet);
  const action = ACTION_LABEL[status.kind];
  const request = rowPricing(row, worksheet).request;
  const scopeChanged = request && requestScopeChanged(request, worksheet.rows);
  return (
    <button
      type="button"
      id={`deal-line-${row.id}`}
      aria-current={open ? "true" : undefined}
      onClick={onOpen}
      className={cn(
        "relative grid w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-3 border-t py-2.5 pl-3.5 pr-4 text-left transition-colors duration-150 hover:bg-muted/50",
        open && "bg-primary/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary hover:bg-primary/[0.06]",
      )}
    >
      <FirmnessMark mark={lineMark(status)} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{row.description}</span>
          {row.is_optional && (
            <span className="shrink-0 border px-1 text-[10px] uppercase tracking-wider text-muted-foreground">Option</span>
          )}
          {scopeChanged && (
            <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Scope changed since the quote request" />
          )}
        </span>
        <span className={cn("block truncate text-xs", caption.tone)}>{caption.text}</span>
      </span>
      {status.kind === "priced" ? (
        <span className="text-right font-mono text-sm tabular-nums">{money(status.cost)}</span>
      ) : status.kind === "included" ? (
        <span className="text-right text-xs text-muted-foreground">—</span>
      ) : (
        <span className={cn("text-right text-xs font-semibold", action?.tone)}>{action?.text}</span>
      )}
    </button>
  );
}

/** Type a line the way you'd say it, or paste a column of them. */
function AddLine({ section, first, onAdd }: { section: string; first: boolean; onAdd: (rows: PricingRow[]) => void }) {
  const [text, setText] = useState("");
  const build = (value: string) => {
    const parsed = parseQuickLine(value);
    return parsed ? [pricingRowSchema.parse({ id: crypto.randomUUID(), section, ...parsed })] : [];
  };
  return (
    <form
      className="flex items-center gap-2.5 border-t py-1 pl-3.5 pr-4 transition-colors duration-150 focus-within:bg-primary/[0.04]"
      onSubmit={(event) => {
        event.preventDefault();
        const rows = build(text);
        if (!rows.length) return;
        onAdd(rows);
        setText("");
      }}
    >
      <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        id={first ? "deal-add-line" : undefined}
        aria-label={`Add a line${section ? ` to ${section}` : ""}`}
        placeholder={'Add a line, e.g. "Gutters 180 lf 12" or "Permits $2,400"'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const lines = event.clipboardData
            .getData("text")
            .split(/\r?\n/)
            .map((line) => line.replace(/\t+/g, " ").trim())
            .filter(Boolean);
          if (lines.length < 2) return;
          event.preventDefault();
          onAdd(lines.flatMap(build));
          setText("");
        }}
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
      <span className="hidden text-[11px] text-muted-foreground sm:inline">
        {text ? "Enter to add" : "Paste a list to add many"}
      </span>
    </form>
  );
}
