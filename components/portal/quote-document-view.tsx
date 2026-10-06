"use client";

import { useState, type ReactNode } from "react";
import { documentCanvasStyle, documentTheme } from "@/lib/pdfs/document-theme";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

export type QuotePricingDisplay = "itemized" | "subtotals" | "lump_sum";

export type QuoteViewLine = {
  id?: string;
  kind: "item" | "section";
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unit_cost_cents?: number | null;
  amount_cents?: number | null;
  badges?: string[];
  notes?: string | null;
  muted?: boolean;
  /** Optional add-on the client can choose to include. */
  is_optional?: boolean;
  /** Alternates: optionals sharing a group label are pick-one-of-N. */
  option_group?: string | null;
  /**
   * Set when this line's quantity was measured off the plans. Renders a
   * "show me" affordance that opens the measured regions — the whole point of
   * the transparent estimate: the client can check the number, not just read it.
   */
  takeoff_condition_id?: string | null;
};

export interface QuoteDocumentViewProps {
  printLayout?: boolean;
  taxCents?: number | null;
  orgName?: string | null;
  orgLogoUrl?: string | null;
  orgAddress?: string | null;
  documentLabel: string;
  title: string;
  number?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  projectName?: string | null;
  issuedAt?: string | null;
  validUntil?: string | null;
  intro?: string | null;
  summary?: string | null;
  terms?: string | null;
  lines: QuoteViewLine[];
  totalCents?: number | null;
  /** A budget is a range, not a price: when set, it replaces the total. */
  totalRange?: { lowCents: number; highCents: number } | null;
  /** Open questions for the client, and the answers already given. */
  questions?: Array<{ id: string; question: string; answer?: string | null }>;
  /** When provided, unanswered questions take an answer inline (the client portal). */
  renderAnswer?: (questionId: string) => ReactNode;
  /** Contingency already included in the total; rendered as its own row. */
  contingencyCents?: number | null;
  contingencyPercent?: number | null;
  /** Scope qualifications rendered alongside the terms. */
  inclusions?: string | null;
  exclusions?: string | null;
  /** Hex accent color for headings, totals, and chrome. */
  accentColor?: string | null;
  /** CSS font-family applied to the document body. */
  fontFamily?: string | null;
  /** How much pricing breakdown to expose. Defaults to "itemized". */
  pricingDisplay?: QuotePricingDisplay;
  /** Ids of optional add-ons currently selected (controlled by the portal). */
  selectedOptionalIds?: string[];
  /** When provided, optional add-ons render as interactive checkboxes. */
  onToggleOptional?: (id: string) => void;
  /** When provided, measured lines offer "show me on the plans". */
  onShowTakeoff?: (conditionId: string) => void;
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100);

function formatDate(value?: string | null) {
  if (!value) return null;
  // If it starts with a YYYY-MM-DD pattern, parse it timezone-safely as a UTC date
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
    }
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Native, premium rendering of a quote (estimate or proposal) for the client portal.
 * Fixed height with internal scroll so the portal page stays compact. Sharp-edged to
 * match the app's house style.
 */
