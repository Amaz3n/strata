"use client";

import { Eye } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { FIRM_PRICE_SHARE, type PriceFirmness } from "@/lib/precon/deal-move";
import { money } from "@/lib/precon/format";
import { worksheetTotals, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import { cn } from "@/lib/utils";
import { FirmnessMark } from "./pricing-line-list";

type Terms = "markup_percent" | "contingency_percent" | "tax_rate";

/**
 * The price as a receipt: cost, what you add to it, and what the client pays,
 * then how much of it is real. Shown whenever no line is open.
 */
export function PricingSummary({
  worksheet,
  setTerm,
  firmness,
  signable,
  clientName,
  editable,
  onPreview,
}: {
  worksheet: PricingWorksheet;
  setTerm: (term: Terms, value: number) => void;
  firmness: PriceFirmness;
  signable: boolean;
  clientName: string;
  editable: boolean;
  onPreview: () => void;
}) {
  const totals = worksheetTotals(worksheet);
  const who = clientName.split(" ")[0] || "The client";
  const share = (value: number) => `${firmness.cost ? (value / firmness.cost) * 100 : 0}%`;
  const firmPercent = Math.round(firmness.firmShare * 100);
  const toGo = Math.max(0, Math.ceil(FIRM_PRICE_SHARE * firmness.cost - firmness.firm));
  const unpriced = firmness.unpriced;

  return (
    <div className="grid gap-4">
      <section aria-label="The price" className="border bg-card shadow-xs">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">The price</h2>
          <span className="text-xs text-muted-foreground">{signable ? "Fixed price, for signature" : "A range, for approval"}</span>
        </div>
        <dl className="px-4 pb-3.5 pt-1.5 text-[13px]">
          <Row label="Cost" value={money(totals.cost)} />
          <Row label="Your margin" term="markup_percent" worksheet={worksheet} setTerm={setTerm} editable={editable} value={money(totals.markup)} />
          <Row
            label="Contingency"
            term="contingency_percent"
            worksheet={worksheet}
            setTerm={setTerm}
            editable={editable}
            value={totals.contingency ? money(totals.contingency) : "—"}
          />
          <Row label="Tax" term="tax_rate" worksheet={worksheet} setTerm={setTerm} editable={editable} value={totals.tax ? money(totals.tax) : "—"} />
          <div className="mt-1.5 grid gap-0.5 border-t pt-3">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Client price</dt>
            <dd className="text-[28px] font-semibold tabular-nums tracking-tight">{money(totals.total)}</dd>
            <dd className="text-xs tabular-nums text-muted-foreground">
              {signable
                ? `${who} signs this number.`
                : `${who} sees ${money(firmness.range.low)} – ${money(firmness.range.high)}`}
              {unpriced ? `, plus ${unpriced} unpriced ${unpriced === 1 ? "line" : "lines"}` : ""}
            </dd>
          </div>
        </dl>
        <div className="px-4 pb-4">
          <Button variant="outline" className="w-full" onClick={onPreview}>
            <Eye className="size-3.5" />
            Preview {who === "The client" ? "the client's" : `${who}'s`} document
          </Button>
        </div>
      </section>

      <section aria-label="How firm it is" className="grid gap-2.5 border bg-card px-4 py-3.5 shadow-xs">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">How firm it is</h2>
          <span className={cn("text-sm font-semibold tabular-nums", firmness.firmShare >= FIRM_PRICE_SHARE && "text-success")}>
            {firmPercent}%
          </span>
        </div>
        <div className="flex h-2 overflow-hidden bg-muted" role="img" aria-label={`${firmPercent}% of cost is firm`}>
          <span className="h-full bg-success transition-[width] duration-200" style={{ width: share(firmness.firm) }} />
          <span className="h-full bg-muted-foreground/45 transition-[width] duration-200" style={{ width: share(firmness.allowance) }} />
          <span className="firmness-guess h-full transition-[width] duration-200" style={{ width: share(firmness.guess) }} />
        </div>
        <dl className="grid gap-1.5 text-xs">
          {(
            [
              ["firm", "Firm", firmness.firm],
              ["allowance", "Allowances", firmness.allowance],
              ["guess", "Your guesses", firmness.guess],
            ] as const
          ).map(([mark, label, value]) => (
            <div key={mark} className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-2">
              <FirmnessMark mark={mark} className="size-2.5" />
              <dt>{label}</dt>
              <dd className="font-mono tabular-nums">{money(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="bg-muted/60 px-2.5 py-2 text-xs">
          {firmness.firmShare >= FIRM_PRICE_SHARE ? (
            <>
              <strong className="text-success">A firm price.</strong> Most of the cost is quoted or measured.
            </>
          ) : (
            <>
              Firm up <strong className="tabular-nums">{money(toGo)}</strong> more with a quote or a measurement to call it a firm
              price.
            </>
          )}
        </p>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  term,
  worksheet,
  setTerm,
  editable,
}: {
  label: string;
  value: string;
  term?: Terms;
  worksheet?: PricingWorksheet;
  setTerm?: (term: Terms, value: number) => void;
  editable?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5">
      <dt className="flex items-center gap-2">
        {label}
        {term && worksheet && setTerm && (
          <label className="inline-flex h-6 items-center gap-0.5 border bg-background px-1.5 transition-colors duration-150 focus-within:border-primary hover:border-muted-foreground/40">
            <input
              aria-label={`${label} percent`}
              type="number"
              min="0"
              step="0.1"
              disabled={!editable}
              value={worksheet[term]}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 0) setTerm(term, next);
              }}
              className="w-10 bg-transparent text-right font-mono text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </label>
        )}
      </dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
