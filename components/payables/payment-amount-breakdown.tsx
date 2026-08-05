import { cn } from "@/lib/utils"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

export interface PaymentAmounts {
  vendorAmountCents: number
  processorFeeCents: number
  platformFeeCents: number
  totalDebitCents: number
}

/**
 * What this payment costs, split so nobody has to infer it.
 *
 * The preparer and the approver see the identical breakdown — the fintech
 * gameplan's whole control model rests on an approver knowing exactly what they
 * released, and "fees" as one lumped number hides which part is Arc's.
 *
 * The debit and the fees are deliberately in separate blocks. They used to be
 * summed into one "debited from your bank" figure, which is what made the bank
 * feed line disagree with the accounting entry on every payment. Fees now ride
 * their own per-run debit, so adding them to this figure would describe a
 * movement of money that does not happen.
 *
 * Provider cost and Arc fee are always both shown, including at zero: a fee line
 * that disappears when it is nothing teaches people not to look for it.
 */
export function PaymentAmountBreakdown({
  amounts,
  className,
  passThroughProcessorFees = true,
}: {
  amounts: PaymentAmounts
  className?: string
  passThroughProcessorFees?: boolean
}) {
  // Arc absorbs the provider's cost when the org is not on pass-through, so it
  // is shown for transparency but never reaches their invoice.
  const billedProcessorFeeCents = passThroughProcessorFees ? amounts.processorFeeCents : 0
  const accruedCents = billedProcessorFeeCents + amounts.platformFeeCents

  const feeRows = [
    {
      label: "Provider processing cost",
      value: amounts.processorFeeCents,
      hint: passThroughProcessorFees ? "Passed through at cost" : "Absorbed by Arc",
    },
    {
      label: "Arc fee",
      value: amounts.platformFeeCents,
      hint: amounts.platformFeeCents === 0 ? "No Arc markup on this payment" : null,
    },
  ]

  return (
    <dl className={cn("text-sm", className)}>
      <div className="flex items-baseline justify-between gap-4 py-1.5">
        <dt className="text-muted-foreground">Vendor receives</dt>
        <dd className="font-mono tabular-nums">{money(amounts.vendorAmountCents)}</dd>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-4 border-t pt-2">
        <dt className="font-medium">
          Debited from your bank
          <span className="ml-2 text-xs font-normal text-muted-foreground">Exactly what the vendor receives</span>
        </dt>
        <dd className="font-mono font-medium tabular-nums">{money(amounts.totalDebitCents)}</dd>
      </div>

      <div className="mt-4 border-t pt-2">
        <p className="microlabel">Collected separately · not part of this debit</p>
        {feeRows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="text-muted-foreground">
              {row.label}
              {row.hint ? <span className="ml-2 text-xs text-muted-foreground/80">{row.hint}</span> : null}
            </dt>
            <dd className="font-mono tabular-nums text-muted-foreground">{money(row.value)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t pt-2">
          <dt className="text-muted-foreground">Arc fee debit for this run</dt>
          <dd className="font-mono tabular-nums">{money(accruedCents)}</dd>
        </div>
      </div>
    </dl>
  )
}
