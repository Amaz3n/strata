"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Box, ChevronRight, Hammer, PenLine, Ruler, Trash2, X } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BankingPicker } from "@/components/books/banking-picker";
import { TakeoffLineBadge } from "@/components/takeoff/takeoff-line-badge";
import { measurementUnit } from "@/lib/drawings/measurement-context";
import { isMeasured, type LineStatus } from "@/lib/precon/deal-move";
import { money } from "@/lib/precon/format";
import { PRICING_UNITS, rowPricing, type PricingRow, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import type { BidPackage } from "@/lib/services/bids";
import type { ConditionRollup } from "@/lib/services/takeoff";
import type { CostCode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FirmnessMark, MARK_LABEL, isLumpSum, lineMark } from "./pricing-line-list";

type Way = "estimate" | "allowance" | "quote";

const WAYS: Array<{ way: Way; icon: typeof PenLine; title: string; detail: string }> = [
  { way: "estimate", icon: PenLine, title: "Your number", detail: "Quantity × rate or a lump sum" },
  { way: "allowance", icon: Box, title: "Allowance", detail: "A held amount the client fills" },
  { way: "quote", icon: Hammer, title: "Bids", detail: "Trades price it on Bids" },
];

const MEASURE_UNITS = [
  ["sf", "Area · SF"],
  ["sy", "Area · SY"],
  ["lf", "Length · LF"],
  ["ea", "Count · EA"],
  ["sq", "Roof · SQ"],
] as const;

const dollars = (cents: number | null) => (cents === null ? "" : String(cents / 100));
const toCents = (value: string) => (value.trim() === "" ? null : Math.round(Number(value) * 100));

/**
 * One line, opened: how it is priced (three choices, one at a time), the
 * number or the request behind it, and the rarer settings folded away.
 */
export function PricingLineInspector({
  row,
  worksheet,
  status,
  packages,
  costCodes,
  measurement,
  measurementsLoaded,
  editable,
  walking,
  toPrice,
  focusAt,
  onChange,
  onRemove,
  onMove,
  onUnlink,
  onBids,
  onMeasure,
  onOpenLine,
  onStep,
  onNext,
  onClose,
}: {
  row: PricingRow;
  worksheet: PricingWorksheet;
  status: LineStatus;
  packages: BidPackage[];
  costCodes: CostCode[];
  measurement?: ConditionRollup;
  measurementsLoaded: boolean;
  editable: boolean;
  /** Working through the lines that need a price, one after another. */
  walking: boolean;
  /** Lines other than this one that still need you. */
  toPrice: number;
  focusAt?: number;
  onChange: (change: Partial<PricingRow>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onUnlink: () => void;
  /** Open the Bids tab at this line: requests are made, sent and picked there. */
  onBids: () => void;
  onMeasure: (unit: string) => void;
  onOpenLine: (rowId: string) => void;
  onStep: (direction: -1 | 1) => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const pricing = rowPricing(row, worksheet);
  const request = pricing.request;
  const way: Way = request ? "quote" : row.basis;
  const [leaving, setLeaving] = useState<Way | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const mark = lineMark(status);

  // Opened to price it: the number is where the cursor goes.
  useEffect(() => {
    if (status.kind === "open" && way !== "quote") amountInput.current?.focus();
    // Only when the line opens or a header move points here again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt]);

  function choose(next: Way) {
    if (next === way) return;
    if (request && next !== "quote") return setLeaving(next);
    onChange({ basis: next });
    if (next !== "quote") requestAnimationFrame(() => amountInput.current?.focus());
  }

  return (
    <section aria-label={row.description} className="flex max-h-[inherit] flex-col border bg-card shadow-xs">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b py-3 pl-4 pr-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] text-muted-foreground">
            {row.section || "Lines"}
            {walking && (
              <span className="font-semibold text-warning">
                {" "}
                · {toPrice ? `${toPrice} more to price` : "the last one"}
              </span>
            )}
          </p>
          <input
            aria-label="Line name"
            value={row.description}
            disabled={!editable}
            onChange={(event) => onChange({ description: event.target.value })}
            className="w-full bg-transparent text-[17px] font-semibold outline-none"
          />
          <p className="mt-1 flex items-center gap-1.5 text-xs">
            <FirmnessMark mark={mark} className="size-2.5" />
            <span className="text-muted-foreground">{MARK_LABEL[mark]}</span>
            {status.kind === "priced" && <span className="ml-auto font-mono text-[13px] tabular-nums">{money(status.cost)}</span>}
          </p>
        </div>
        <div className="flex items-start gap-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label="Previous line" onClick={() => onStep(-1)}>
            <ArrowUp className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Next line" onClick={() => onStep(1)}>
            <ArrowDown className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Close the line" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <fieldset disabled={!editable} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4">
          {status.kind === "included" ? (
            <IncludedIn row={row} worksheet={worksheet} onOpenLine={onOpenLine} />
          ) : (
            <>
              <div className="grid gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">How is it priced?</p>
                <div role="group" aria-label="How is it priced" className="grid grid-cols-3 gap-1.5">
                  {WAYS.map((option) => {
                    const Icon = option.icon;
                    const active = way === option.way;
                    return (
                      <button
                        key={option.way}
                        type="button"
                        aria-pressed={active}
                        onClick={() => choose(option.way)}
                        className={cn(
                          "grid content-start justify-items-start gap-1 border p-2.5 text-left transition-colors duration-150 hover:border-primary/40",
                          active && "border-primary bg-primary/[0.06] shadow-[inset_0_0_0_1px_var(--primary)]",
                        )}
                      >
                        <Icon className={cn("size-3.5", active ? "text-primary" : "text-muted-foreground")} />
                        <span className="text-[13px] font-semibold">{option.title}</span>
                        <span className="text-[11px] leading-snug text-muted-foreground">{option.detail}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <BidStatus row={row} worksheet={worksheet} status={status} packages={packages} onBids={onBids} />
              {way !== "quote" || status.kind !== "priced" || status.firmness !== "firm" ? (
                <NumberEditor
                  row={row}
                  label={way === "estimate" ? "Cost" : way === "allowance" ? "Amount" : "Placeholder"}
                  hint={way === "quote" ? "until a bid is picked" : undefined}
                  amountInput={amountInput}
                  onChange={onChange}
                />
              ) : null}
              {way === "allowance" ? (
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  Covers
                  <Textarea
                    value={row.notes}
                    placeholder="What the client picks within it, and what happens above it."
                    onChange={(event) => onChange({ notes: event.target.value })}
                    className="field-sizing-content min-h-16 resize-none text-sm font-normal text-foreground"
                  />
                </label>
              ) : (
                <Measure
                  row={row}
                  measurement={measurement}
                  measurementsLoaded={measurementsLoaded}
                  onMeasure={onMeasure}
                />
              )}
            </>
          )}
        </fieldset>

        <details className="group border-t">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-150 group-open:rotate-90" />
            {way === "allowance" ? "Section, cost code, margin, option" : "Notes, section, cost code, margin, option"}
          </summary>
          <fieldset disabled={!editable} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3.5 px-4 pb-4">
            {way !== "allowance" && (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                What&apos;s included
                <Textarea
                  value={row.notes}
                  placeholder="Quantities, finishes, exclusions. Trades see this when they bid it."
                  onChange={(event) => onChange({ notes: event.target.value })}
                  className="field-sizing-content min-h-16 resize-none text-sm font-normal text-foreground"
                />
              </label>
            )}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Section
                <BankingPicker
                  placeholder="No section"
                  disabled={!editable}
                  value={row.section || null}
                  clearLabel="No section"
                  options={[...new Set(worksheet.rows.map((item) => item.section).filter(Boolean))].map((section) => ({
                    id: section,
                    name: section,
                  }))}
                  onChange={(value) => onChange({ section: value ?? "" })}
                  onCreate={async (name) => onChange({ section: name.trim() })}
                />
              </div>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Line margin %
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder={`${worksheet.markup_percent} (default)`}
                  value={row.markup_pct ?? ""}
                  onChange={(event) => onChange({ markup_pct: event.target.value === "" ? null : Number(event.target.value) })}
                />
              </label>
            </div>
            <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Cost code
              <BankingPicker
                placeholder="Unassigned"
                disabled={!editable}
                value={row.cost_code_id}
                clearLabel="Unassigned"
                options={costCodes.map((code) => ({ id: code.id, name: `${code.code} · ${code.name}` }))}
                onChange={(value) => onChange({ cost_code_id: value })}
              />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Offer as an option
                <span className="block text-xs text-muted-foreground">
                  {request ? "A line on a bid request is part of the base price." : "The client can add it; it stays out of the price."}
                </span>
              </span>
              <Switch
                checked={row.is_optional}
                disabled={!editable || Boolean(request)}
                onCheckedChange={(value) => onChange({ is_optional: value })}
              />
            </label>
            {request && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  On a bid request
                  <span className="block text-xs text-muted-foreground">
                    {request.row_ids.length > 1 ? `One bid for ${request.row_ids.length} lines.` : "Its bid prices this line."}
                  </span>
                </span>
                <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setUnlinking(true)}>
                  Take it off
                </Button>
              </div>
            )}
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onMove(-1)}>
                <ArrowUp className="size-3.5" />
                Move up
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onMove(1)}>
                <ArrowDown className="size-3.5" />
                Move down
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-8 text-destructive hover:text-destructive"
                disabled={Boolean(request)}
                title={request ? "Take the line off its bid request first." : undefined}
                onClick={onRemove}
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            </div>
          </fieldset>
        </details>
      </div>

      <footer className="flex items-center gap-2 border-t bg-muted/35 py-2.5 pl-4 pr-3">
        <span className="mr-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move · <Kbd>esc</Kbd> close
        </span>
        {walking || toPrice ? (
          <Button size="sm" onClick={onNext}>
            {toPrice ? "Next to price" : "Done"}
            {toPrice ? <ArrowRight className="size-3.5" /> : null}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onClose}>
            Done
          </Button>
        )}
      </footer>

      <AlertDialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take this line off its bid request?</AlertDialogTitle>
            <AlertDialogDescription>
              {request && request.row_ids.length > 1
                ? `The request covers ${request.row_ids.length} lines; it comes off all of them.`
                : "The line comes off the request."}{" "}
              The request and any bids are kept, and you price the line yourself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the request</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onUnlink();
                if (leaving) onChange({ basis: leaving });
                setLeaving(null);
              }}
            >
              Price it myself
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={unlinking} onOpenChange={setUnlinking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Take {request && request.row_ids.length > 1 ? `all ${request.row_ids.length} lines` : "this line"} off the request?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your own costs come back. The request and its bids stay on Bids, and the line still goes out for bids.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={onUnlink}>Take it off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** Quantity × rate, or one amount. A measured quantity comes from the plans and is not typed. */
function NumberEditor({
  row,
  label,
  hint,
  amountInput,
  onChange,
}: {
  row: PricingRow;
  label: string;
  hint?: string;
  amountInput: RefObject<HTMLInputElement | null>;
  onChange: (change: Partial<PricingRow>) => void;
}) {
  const lump = isLumpSum(row);
  const measured = isMeasured(row);
  const cost = row.unit_cost_cents === null ? null : Math.round(row.quantity * row.unit_cost_cents);
  const units = PRICING_UNITS.filter((unit) => unit !== "ls");
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {label}
          {hint && <span className="font-normal text-muted-foreground/75"> · {hint}</span>}
        </p>
        <div role="group" aria-label="Kind of number" className="inline-flex bg-muted p-0.5 text-[11px] font-medium">
          {(
            [
              [false, "Rate", "Quantity × rate"],
              [true, "Lump", "One lump sum"],
            ] as const
          ).map(([isLump, text, title]) => (
            <button
              key={text}
              type="button"
              title={title}
              aria-pressed={lump === isLump}
              disabled={measured && isLump}
              onClick={() => {
                if (lump === isLump) return;
                onChange(isLump ? { quantity: 1, unit: "ls", unit_cost_cents: cost } : { unit: "sf" });
              }}
              className={cn(
                "px-2.5 py-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-50",
                lump === isLump && "bg-background text-foreground shadow-xs",
              )}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {lump ? (
        <MoneyInput
          inputRef={amountInput}
          label={label}
          value={row.unit_cost_cents}
          onChange={(unit_cost_cents) => onChange({ unit_cost_cents })}
        />
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_4.75rem_minmax(0,1fr)] items-end gap-1.5">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Quantity
              <Input
                type="number"
                min="0"
                step="any"
                disabled={measured}
                value={row.quantity}
                onChange={(event) => onChange({ quantity: Number(event.target.value) || 0 })}
                className="font-mono tabular-nums"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Unit
              <select
                value={row.unit.toLowerCase()}
                disabled={measured}
                onChange={(event) => onChange({ unit: event.target.value })}
                className="h-9 border bg-background px-2 text-sm text-foreground"
              >
                {[...new Set([...units, row.unit.toLowerCase()])].map((unit) => (
                  <option key={unit} value={unit}>
                    {unit.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-1 text-[11px] text-muted-foreground">
              Rate
              <MoneyInput
                inputRef={amountInput}
                label="Rate"
                value={row.unit_cost_cents}
                onChange={(unit_cost_cents) => onChange({ unit_cost_cents })}
              />
            </div>
          </div>
          <p className="flex items-baseline justify-between border-t border-dashed pt-2 text-xs text-muted-foreground">
            <span>Total</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{cost === null ? "—" : money(cost)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function MoneyInput({
  inputRef,
  label,
  value,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  value: number | null;
  onChange: (cents: number | null) => void;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">$</span>
      <Input
        ref={inputRef}
        aria-label={label}
        type="number"
        step="0.01"
        placeholder="0"
        value={dollars(value)}
        onChange={(event) => onChange(toCents(event.target.value))}
        className="pl-6 text-right font-mono tabular-nums"
      />
    </div>
  );
}

/** Measuring is how your own number becomes firm, and the quantity trades bid. */
function Measure({
  row,
  measurement,
  measurementsLoaded,
  onMeasure,
}: {
  row: PricingRow;
  measurement?: ConditionRollup;
  measurementsLoaded: boolean;
  onMeasure: (unit: string) => void;
}) {
  const measured = isMeasured(row);
  const [unit, setUnit] = useState<string>(measurementUnit(row.unit) ?? "sf");
  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border px-3 py-2", measured ? "border-success/35 bg-success/[0.05]" : "border-dashed")}>
      <div className="flex items-center gap-2">
        <Ruler className={cn("size-3.5 shrink-0", measured ? "text-success" : "text-muted-foreground")} />
        <p className="min-w-0 flex-1 truncate text-[13px]">
          {measured ? (
            <span className="font-medium text-success">Measured · firm</span>
          ) : (
            <>
              <span className="font-medium">Plans</span>
              <span className="text-muted-foreground"> · measuring makes it firm</span>
            </>
          )}
        </p>
        {!measured && (
          <select
            aria-label="What to measure"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            className="h-7 border bg-background px-1.5 text-xs"
          >
            {MEASURE_UNITS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        )}
        <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => onMeasure(unit)}>
          {measured ? "Review" : "Measure"}
        </Button>
      </div>
      {measured && (
        <TakeoffLineBadge
          metadata={row.metadata}
          liveQuantity={row.quantity}
          measurement={measurement}
          sourceMissing={measurementsLoaded && !measurement}
        />
      )}
    </div>
  );
}

function IncludedIn({
  row,
  worksheet,
  onOpenLine,
}: {
  row: PricingRow;
  worksheet: PricingWorksheet;
  onOpenLine: (rowId: string) => void;
}) {
  const request = rowPricing(row, worksheet).request;
  const first = worksheet.rows.find((item) => item.id === request?.row_ids[0]);
  return (
    <div className="grid gap-2 bg-muted/45 px-3 py-3 text-sm">
      <p>
        One bid prices this line together with <strong>{first?.description ?? "another line"}</strong>. Its cost is carried
        there, once.
      </p>
      {first && (
        <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => onOpenLine(first.id)}>
          Open {first.description}
        </Button>
      )}
    </div>
  );
}

/** One row: where the line's bid request stands. Nothing until a request exists; the header already says it goes out for bids. */
function BidStatus({
  row,
  worksheet,
  status,
  packages,
  onBids,
}: {
  row: PricingRow;
  worksheet: PricingWorksheet;
  status: LineStatus;
  packages: BidPackage[];
  onBids: () => void;
}) {
  const pricing = rowPricing(row, worksheet);
  const request = pricing.request;
  if (!request) return null;
  const pkg = packages.find((item) => item.id === request.package_id);
  const shortDate = (value: string) =>
    new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const view: { tone: string; title: string; detail: string | null; action: string } = request.quote
    ? {
        tone: "text-success",
        title: `${pricing.source || "A trade"}'s bid`,
        detail: pricing.cost !== null ? money(request.quote.normalized_total_cents) : null,
        action: "View",
      }
    : status.kind === "quotes_in"
      ? {
          tone: "text-warning",
          title: `${status.received} bid${status.received === 1 ? "" : "s"} in`,
          detail: pkg?.lowest_bid_cents ? `lowest ${money(pkg.lowest_bid_cents)}` : null,
          action: "Pick",
        }
      : status.kind === "awaiting_quotes"
        ? {
            tone: "text-chart-2",
            title: `Asked ${status.invited} trade${status.invited === 1 ? "" : "s"}`,
            detail: status.dueAt ? `due ${shortDate(status.dueAt)}` : null,
            action: "View",
          }
        : { tone: "text-chart-2", title: "Request not sent", detail: null, action: "Send" };
  return (
    <div className="flex min-w-0 items-center gap-2.5 border px-3 py-2">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", view.tone)} />
      <p className="min-w-0 flex-1 truncate text-[13px]">
        <span className={cn("font-medium", view.tone)}>{view.title}</span>
        {view.detail && <span className="tabular-nums text-muted-foreground"> · {view.detail}</span>}
      </p>
      <button
        type="button"
        onClick={onBids}
        className="shrink-0 text-xs font-medium text-primary transition-colors duration-150 hover:text-primary/80"
      >
        {view.action} on Bids
      </button>
    </div>
  );
}
