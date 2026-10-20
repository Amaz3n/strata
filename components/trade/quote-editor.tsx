"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import {
  getQuoteLinesForReuseAction,
  listReusableQuotesAction,
  reviseTradeQuoteAction,
  saveTradeQuoteAction,
  sendTradeQuoteAction,
} from "@/app/(app)/pipeline/[dealId]/trade-actions";
import type { TradeOpportunityDetail } from "@/lib/services/trade-quotes";
import {
  QUOTE_LINE_KINDS,
  QUOTE_LINE_KIND_LABELS,
  quoteLineAmountCents,
  quoteTotals,
  type QuoteLine,
  type QuoteLineKind,
  type TradeQuoteInput,
} from "@/lib/trade/quote";
import { formatLocalDate, formatMoneyCents } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const QUOTE_EDITOR_ID = "quote-editor";

const CELL_SELECT = "h-8 w-full border border-input bg-background px-1.5 text-sm";
const CELL_INPUT = "h-8 px-2 text-sm";

type ReusableQuote = { id: string; title: string; opportunity: string; totalCents: number; createdAt: string };

function newLine(kind: QuoteLineKind, section: string): QuoteLine {
  return {
    kind,
    section,
    description: "",
    quantity: 1,
    unit: kind === "labor" ? "hr" : kind === "material" ? "ea" : "",
    unit_price_cents: 0,
    markup_percent: 0,
    optional: false,
    rate_id: null,
  };
}

function initialQuote(data: TradeOpportunityDetail): TradeQuoteInput {
  return (
    data.quote?.quote ?? {
      title: `${data.opportunity.name} quote`,
      lines: [],
      tax_rate: 0,
      valid_until: null,
      scope: data.scope,
      exclusions: "",
      terms: "",
    }
  );
}

/** A number box that lets the person type "1." or an empty field without the value snapping back. */
function NumberInput({
  value,
  onCommit,
  toText,
  fromText,
  label,
  className,
  step,
  max,
}: {
  value: number;
  onCommit: (value: number) => void;
  toText: (value: number) => string;
  fromText: (text: string) => number;
  label: string;
  className?: string;
  step?: string;
  max?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      type="number"
      inputMode="decimal"
      min="0"
      max={max}
      step={step ?? "any"}
      aria-label={label}
      className={`${CELL_INPUT} text-right tabular-nums ${className ?? ""}`}
      value={text ?? toText(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setText(e.target.value);
        const next = fromText(e.target.value);
        if (Number.isFinite(next) && next >= 0) onCommit(next);
      }}
      onBlur={() => setText(null)}
    />
  );
}

const plain = (n: number) => String(n);
const dollars = (cents: number) => (cents / 100).toFixed(2);

function sectionOrder(lines: QuoteLine[], extra: string[]) {
  const sections: string[] = [""];
  for (const line of lines) if (!sections.includes(line.section)) sections.push(line.section);
  for (const name of extra) if (!sections.includes(name)) sections.push(name);
  return sections;
}

