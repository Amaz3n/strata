"use client"

import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { cn } from "@/lib/utils"
import { dueSentence } from "../payables-ui"

interface PayableAmountProps {
  bill: VendorBillSummary
  isVendorCredit: boolean
  totalCents: number
  paidCents: number
  retainedCents: number
  balanceCents: number
  accountingProviderName?: string | null
  accountingEnabled: boolean
}

/**
 * The one number, at the size it deserves.
 *
 * The headline is whatever is still owed — that is the number an AP clerk is
 * actually acting on — and it falls back to the total once the payable is
 * settled. The four-column total/paid/retained/balance grid only earns its place
 * when there is genuinely more than one number to show; on the ordinary payable,
 * where nothing is paid and nothing is held, three of those four columns were
 * $0.00 and the grid was noise.
 */
export function PayableAmount({
  bill,
  isVendorCredit,
  totalCents,
  paidCents,
  retainedCents,
  balanceCents,
  accountingProviderName,
  accountingEnabled,
}: PayableAmountProps) {
  if (isVendorCredit) {
    return (
      <div className="shrink-0 px-6 pb-5 sm:px-8">
        <p className="font-mono text-[40px] font-medium leading-none tabular-nums tracking-tight">
          {formatMoneyFromCents(totalCents)}
        </p>
        <p className="mt-2.5 text-sm text-muted-foreground">
          Credit against this vendor — reduces project cost
          {accountingEnabled ? ` · managed in ${accountingProviderName ?? "accounting"}` : ""}
        </p>
      </div>
    )
  }

  const settled = balanceCents <= 0
  const headlineCents = settled ? totalCents : balanceCents
  const hasBreakdown = paidCents !== 0 || retainedCents !== 0
  const due = dueSentence(bill)

  return (
    <div className="shrink-0 px-6 pb-5 sm:px-8">
      <p
        className={cn(
          "font-mono text-[40px] font-medium leading-none tabular-nums tracking-tight",
          settled && "text-muted-foreground",
        )}
      >
        {formatMoneyFromCents(headlineCents)}
      </p>

      <p className="mt-2.5 text-sm text-muted-foreground">
        {settled ? "Settled in full" : due.text}
        {!settled && due.tail ? (
          <>
            {" · "}
            <span className={due.tailClassName}>{due.tail}</span>
          </>
        ) : null}
      </p>

      {hasBreakdown ? (
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
          {formatMoneyFromCents(totalCents)} billed
          {paidCents !== 0 ? ` − ${formatMoneyFromCents(paidCents)} paid` : ""}
          {retainedCents !== 0 ? ` − ${formatMoneyFromCents(retainedCents)} retained` : ""}
          {settled ? "" : ` = ${formatMoneyFromCents(balanceCents)}`}
        </p>
      ) : null}

      {bill.over_budget ? (
        <p className="mt-3 border-l-2 border-destructive py-0.5 pl-2.5 text-xs text-destructive">
          Exceeds the linked commitment. Check the contract balance before approving.
        </p>
      ) : null}
    </div>
  )
}
