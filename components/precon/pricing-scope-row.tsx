"use client";

import { TakeoffLineBadge } from "@/components/takeoff/takeoff-line-badge";
import { measurementUnit } from "@/lib/drawings/measurement-context";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, ArrowUp, ArrowDown, Trash2, Ruler } from "lucide-react";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { BankingPicker } from "@/components/books/banking-picker";
import type { CostCode } from "@/lib/types";
import type { BidPackage } from "@/lib/services/bids";
import { rowPricing, requestScopeChanged, type PricingRow, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import type { LineStatus } from "@/lib/precon/deal-move";
import { money } from "@/lib/precon/format";
import { cn } from "@/lib/utils";

const PRICED_BY: Record<"firm" | "allowance" | "guess", string> = {
  firm: "bg-success",
  allowance: "bg-muted-foreground/50",
  guess: "firmness-guess",
};

export function PricingScopeRow({
  row,
  status,
  prospectId,
  onMeasure,
  measurement,
  measurementsLoaded,
  focusAt,
  worksheet,
  packages,
  costCodes,
  editable,
  selected,
  inspecting,
  onSelect,
  onChange,
  onRemove,
  onMove,
  onQuoteIntent,
  onQuotes,
  onUnlink,
}: {
  row: PricingRow;
  status: LineStatus;
  prospectId: string;
  onMeasure: (unit: string) => void;
  measurement?: ConditionRollup;
  measurementsLoaded: boolean;
  /** Set when the deal's next step points at this line; opens it once. */
  focusAt?: number;
  worksheet: PricingWorksheet;
  packages: BidPackage[];
  costCodes: CostCode[];
  editable: boolean;
  selected: boolean;
  inspecting: boolean;
  onSelect: (value: boolean) => void;
  onChange: (patch: Partial<PricingRow>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onQuoteIntent: () => void;
  onQuotes: () => void;
  onUnlink: () => void;
}) {
  const [measureUnit, setMeasureUnit] = useState(measurementUnit(row.unit) ?? "sf");
  const [expanded, setExpanded] = useState(false);
  const costInput = useRef<HTMLInputElement>(null);
  const pricing = rowPricing(row, worksheet);
  const pkg = packages.find((item) => item.id === pricing.request?.package_id);
  const lockedPrice = !!pricing.request?.quote;
  const grouped = !!pricing.request && pricing.request.row_ids.length > 1;
  const costRow = worksheet.rows.find((item) => item.id === pricing.request?.row_ids[0]);
  const measured = Boolean(row.metadata.takeoff || row.metadata.takeoff_source);
  const quantityBased = row.quantity !== 1 || !["", "ls", "lump sum"].includes(row.unit.toLowerCase());
  const scopeChanged = pricing.request && requestScopeChanged(pricing.request, worksheet.rows);

  useEffect(() => {
    if (focusAt === undefined) return;
    setExpanded(true);
    requestAnimationFrame(() => costInput.current?.focus());
  }, [focusAt]);

  function priceWith(basis: PricingRow["basis"]) {
    onChange({ basis });
    setExpanded(true);
    requestAnimationFrame(() => costInput.current?.focus());
  }

  const pricedBy = (() => {
    switch (status.kind) {
      case "priced":
        return (
          <span className="flex items-center gap-2 text-sm">
            <i className={cn("size-2 shrink-0", PRICED_BY[status.firmness])} aria-hidden />
            <span className="truncate">
              {lockedPrice
                ? pricing.source || "Trade quote"
                : row.basis === "quote"
                  ? row.source || "Trade quote"
                  : row.basis === "allowance"
                    ? "Allowance"
                    : measured
                      ? "Your number · measured"
                      : "Your number"}
            </span>
          </span>
        );
      case "included":
        return <span className="text-xs text-muted-foreground">In {costRow?.description ?? "another line"}&apos;s quote</span>;
      case "request_draft":
        return (
          <button type="button" className="text-left text-xs font-medium text-warning hover:underline" onClick={onQuotes} onPointerEnter={onQuoteIntent}>
            Quote request not sent
          </button>
        );
      case "awaiting_quotes":
        return (
          <button type="button" className="text-left text-xs font-medium text-chart-2 hover:underline" onClick={onQuotes} onPointerEnter={onQuoteIntent}>
            Asked {status.invited} trade{status.invited === 1 ? "" : "s"}
            {status.dueAt ? ` · due ${new Date(status.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
          </button>
        );
      case "quotes_in":
        return (
          <button type="button" className="text-left text-xs font-medium text-warning hover:underline" onClick={onQuotes} onPointerEnter={onQuoteIntent}>
            {status.received} quote{status.received === 1 ? "" : "s"} in · pick one
          </button>
        );
      case "open":
        return editable ? (
          <span className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => priceWith("estimate")}>
              Enter cost
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onQuotes} onPointerEnter={onQuoteIntent}>
              Get quotes
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => priceWith("allowance")}>
              Allowance
            </Button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Not priced</span>
        );
    }
  })();

  const inputStyle =
    "h-8 border-transparent bg-transparent shadow-none hover:border-border focus-visible:border-ring focus-visible:ring-1";
  return (
    <Fragment>
      <tr
        id={`deal-line-${row.id}`}
        className={cn(
          "border-b transition-colors duration-150",
          inspecting ? "bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]" : selected ? "bg-primary/5" : "hover:bg-muted/30",
        )}
      >
        <td className="w-10 pl-3">
          <Checkbox
            aria-label={`Select ${row.description}`}
            checked={selected}
            disabled={!editable}
            onCheckedChange={(value) => onSelect(value === true)}
          />
        </td>
        <td className="min-w-56 py-1.5 pr-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`${expanded ? "Close" : "Open"} ${row.description}`}
              aria-expanded={expanded}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
            <Input
              aria-label={`Line name: ${row.description}`}
              className={`${inputStyle} min-w-0 font-medium`}
              value={row.description}
              disabled={!editable}
              onChange={(event) => onChange({ description: event.target.value })}
            />
            {row.is_optional && (
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Optional</span>
            )}
          </div>
          <TakeoffLineBadge
            metadata={row.metadata}
            liveQuantity={row.quantity}
            prospectId={prospectId}
            rowId={row.id}
            measurement={measurement}
            sourceMissing={measurementsLoaded && !measurement}
            className="ml-7 pb-1"
          />
          {grouped && (
            <p className="ml-7 max-w-80 truncate text-xs text-muted-foreground">
              {pkg?.title || "Shared quote"} · {pricing.request!.row_ids.length} lines
            </p>
          )}
          {scopeChanged && <p className="ml-7 text-xs text-warning">Scope changed since the quote request</p>}
        </td>
        <td className="px-3 py-1.5">{pricedBy}</td>
        <td className="w-36 px-3 text-right font-mono text-sm tabular-nums">
          {pricing.covered ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : lockedPrice ? (
            money(pricing.cost ?? 0)
          ) : quantityBased ? (
            <button
              type="button"
              className="w-full py-1.5 text-right disabled:opacity-50"
              aria-label={`Edit quantity and unit cost for ${row.description}`}
              onClick={() => setExpanded(true)}
              disabled={!editable}
            >
              <span>{pricing.cost === null ? "—" : money(pricing.cost)}</span>
              <span className="block font-sans text-[11px] text-muted-foreground">
                {row.quantity} {row.unit} ×{" "}
                {row.unit_cost_cents === null ? "?" : money(row.unit_cost_cents)}
              </span>
            </button>
          ) : (
            <Input
              ref={costInput}
              aria-label={`Cost for ${row.description}`}
              type="number"
              step="0.01"
              className={`${inputStyle} px-2 text-right font-mono tabular-nums`}
              placeholder="—"
              disabled={!editable || row.quantity === 0}
              value={pricing.cost === null ? "" : pricing.cost / 100}
              onChange={(event) =>
                onChange({
                  unit_cost_cents: event.target.value === "" ? null : Math.round(Number(event.target.value) * 100),
                  metadata: { ...row.metadata, source_bid_submission_id: undefined, bid_pricing_basis: undefined },
                })
              }
            />
          )}
        </td>
        <td className="w-24 pr-3 text-right">
          <span className="inline-flex gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Measure ${row.description} from plans`}
              title="Measure from plans"
              onClick={() => setExpanded(true)}
            >
              <Ruler className="size-3.5" />
            </Button>
            {pricing.request && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onPointerEnter={onQuoteIntent} onClick={onQuotes}>
                Quotes
              </Button>
            )}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b bg-muted/20">
          <td colSpan={5} className="p-4 pl-12">
            <fieldset disabled={!editable} className="space-y-4">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                {!lockedPrice && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Price it by</p>
                    <div className="inline-flex border" role="group" aria-label={`How ${row.description} is priced`}>
                      {(
                        [
                          ["estimate", "My number"],
                          ["allowance", "Allowance"],
                        ] as const
                      ).map(([basis, label]) => (
                        <button
                          key={basis}
                          type="button"
                          aria-pressed={row.basis === basis}
                          onClick={() => priceWith(basis)}
                          className={cn(
                            "h-8 border-r px-3 text-xs transition-colors duration-150",
                            row.basis === basis ? "bg-foreground text-background" : "bg-background hover:bg-muted",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={onQuotes}
                        onPointerEnter={onQuoteIntent}
                        className="h-8 bg-background px-3 text-xs transition-colors duration-150 hover:bg-muted"
                      >
                        Trade quotes
                      </button>
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    {measured ? "Measured from plans" : lockedPrice ? "Check the quote's coverage on plans" : "Measuring makes your number firm"}
                  </p>
                  <div className="flex items-center gap-2">
                    {!measured && (
                      <select
                        aria-label={`Measurement unit for ${row.description}`}
                        value={measureUnit}
                        onChange={(event) => setMeasureUnit(event.target.value as typeof measureUnit)}
                        className="h-8 border bg-background px-2 text-xs"
                      >
                        <option value="sf">Area · SF</option>
                        <option value="sy">Area · SY</option>
                        <option value="lf">Length · LF</option>
                        <option value="ea">Count · EA</option>
                        <option value="sq">Roof · SQ</option>
                      </select>
                    )}
                    <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => onMeasure(measureUnit)}>
                      <Ruler className="size-3.5" />
                      {measured ? "Review on plans" : "Measure from plans"}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  Quantity
                  <Input
                    aria-label={`Quantity for ${row.description}`}
                    type="number"
                    min="0"
                    step="any"
                    disabled={lockedPrice}
                    value={row.quantity}
                    onChange={(event) => onChange({ quantity: Number(event.target.value) })}
                  />
                </label>
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  Unit
                  <Input
                    aria-label={`Unit for ${row.description}`}
                    value={row.unit}
                    disabled={lockedPrice}
                    onChange={(event) => onChange({ unit: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  {quantityBased ? "Unit cost" : "Cost"}
                  <Input
                    ref={quantityBased ? costInput : undefined}
                    aria-label={`Unit cost for ${row.description}`}
                    type="number"
                    step="0.01"
                    disabled={lockedPrice}
                    placeholder="—"
                    value={row.unit_cost_cents === null ? "" : row.unit_cost_cents / 100}
                    onChange={(event) =>
                      onChange({
                        unit_cost_cents: event.target.value === "" ? null : Math.round(Number(event.target.value) * 100),
                      })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  Margin %
                  <Input
                    aria-label={`Margin for ${row.description}`}
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder={`${worksheet.markup_percent} (default)`}
                    value={row.markup_pct ?? ""}
                    onChange={(event) =>
                      onChange({ markup_pct: event.target.value === "" ? null : Number(event.target.value) })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  Section
                  <BankingPicker
                    placeholder={`Section for ${row.description}`}
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
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  What&apos;s included
                  <Textarea
                    aria-label={`Details for ${row.description}`}
                    rows={2}
                    placeholder="Quantities, finishes, exclusions. Trades see this when you ask for quotes."
                    value={row.notes}
                    onChange={(event) => onChange({ notes: event.target.value })}
                  />
                </label>
                <label className="block space-y-1.5 text-xs text-muted-foreground">
                  Cost code
                  <BankingPicker
                    placeholder={`Cost code for ${row.description}`}
                    disabled={!editable}
                    value={row.cost_code_id}
                    clearLabel="Unassigned"
                    options={costCodes.map((code) => ({ id: code.id, name: `${code.code} · ${code.name}` }))}
                    onChange={(value) => onChange({ cost_code_id: value })}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="mr-auto flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={row.is_optional}
                    disabled={!!pricing.request}
                    onCheckedChange={(value) => onChange({ is_optional: value === true })}
                  />
                  Optional add-on the client can choose
                </label>
                {pricing.request && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="outline" size="sm">
                        {grouped ? `Unlink the shared quote (${pricing.request.row_ids.length} lines)` : "Unlink the quote request"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Unlink the quote request?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {grouped
                            ? `This takes the request off all ${pricing.request.row_ids.length} lines it covers.`
                            : "This takes the request off this line."}{" "}
                          Your own costs come back. The request and its quotes are kept.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction onClick={onUnlink}>Unlink</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${row.description} up`} onClick={() => onMove(-1)}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${row.description} down`} onClick={() => onMove(1)}>
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={!!pricing.request} onClick={onRemove}>
                  <Trash2 className="size-3.5" /> Remove
                </Button>
              </div>
            </fieldset>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