export function QuoteDocumentView({
  printLayout = false,
  taxCents,
  orgName,
  orgLogoUrl,
  orgAddress,
  documentLabel,
  title,
  number,
  recipientName,
  recipientEmail,
  projectName,
  issuedAt,
  validUntil,
  intro,
  summary,
  terms,
  lines,
  totalCents,
  totalRange,
  questions,
  renderAnswer,
  contingencyCents,
  contingencyPercent,
  inclusions,
  exclusions,
  accentColor,
  fontFamily,
  pricingDisplay = "itemized",
  selectedOptionalIds,
  onToggleOptional,
  onShowTakeoff,
}: QuoteDocumentViewProps) {
  const [showFullSummary, setShowFullSummary] = useState(false);
  const summaryIsLong =
    !!summary && (summary.length > 160 || summary.includes("\n"));

  const accent = accentColor || undefined;
  const showAmounts = pricingDisplay !== "lump_sum";
  const showUnitLine = pricingDisplay === "itemized";
  const selected = new Set(selectedOptionalIds ?? []);

  // Split out optional add-ons so they render as a distinct, selectable block.
  // Alternates (same option_group) cluster together under their group label.
  const mainLines = lines.filter((l) => !l.is_optional);
  const ungroupedOptionals = lines.filter(
    (l) => l.is_optional && l.kind === "item" && !l.option_group,
  );
  const groupedOptionals = new Map<string, QuoteViewLine[]>();
  for (const line of lines) {
    if (!line.is_optional || line.kind !== "item" || !line.option_group)
      continue;
    groupedOptionals.set(line.option_group, [
      ...(groupedOptionals.get(line.option_group) ?? []),
      line,
    ]);
  }
  const optionalLines = ungroupedOptionals;

  return (
    <div
      className={
        printLayout
          ? "min-h-[1056px] bg-[var(--paper)] text-[var(--paper-ink)] [--foreground:var(--paper-ink)] [--muted-foreground:var(--paper-ink-faint)] [--border:var(--paper-rule)] [--muted:var(--paper)]"
          : "flex h-[60vh] min-h-[460px] flex-col overflow-hidden border bg-card shadow-sm lg:h-[calc(100dvh-9rem)]"
      }
      style={{ fontFamily: fontFamily || documentCanvasStyle.fontFamily }}
    >
      <div className={printLayout ? "" : "flex-1 overflow-y-auto"}>
        <div className="[--foreground:var(--paper-ink)] [--muted-foreground:var(--paper-ink-soft)] [--border:var(--paper-rule)] [--muted:var(--paper)]" style={{ ...documentCanvasStyle, fontFamily: fontFamily || documentCanvasStyle.fontFamily }}>
          <div className="flex items-start justify-between gap-8">
            <div className="min-w-0 flex-1">
              <h1 className="font-bold leading-tight tracking-tight" style={{ fontSize: documentTheme.title.fontSize * 4 / 3, color: accent }}>{documentLabel}</h1>
              {projectName ? <p className="mt-1 text-sm text-muted-foreground">{projectName}</p> : null}
            </div>
            {orgLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={orgLogoUrl} alt={orgName ?? "Logo"} className="max-h-[74px] max-w-[212px] object-contain" />
            ) : null}
          </div>
          <dl className="mt-7 space-y-1.5">
            {[["Document number", number], ["Date of issue", formatDate(issuedAt)], ["Valid until", formatDate(validUntil)]].filter(([, value]) => value).map(([label, value]) => (
              <div key={label} className="flex gap-0">
                <dt className="w-32 shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-7 grid grid-cols-2 gap-10 leading-snug">
            <div className="min-w-0 break-words">
              <p className="mb-1.5 text-[12.5px] text-muted-foreground">From</p>
              <p>{orgName}</p>
              {orgAddress ? <p className="whitespace-pre-line">{orgAddress}</p> : null}
            </div>
            <div className="min-w-0 break-words">
              <p className="mb-1.5 text-[12.5px] text-muted-foreground">Prepared for</p>
              <p>{recipientName || "—"}</p>
              {recipientEmail ? <p>{recipientEmail}</p> : null}
            </div>
          </div>
          <h2 className="mt-9 text-[21px] font-bold tracking-tight">{title}</h2>

          {/* Cover note */}
          {intro ? (
            <div className="mt-6">
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                {intro}
              </p>
            </div>
          ) : null}

          {/* Collapsible summary — keeps pricing visible on open */}
          {summary ? (
            <div className="mt-6">
              <p
                className={`mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90 ${
                  !printLayout && summaryIsLong && !showFullSummary
                    ? "line-clamp-2"
                    : ""
                }`}
              >
                {summary}
              </p>
              {summaryIsLong && !printLayout ? (
                <button
                  type="button"
                  onClick={() => setShowFullSummary((v) => !v)}
                  className="mt-1 text-xs font-medium text-primary hover:underline"
                >
                  {showFullSummary ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Line items */}
          <div className="mt-8">
            <div
              className="flex items-baseline justify-between border-b pb-2"
              style={accent ? { borderColor: accent } : undefined}
            >
              <span className="text-[12.5px] font-semibold text-foreground">
                Scope & pricing
              </span>
              {showAmounts ? (
                <span className="text-[12.5px] font-semibold text-foreground">
                  Amount
                </span>
              ) : null}
            </div>
            <div className="divide-y divide-border/70">
              {mainLines.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">
                  No line items.
                </p>
              ) : (
                mainLines.map((line, idx) =>
                  line.kind === "section" ? (
                    <div
                      key={line.id ?? `s-${idx}`}
                      className="pb-1 pt-6 first:pt-3"
                    >
                      <p
                        className="text-xs font-semibold uppercase tracking-[0.1em]"
                        style={{ color: accent ?? undefined }}
                      >
                        {line.description}
                      </p>
                    </div>
                  ) : (
                    <div
                      key={line.id ?? `l-${idx}`}
                      className={`flex items-start justify-between gap-6 py-3 ${line.muted ? "opacity-55" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {line.description}
                          </p>
                          {line.badges?.map((b) => (
                            <Badge
                              key={b}
                              variant="outline"
                              className="px-2 py-0 text-[10px] font-medium"
                            >
                              {b}
                            </Badge>
                          ))}
                        </div>
                        {line.notes ? (
                          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                            {line.notes}
                          </p>
                        ) : null}
                        {showUnitLine ? (
                          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                            {line.quantity ?? 1}
                            {line.unit ? ` ${line.unit}` : ""} ×{" "}
                            {/* Unit price is the sell rate derived from the amount — the
                                builder's raw unit cost never renders client-side. */}
                            {money(
                              line.quantity && line.amount_cents != null
                                ? Math.round(line.amount_cents / line.quantity)
                                : line.unit_cost_cents,
                            )}
                          </p>
                        ) : null}
                        {line.takeoff_condition_id && onShowTakeoff ? (
                          <button
                            type="button"
                            onClick={() =>
                              onShowTakeoff(line.takeoff_condition_id as string)
                            }
                            className="mt-1.5 text-xs font-medium underline-offset-2 hover:underline"
                            style={accent ? { color: accent } : undefined}
                          >
                            Show me on the plans
                          </button>
                        ) : null}
                      </div>
                      {showAmounts ? (
                        <div className="shrink-0 pt-0.5 text-sm tabular-nums text-foreground">
                          {money(line.amount_cents)}
                        </div>
                      ) : null}
                    </div>
                  ),
                )
              )}
            </div>
          </div>

          {/* Optional add-ons — ungrouped extras plus pick-one alternate groups */}
          {optionalLines.length > 0 || groupedOptionals.size > 0 ? (
            <div className="mt-6">
              <div className="flex items-baseline justify-between border-b pb-2">
                <span className="text-[12.5px] font-semibold text-foreground">
                  Optional add-ons
                </span>
                {onToggleOptional ? (
                  <span className="text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
                    Tap to include
                  </span>
                ) : null}
              </div>
              {(() => {
                const renderOptionalRow = (
                  line: QuoteViewLine,
                  idx: number,
                ) => {
                  const id = line.id ?? `opt-${idx}`;
                  const isOn = selected.has(id);
                  const interactive = !!onToggleOptional;
                  const body = (
                    <>
                      <div className="flex min-w-0 items-center gap-3">
                        {interactive ? (
                          <Checkbox
                            checked={isOn}
                            className="pointer-events-none"
                            style={
                              accent && isOn
                                ? {
                                    backgroundColor: accent,
                                    borderColor: accent,
                                  }
                                : undefined
                            }
                          />
                        ) : null}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {line.description}
                          </p>
                          {line.notes ? (
                            <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                              {line.notes}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {showAmounts ? (
                        <div
                          className="shrink-0 text-sm font-semibold tabular-nums"
                          style={{
                            color: isOn ? (accent ?? undefined) : undefined,
                          }}
                        >
                          {isOn ? "Included · " : "+ "}{money(line.amount_cents)}
                        </div>
                      ) : null}
                    </>
                  );
                  const rowClass = `flex w-full items-center justify-between gap-4 py-3.5 text-left transition-colors ${
                    interactive ? "cursor-pointer hover:bg-muted/40" : ""
                  } ${interactive && !isOn ? "opacity-70" : ""}`;
                  return interactive ? (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onToggleOptional!(id)}
                      className={rowClass}
                    >
                      {body}
                    </button>
                  ) : (
                    <div key={id} className={rowClass}>
                      {body}
                    </div>
                  );
                };
                return (
                  <>
                    <div className="divide-y divide-border/70">
                      {optionalLines.map(renderOptionalRow)}
                    </div>
                    {[...groupedOptionals.entries()].map(
                      ([group, groupLines]) => (
                        <div key={group} className="mt-2">
                          <p className="pt-2 text-[12.5px] font-semibold text-foreground">
                            {group}
                            {onToggleOptional ? (
                              <span className="ml-2 font-medium normal-case tracking-normal">
                                choose one
                              </span>
                            ) : null}
                          </p>
                          <div className="divide-y divide-border/70">
                            {groupLines.map(renderOptionalRow)}
                          </div>
                        </div>
                      ),
                    )}
                  </>
                );
              })()}
            </div>
          ) : null}

          <div className="ml-auto mt-5" style={{ width: documentTheme.totalsWidth * 4 / 3 }}>
            {showAmounts ? <div className="flex justify-between py-1"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money((totalCents ?? 0) - (taxCents ?? 0) - (contingencyCents ?? 0))}</span></div> : null}
            {!!contingencyCents && <div className="flex justify-between py-1"><span className="text-muted-foreground">Contingency{contingencyPercent ? ` (${contingencyPercent}%)` : ""}</span><span className="tabular-nums">{money(contingencyCents)}</span></div>}
            {!!taxCents && <div className="flex justify-between py-1"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(taxCents)}</span></div>}
            {totalRange ? (
              <div className="mt-2 border-t pt-2.5" style={{ borderColor: accent || documentTheme.colors.text }}>
                <div className="flex justify-between gap-4 font-bold">
                  <span>Expected range</span>
                  <span className="text-[14.5px] tabular-nums">{money(totalRange.lowCents)} – {money(totalRange.highCents)}</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  A budget to plan with, not a contract. The fixed price follows once trade quotes and measurements are in.
                </p>
              </div>
            ) : (
              <div className="mt-2 flex justify-between border-t pt-2.5 font-bold" style={{ borderColor: accent || documentTheme.colors.text }}>
                <span>Total</span><span className="text-[14.5px] tabular-nums">{money(totalCents)} USD</span>
              </div>
            )}
          </div>

          {questions?.length ? (
            <div className="mt-7">
              <p className="text-[12.5px] font-semibold text-foreground">Questions for you</p>
              <ol className="mt-2 list-decimal space-y-2.5 pl-5 text-[12.5px] leading-relaxed text-foreground">
                {questions.map((item) => (
                  <li key={item.id}>
                    <p>{item.question}</p>
                    {item.answer ? (
                      <p className="mt-0.5 text-success">✓ {item.answer}</p>
                    ) : (
                      renderAnswer?.(item.id)
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {/* Scope qualifications */}
          {inclusions ? (
            <div className="mt-7">
              <p className="text-[12.5px] font-semibold text-foreground">
                Included in this price
              </p>
              <p className="mt-2 whitespace-pre-line text-[12.5px] leading-relaxed text-foreground">
                {inclusions}
              </p>
            </div>
          ) : null}
          {exclusions ? (
            <div
              className="mt-7"
            >
              <p className="text-[12.5px] font-semibold text-foreground">
                Not included
              </p>
              <p className="mt-2 whitespace-pre-line text-[12.5px] leading-relaxed text-foreground">
                {exclusions}
              </p>
            </div>
          ) : null}

          {/* Terms */}
          {terms ? (
            <div
              className="mt-7"
            >
              <p className="text-[12.5px] font-semibold text-foreground">
                Terms &amp; conditions
              </p>
              <p className="mt-2 whitespace-pre-line text-[12.5px] leading-relaxed text-foreground">
                {terms}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
