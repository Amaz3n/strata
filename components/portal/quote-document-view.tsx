"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { documentCanvasStyle, documentTheme } from "@/lib/pdfs/document-theme";
import {
  isBuiltInSection,
  paymentAmounts,
  type ProposalDocument,
  type ProposalSectionId,
  type ProposalSectionKey,
} from "@/lib/precon/proposal-documents";
import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

export type QuotePricingDisplay = "itemized" | "subtotals" | "lump_sum" | "sections";

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
  /**
   * A deal proposal: the sections written around the price. When set it
   * replaces intro, summary, inclusions, exclusions and terms, and the
   * document reads as a sequence of named sections.
   */
  proposal?: ProposalDocument | null;
  /** Agreement signatures so far: signer email → when they signed; and the builder's countersignature. */
  signatures?: {
    signed: Record<string, string>;
    builder: { name: string; signedAt: string | null };
  } | null;
  /** The builder's preview: clicking a section selects it for editing. */
  selectedSection?: ProposalSectionKey | null;
  onSelectSection?: (id: ProposalSectionKey) => void;
  /** Drawn at the foot of each section (the client's "Ask about this"). */
  renderSectionFooter?: (id: ProposalSectionKey) => ReactNode;
  /** The builder's preview flags a section still waiting on them. */
  sectionFlags?: Record<ProposalSectionKey, string>;
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
  proposal,
  signatures,
  selectedSection,
  onSelectSection,
  renderSectionFooter,
  sectionFlags,
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
  const hasOptions = optionalLines.length > 0 || groupedOptionals.size > 0;
  // The total the client is looking at: the base price plus what they ticked.
  const optionsCents = lines
    .filter((line) => line.is_optional && line.id && selected.has(line.id))
    .reduce((sum, line) => sum + (line.amount_cents ?? 0), 0);
  const basePrice = totalCents ?? 0;

  // "By section": each section's total, with its lines listed by name.
  const sections: Array<{ id: string; name: string; lines: QuoteViewLine[] }> = [];
  for (const [index, line] of mainLines.entries()) {
    if (line.kind === "section") sections.push({ id: line.id ?? `s-${index}`, name: line.description, lines: [] });
    else {
      if (!sections.length) sections.push({ id: "work", name: "Work", lines: [] });
      sections[sections.length - 1].lines.push(line);
    }
  }

  function block(id: ProposalSectionKey, title: string, children: ReactNode, aside?: ReactNode) {
    if (!proposal) return children;
    const select = onSelectSection;
    const flag = sectionFlags?.[id];
    return (
      <section
        key={id}
        aria-label={title}
        data-section={id}
        role={select ? "button" : undefined}
        tabIndex={select ? 0 : undefined}
        onClick={select ? () => select(id) : undefined}
        onKeyDown={
          select
            ? (event: KeyboardEvent) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(id);
                }
              }
            : undefined
        }
        className={cn(
          "mt-9 scroll-mt-8",
          select &&
            "-mx-4 cursor-pointer px-4 py-3 outline-offset-0 transition-[outline-color] duration-150 hover:outline hover:outline-1 hover:outline-[var(--paper-rule)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
          select && selectedSection === id && "outline outline-2 outline-primary hover:outline-2 hover:outline-primary",
        )}
      >
        <h2
          className="flex items-baseline gap-3 border-b pb-2 text-[12.5px] font-semibold text-foreground"
          style={accent ? { borderColor: accent } : undefined}
        >
          {title}
          {flag ? (
            <span className="text-[11px] font-medium text-warning">{flag}</span>
          ) : null}
          {aside ? (
            <span className="ml-auto text-[11px] font-medium text-muted-foreground">{aside}</span>
          ) : null}
        </h2>
        {children}
        {renderSectionFooter?.(id)}
      </section>
    );
  }

  const linesTable = (
    <div className={proposal ? "" : "mt-8"}>
      {!proposal || showAmounts ? (
        <div
          className={cn("flex items-baseline justify-between pb-2", !proposal && "border-b")}
          style={accent && !proposal ? { borderColor: accent } : undefined}
        >
          <span className="text-[12.5px] font-semibold text-foreground">
            {proposal ? (pricingDisplay === "sections" ? "Section" : "Work") : "Scope & pricing"}
          </span>
          {showAmounts ? (
            <span className="text-[12.5px] font-semibold text-foreground">
              Amount
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="divide-y divide-border/70">
        {mainLines.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">
            No line items.
          </p>
        ) : pricingDisplay === "sections" ? (
          sections.map((section) => (
            <div key={section.id} className="flex items-start justify-between gap-6 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{section.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {section.lines
                    .map((line) => `${line.description}${line.badges?.includes("Allowance") ? " (allowance)" : ""}`)
                    .join(" · ")}
                </p>
              </div>
              <div className="shrink-0 pt-0.5 text-sm tabular-nums text-foreground">
                {money(section.lines.reduce((sum, line) => sum + (line.amount_cents ?? 0), 0))}
              </div>
            </div>
          ))
        ) : (
          mainLines.map((line, idx) => {
            const conditionId = line.takeoff_condition_id;
            return line.kind === "section" ? (
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
                  {line.notes && !proposal ? (
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
                  {conditionId && onShowTakeoff ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onShowTakeoff(conditionId);
                      }}
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
            );
          })
        )}
      </div>
    </div>
  );

  const renderOptionalRow = (line: QuoteViewLine, idx: number) => {
    const id = line.id ?? `opt-${idx}`;
    const isOn = selected.has(id);
    const toggle = onToggleOptional;
    const interactive = !!toggle;
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
    return toggle ? (
      <button
        key={id}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggle(id);
        }}
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

  const optionsList = hasOptions ? (
    <div className={proposal ? "" : "mt-6"}>
      {proposal ? null : (
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
      )}
      <div className="divide-y divide-border/70">
        {optionalLines.map(renderOptionalRow)}
      </div>
      {[...groupedOptionals.entries()].map(([group, groupLines]) => (
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
      ))}
    </div>
  ) : null;

  const totals = (
    <div className="ml-auto mt-5" style={{ width: documentTheme.totalsWidth * 4 / 3 }}>
      {showAmounts ? <div className="flex justify-between py-1"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money((totalCents ?? 0) - (taxCents ?? 0) - (contingencyCents ?? 0))}</span></div> : null}
      {!!contingencyCents && <div className="flex justify-between py-1"><span className="text-muted-foreground">Contingency{contingencyPercent ? ` (${contingencyPercent}%)` : ""}</span><span className="tabular-nums">{money(contingencyCents)}</span></div>}
      {!!taxCents && <div className="flex justify-between py-1"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(taxCents)}</span></div>}
      {proposal && !totalRange && optionsCents > 0 ? <div className="flex justify-between py-1"><span className="text-muted-foreground">Options you picked</span><span className="tabular-nums">{money(optionsCents)}</span></div> : null}
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
          <span>{proposal ? "Contract price" : "Total"}</span><span className="text-[14.5px] tabular-nums">{money(proposal ? basePrice + optionsCents : totalCents)} USD</span>
        </div>
      )}
    </div>
  );

  const questionsList = questions?.length ? (
    <div className={proposal ? "mt-3" : "mt-7"}>
      {proposal ? null : <p className="text-[12.5px] font-semibold text-foreground">Questions for you</p>}
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
  ) : null;

  const prose = "mt-3 whitespace-pre-line text-[12.5px] leading-relaxed text-foreground";
  const faint = "text-[11.5px] leading-relaxed text-muted-foreground";
  const payments = proposal ? paymentAmounts(basePrice, proposal.payments) : [];
  const dueOnSigning = optionsCents > 0 && proposal?.payments.length;

  // What each built-in section shows; null leaves it off the page because it has nothing to say.
  const sectionContent: Record<ProposalSectionId, { node: ReactNode; aside?: ReactNode } | null> | null = proposal
    ? {
        cover: proposal.cover.trim() ? { node: <p className={prose}>{proposal.cover}</p> } : null,
        scope: proposal.scope.length
          ? {
              node: (
                <div className="mt-1">
                  {proposal.scope.map((paragraph) => (
                    <div key={paragraph.section || "work"} className="mt-4">
                      {paragraph.section ? <h3 className="text-[13px] font-semibold text-foreground">{paragraph.section}</h3> : null}
                      {paragraph.text ? <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-foreground">{paragraph.text}</p> : null}
                      <p className={cn(faint, "mt-1")}>{paragraph.lines.join(" · ")}</p>
                    </div>
                  ))}
                </div>
              ),
            }
          : null,
        price: {
          node: (
            <>
              {linesTable}
              {totals}
            </>
          ),
        },
        options: hasOptions ? { node: optionsList, aside: onToggleOptional ? "Tick to add" : null } : null,
        allowances: proposal.allowances.length
          ? {
              node: (
                <>
                  <div className="divide-y divide-border/70">
                    {proposal.allowances.map((item, index) => (
                      <div key={index} className="flex items-start justify-between gap-6 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">{item.description}</p>
                          {item.section ? <p className={faint}>{item.section}</p> : null}
                        </div>
                        <span className="shrink-0 text-sm tabular-nums">{money(item.amount_cents)}</span>
                      </div>
                    ))}
                  </div>
                  <p className={cn(faint, "mt-2")}>{proposal.allowance_policy}</p>
                </>
              ),
            }
          : null,
        inclusions:
          proposal.inclusions.length || proposal.exclusions.length
            ? {
                node: (
                  <div className="mt-3 grid grid-cols-2 gap-8">
                    {([
                      ["Included", proposal.inclusions],
                      ["Not included", proposal.exclusions],
                    ] satisfies Array<[string, string[]]>)
                      .filter(([, items]) => items.length)
                      .map(([label, items]) => (
                        <div key={label} className="min-w-0">
                          <p className="text-[12px] font-semibold text-foreground">{label}</p>
                          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-foreground">
                            {items.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                  </div>
                ),
              }
            : null,
        payments:
          proposal.kind === "agreement" && proposal.payments.length
            ? {
                node: (
                  <>
                    <div className="flex justify-between pb-1 pt-3 text-[12px] font-semibold text-foreground">
                      <span>Payment</span>
                      <span className="flex gap-10"><span>%</span><span>Amount</span></span>
                    </div>
                    <div className="divide-y divide-border/70">
                      {proposal.payments.map((payment, index) => (
                        <div key={index} className="flex items-start justify-between gap-6 py-2.5">
                          <div className="min-w-0">
                            <p className="text-sm text-foreground">{payment.name}</p>
                            {payment.when ? <p className={faint}>{payment.when}</p> : null}
                          </div>
                          <span className="flex shrink-0 gap-6 text-sm tabular-nums">
                            <span className="text-muted-foreground">{payment.percent}%</span>
                            <span className="w-24 text-right">{money(payments[index])}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {dueOnSigning ? (
                      <p className={cn(faint, "mt-2")}>The {money(optionsCents)} in options is billed with the first payment after signing.</p>
                    ) : null}
                  </>
                ),
              }
            : null,
        schedule: {
          node: (
            <p className={prose}>
              {proposal.start_window ? (
                `We plan to start ${proposal.start_window}${proposal.duration_weeks ? ` and finish in about ${proposal.duration_weeks} weeks` : ""}.${proposal.kind === "agreement" ? " We confirm the start date when you sign." : ""}`
              ) : (
                <span className="text-muted-foreground">The start window goes here.</span>
              )}
            </p>
          ),
        },
        terms: {
          node: (
            <>
              {proposal.terms.trim() ? <p className={prose}>{proposal.terms}</p> : null}
              <p className={cn(faint, "mt-2")}>
                This proposal is valid until {formatDate(proposal.valid_until)}.
                {proposal.kind === "budget" ? " It is an estimate for your approval, not a contract. A proposal to sign follows once the price is set." : ""}
              </p>
            </>
          ),
        },
        signatures:
          proposal.kind === "agreement"
            ? {
                node: (
                  <div className="mt-6 grid grid-cols-2 gap-x-10 gap-y-8">
                    {proposal.signers.map((signer) => {
                      const at = signatures?.signed[signer.email.toLowerCase()];
                      return (
                        <div key={signer.email}>
                          <div className="flex h-9 items-end border-b border-foreground pb-1 font-serif text-lg italic">{at ? signer.name : ""}</div>
                          <p className={cn(faint, "mt-1")}>{signer.name}{at ? ` · signed ${formatDate(at)}` : ""}</p>
                        </div>
                      );
                    })}
                    <div>
                      <div className="flex h-9 items-end border-b border-foreground pb-1 font-serif text-lg italic">{signatures?.builder.signedAt ? signatures.builder.name : ""}</div>
                      <p className={cn(faint, "mt-1")}>
                        {[signatures?.builder.name, orgName].filter(Boolean).join(", ")}
                        {signatures?.builder.signedAt ? " · countersigned" : ""}
                      </p>
                    </div>
                  </div>
                ),
              }
            : null,
        questions: questionsList || renderSectionFooter ? { node: questionsList } : null,
      }
    : null;

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

          {proposal ? (
            <>
              {proposal.sections.map((section) => {
                const content = isBuiltInSection(section.key)
                  ? sectionContent?.[section.key]
                  : section.body.trim()
                    ? { node: <p className={cn(prose, "whitespace-pre-line")}>{section.body}</p>, aside: null }
                    : null;
                return content ? block(section.key, section.title, content.node, content.aside) : null;
              })}
            </>
          ) : (
            <>
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

              {linesTable}
              {optionsList}
              {totals}
              {questionsList}

              {/* Scope qualifications */}
              {inclusions ? (
                <div className="mt-7">
                  <p className="text-[12.5px] font-semibold text-foreground">
                    Included in this price
                  </p>
                  <p className={prose.replace("mt-3", "mt-2")}>{inclusions}</p>
                </div>
              ) : null}
              {exclusions ? (
                <div className="mt-7">
                  <p className="text-[12.5px] font-semibold text-foreground">
                    Not included
                  </p>
                  <p className={prose.replace("mt-3", "mt-2")}>{exclusions}</p>
                </div>
              ) : null}

              {/* Terms */}
              {terms ? (
                <div className="mt-7">
                  <p className="text-[12.5px] font-semibold text-foreground">
                    Terms &amp; conditions
                  </p>
                  <p className={prose.replace("mt-3", "mt-2")}>{terms}</p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