export function QuoteEditor({ data }: { data: TradeOpportunityDetail }) {
  const router = useRouter();
  const saved = data.quote;
  const editable = data.canWrite && (saved === null || saved.editable);
  const baseline = initialQuote(data);
  const key = `${saved?.id ?? "new"}:${saved?.updatedAt ?? ""}`;

  const [seenKey, setSeenKey] = useState(key);
  const [quote, setQuote] = useState<TradeQuoteInput>(baseline);
  const [extraSections, setExtraSections] = useState<string[]>([]);
  const [sectionName, setSectionName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [revising, startRevise] = useTransition();
  const [reuseOpen, setReuseOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  // A save or revision refreshes the page with a new version of the quote; start from it.
  if (seenKey !== key) {
    setSeenKey(key);
    setQuote(baseline);
    setExtraSections([]);
    setError(null);
  }

  const dirty = JSON.stringify(quote) !== JSON.stringify(baseline);
  const totals = quoteTotals(quote.lines, quote.tax_rate);
  const sections = sectionOrder(quote.lines, extraSections);
  const email = data.contact?.email?.trim() ?? "";

  const setLine = (index: number, patch: Partial<QuoteLine>) =>
    setQuote((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  const addLine = (kind: QuoteLineKind) =>
    setQuote((current) => ({
      ...current,
      lines: [...current.lines, newLine(kind, current.lines.at(-1)?.section ?? "")],
    }));

  function save() {
    if (quote.lines.length === 0) {
      setError("Add at least one line.");
      return;
    }
    if (quote.lines.some((line) => !line.description.trim())) {
      setError("Describe every line.");
      return;
    }
    setError(null);
    startSave(async () => {
      const result = await saveTradeQuoteAction({
        prospect_id: data.opportunity.id,
        estimate_id: saved?.id ?? null,
        expected_updated_at: saved?.updatedAt ?? null,
        quote,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function revise() {
    if (!saved) return;
    setError(null);
    startRevise(async () => {
      const result = await reviseTradeQuoteAction({ estimate_id: saved.id });
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const sendHint = !saved
    ? "Save the quote to send it."
    : dirty
      ? "Save your changes to send it."
      : !email
        ? "Add the customer's email to send it."
        : null;

  return (
    <section id={QUOTE_EDITOR_ID} aria-label="Quote" className="scroll-mt-4 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="quote-title" className="text-xs text-muted-foreground">
            Quote
          </Label>
          {editable ? (
            <Input
              id="quote-title"
              className="h-9 max-w-xl text-base font-semibold"
              value={quote.title}
              maxLength={200}
              onChange={(e) => setQuote({ ...quote, title: e.target.value })}
            />
          ) : (
            <h2 id="quote-title" className="text-base font-semibold">
              {quote.title}
            </h2>
          )}
        </div>
        {editable && (
          <Button size="sm" variant="outline" onClick={() => setReuseOpen(true)}>
            Copy lines from a past quote
          </Button>
        )}
      </div>

      {!editable && saved && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {saved.sentAt ? `Sent ${format(new Date(saved.sentAt), "MMM d")}. ` : ""}
            {data.canWrite ? "Revise to change it." : "Read only."}
          </span>
          {data.canWrite && (
            <Button size="sm" variant="outline" disabled={revising} onClick={revise}>
              {revising ? "Revising…" : "Revise"}
            </Button>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-medium text-muted-foreground">
              <th className="w-28 py-2 pr-2 font-medium">Kind</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="w-20 py-2 pr-2 text-right font-medium">Qty</th>
              <th className="w-16 py-2 pr-2 font-medium">Unit</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Rate / unit cost</th>
              <th className="w-20 py-2 pr-2 text-right font-medium">Markup %</th>
              <th className="w-14 py-2 pr-2 text-center font-medium">Optional</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Amount</th>
              {editable && <th className="w-9 py-2" aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {quote.lines.length === 0 && (
              <tr>
                <td colSpan={editable ? 9 : 8} className="py-8 text-center text-sm text-muted-foreground">
                  {editable
                    ? "No lines yet. Add labor, material or equipment below."
                    : "This quote has no lines."}
                </td>
              </tr>
            )}
            {sections.map((section) => {
              const rows = quote.lines
                .map((line, index) => ({ line, index }))
                .filter((row) => row.line.section === section);
              if (rows.length === 0 && !section) return null;
              return [
                section || rows.length === 0 ? (
                  <tr key={`heading-${section}`} className="bg-muted/40">
                    <td colSpan={editable ? 9 : 8} className="px-0 py-1.5 pl-2 text-xs font-semibold">
                      {section}
                      {rows.length === 0 && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          Empty. Move a line here from its section menu.
                        </span>
                      )}
                    </td>
                  </tr>
                ) : null,
                ...rows.map(({ line, index }) => (
                  <LineRow
                    key={`line-${index}`}
                    line={line}
                    sections={sections}
                    rates={data.rates.filter((rate) => rate.kind === line.kind)}
                    editable={editable}
                    onChange={(patch) => setLine(index, patch)}
                    onRemove={() =>
                      setQuote((current) => ({
                        ...current,
                        lines: current.lines.filter((_, i) => i !== index),
                      }))
                    }
                  />
                )),
              ];
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => addLine("labor")}>
            Add labor
          </Button>
          <Button size="sm" variant="outline" onClick={() => addLine("material")}>
            Add material
          </Button>
          <Button size="sm" variant="outline" onClick={() => addLine("equipment")}>
            Add equipment
          </Button>
          <form
            className="ml-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = sectionName.trim();
              if (!name) return;
              setExtraSections((current) => (current.includes(name) ? current : [...current, name]));
              setSectionName("");
            }}
          >
            <Input
              aria-label="Section name"
              className={`${CELL_INPUT} w-44`}
              placeholder="Section name"
              maxLength={80}
              value={sectionName}
              onChange={(e) => setSectionName(e.target.value)}
            />
            <Button size="sm" variant="ghost" type="submit" disabled={!sectionName.trim()}>
              Add section
            </Button>
          </form>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quote-valid">Valid until</Label>
            {editable ? (
              <Input
                id="quote-valid"
                type="date"
                className="h-9 w-44"
                value={quote.valid_until ?? ""}
                onChange={(e) => setQuote({ ...quote, valid_until: e.target.value || null })}
              />
            ) : (
              <p className="text-sm">
                {quote.valid_until ? formatLocalDate(quote.valid_until, "MMM d, yyyy") : "No expiry"}
              </p>
            )}
          </div>
          <TextBlock id="quote-scope" label="Scope" value={quote.scope} editable={editable} onChange={(scope) => setQuote({ ...quote, scope })} />
          <TextBlock id="quote-exclusions" label="Exclusions" value={quote.exclusions} editable={editable} onChange={(exclusions) => setQuote({ ...quote, exclusions })} />
          <TextBlock id="quote-terms" label="Terms" value={quote.terms} editable={editable} onChange={(terms) => setQuote({ ...quote, terms })} />
        </div>

        <dl className="h-fit space-y-1.5 text-sm">
          <TotalRow label="Labor" cents={totals.byKind.labor} />
          <TotalRow label="Material" cents={totals.byKind.material} />
          <TotalRow label="Equipment" cents={totals.byKind.equipment} />
          <TotalRow label="Other" cents={totals.byKind.other} />
          <TotalRow label="Subtotal" cents={totals.subtotal} rule />
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">
              <Label htmlFor="quote-tax">Tax rate (%)</Label>
            </dt>
            <dd>
              {editable ? (
                <NumberInput
                  label="Tax rate percent"
                  className="w-20"
                  max="25"
                  step="0.01"
                  value={quote.tax_rate}
                  toText={plain}
                  fromText={Number}
                  onCommit={(tax_rate) => setQuote((current) => ({ ...current, tax_rate }))}
                />
              ) : (
                <span className="tabular-nums">{quote.tax_rate}%</span>
              )}
            </dd>
          </div>
          <TotalRow label="Tax" cents={totals.tax} />
          <TotalRow label="Total" cents={totals.total} strong rule />
          {totals.optional > 0 && (
            <TotalRow label="Optional add-ons (not in total)" cents={totals.optional} muted />
          )}
        </dl>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save draft"}
          </Button>
          <Button variant="outline" disabled={sendHint !== null || saving} onClick={() => setSendOpen(true)}>
            Send to customer
          </Button>
          <span className="text-xs text-muted-foreground">
            {sendHint ?? (saved?.sentAt ? "" : `Goes to ${email}`)}
          </span>
        </div>
      )}

      {saved && (
        <SendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          estimateId={saved.id}
          email={email}
          totalCents={totals.total}
        />
      )}
      {reuseOpen && (
      <ReuseDialog
        onOpenChange={setReuseOpen}
        onPick={(lines, mode) =>
          setQuote((current) => ({
            ...current,
            lines: mode === "replace" ? lines : [...current.lines, ...lines],
          }))
        }
      />
      )}
    </section>
  );
}

function TextBlock({
  id,
  label,
  value,
  editable,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  if (!editable && !value.trim()) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {editable ? (
        <Textarea id={id} value={value} maxLength={4000} className="min-h-20" onChange={(e) => onChange(e.target.value)} />
      ) : (
        <p id={id} className="whitespace-pre-wrap text-sm">
          {value}
        </p>
      )}
    </div>
  );
}

function TotalRow({
  label,
  cents,
  strong,
  rule,
  muted,
}: {
  label: string;
  cents: number;
  strong?: boolean;
  rule?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${rule ? "border-t pt-1.5" : ""} ${strong ? "text-base font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}
    >
      <dt className={strong || muted ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{formatMoneyCents(cents)}</dd>
    </div>
  );
}

function LineRow({
  line,
  sections,
  rates,
  editable,
  onChange,
  onRemove,
}: {
  line: QuoteLine;
  sections: string[];
  rates: TradeOpportunityDetail["rates"];
  editable: boolean;
  onChange: (patch: Partial<QuoteLine>) => void;
  onRemove: () => void;
}) {
  const amount = quoteLineAmountCents(line);
  if (!editable) {
    return (
      <tr className={`border-b ${line.optional ? "text-muted-foreground" : ""}`}>
        <td className="py-2 pr-2">{QUOTE_LINE_KIND_LABELS[line.kind]}</td>
        <td className="py-2 pr-2">{line.description}</td>
        <td className="py-2 pr-2 text-right tabular-nums">{line.quantity}</td>
        <td className="py-2 pr-2">{line.unit}</td>
        <td className="py-2 pr-2 text-right tabular-nums">{formatMoneyCents(line.unit_price_cents)}</td>
        <td className="py-2 pr-2 text-right tabular-nums">{line.markup_percent}</td>
        <td className="py-2 pr-2 text-center">{line.optional ? "Yes" : ""}</td>
        <td className="py-2 pr-2 text-right tabular-nums">{formatMoneyCents(amount)}</td>
      </tr>
    );
  }
  return (
    <tr className="border-b align-top">
      <td className="py-1.5 pr-2">
        <select
          aria-label="Kind"
          className={CELL_SELECT}
          value={line.kind}
          onChange={(e) => {
            const kind = QUOTE_LINE_KINDS.find((item) => item === e.target.value);
            if (!kind) return;
            onChange({
              kind,
              rate_id: null,
              unit: line.unit || (kind === "labor" ? "hr" : line.unit),
            });
          }}
        >
          {QUOTE_LINE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {QUOTE_LINE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2">
        <div className="space-y-1">
          <Input
            aria-label="Description"
            className={CELL_INPUT}
            value={line.description}
            maxLength={500}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <div className="flex gap-1.5">
            {rates.length > 0 && (
              <select
                aria-label="Rate"
                className={`${CELL_SELECT} text-xs text-muted-foreground`}
                value={line.rate_id ?? ""}
                onChange={(e) => {
                  const rate = rates.find((item) => item.id === e.target.value);
                  if (!rate) {
                    onChange({ rate_id: null });
                    return;
                  }
                  onChange({
                    rate_id: rate.id,
                    description: line.description.trim() ? line.description : rate.label,
                    unit: rate.unit,
                    unit_price_cents: rate.rateCents,
                  });
                }}
              >
                <option value="">Pick a rate…</option>
                {rates.map((rate) => (
                  <option key={rate.id} value={rate.id}>
                    {rate.label} · {formatMoneyCents(rate.rateCents)}/{rate.unit}
                  </option>
                ))}
              </select>
            )}
            {sections.length > 1 && (
              <select
                aria-label="Section"
                className={`${CELL_SELECT} text-xs text-muted-foreground`}
                value={line.section}
                onChange={(e) => onChange({ section: e.target.value })}
              >
                {sections.map((name) => (
                  <option key={name} value={name}>
                    {name || "No section"}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </td>
      <td className="py-1.5 pr-2">
        <NumberInput label="Quantity" value={line.quantity} toText={plain} fromText={Number} onCommit={(quantity) => onChange({ quantity })} />
      </td>
      <td className="py-1.5 pr-2">
        <Input
          aria-label="Unit"
          className={CELL_INPUT}
          value={line.unit}
          maxLength={20}
          onChange={(e) => onChange({ unit: e.target.value })}
        />
      </td>
      <td className="py-1.5 pr-2">
        <NumberInput
          label="Rate or unit cost in dollars"
          value={line.unit_price_cents}
          toText={dollars}
          fromText={(text) => Math.round(Number(text) * 100)}
          onCommit={(unit_price_cents) => onChange({ unit_price_cents, rate_id: null })}
        />
      </td>
      <td className="py-1.5 pr-2">
        <NumberInput label="Markup percent" max="500" value={line.markup_percent} toText={plain} fromText={Number} onCommit={(markup_percent) => onChange({ markup_percent })} />
      </td>
      <td className="py-2 pr-2 text-center">
        <Checkbox
          aria-label="Optional add-on"
          checked={line.optional}
          onCheckedChange={(checked) => onChange({ optional: checked === true })}
        />
      </td>
      <td className={`py-2 pr-2 text-right tabular-nums ${line.optional ? "text-muted-foreground" : ""}`}>
        {formatMoneyCents(amount)}
      </td>
      <td className="py-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" onClick={onRemove}>
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

function SendDialog({
  open,
  onOpenChange,
  estimateId,
  email,
  totalCents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  email: string;
  totalCents: number;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ emailSent: boolean; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await sendTradeQuoteAction({
        estimate_id: estimateId,
        message: message.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setSent(result.data);
      router.refresh();
    });
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setSent(null);
      setCopied(false);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{sent ? "Sent" : "Send to customer"}</DialogTitle>
          <DialogDescription>
            {sent
              ? sent.emailSent
                ? `Emailed to ${email}.`
                : "The email did not go out. Share the review link yourself."
              : `${formatMoneyCents(totalCents)} to ${email}, with a link to review and accept it.`}
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="space-y-3">
            {!sent.emailSent && (
              <div className="flex gap-2">
                <Input readOnly aria-label="Review link" value={sent.url} onFocus={(e) => e.currentTarget.select()} />
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(sent.url);
                      setCopied(true);
                    } catch {
                      setError("Copy the link by hand.");
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="quote-message">Message (optional)</Label>
              <Textarea
                id="quote-message"
                value={message}
                maxLength={2000}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Thanks for the opportunity. Here is our price."
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Sending…" : "Send quote"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReuseDialog({
  onOpenChange,
  onPick,
}: {
  onOpenChange: (open: boolean) => void;
  onPick: (lines: QuoteLine[], mode: "replace" | "add") => void;
}) {
  const [quotes, setQuotes] = useState<ReusableQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Mounted only while open, so this loads the list each time the dialog is opened.
  useEffect(() => {
    let live = true;
    listReusableQuotesAction().then((result) => {
      if (!live) return;
      if (result.success) setQuotes(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, []);

  function choose(id: string, mode: "replace" | "add") {
    setError(null);
    startTransition(async () => {
      const result = await getQuoteLinesForReuseAction({ estimate_id: id });
      if (!result.success) {
        setError(result.error);
        return;
      }
      onPick(result.data, mode);
      onOpenChange(false);
    });
  }

  let body: ReactNode;
  if (quotes === null) {
    body = <p className="py-6 text-center text-sm text-muted-foreground">{error ?? "Loading quotes…"}</p>;
  } else if (quotes.length === 0) {
    body = <p className="py-6 text-center text-sm text-muted-foreground">No past quotes to copy yet.</p>;
  } else {
    body = (
      <ul className="max-h-80 divide-y overflow-y-auto border-y">
        {quotes.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {item.opportunity} · {format(new Date(item.createdAt), "MMM d, yyyy")} ·{" "}
                <span className="tabular-nums">{formatMoneyCents(item.totalCents)}</span>
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => choose(item.id, "replace")}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => choose(item.id, "add")}>
                Add
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy lines from a past quote</DialogTitle>
          <DialogDescription>Replace the current lines, or add the past quote&apos;s lines to them.</DialogDescription>
        </DialogHeader>
        {body}
        {error && quotes !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
