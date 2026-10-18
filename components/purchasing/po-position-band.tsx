import Link from "next/link"

import { PO_POSITION_EXCEPTION_LABELS } from "@/lib/purchasing/po-position"
import type { PoPositionRow } from "@/lib/services/po-positions"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)

/**
 * Purchase orders whose billed and paid amounts disagree with what they
 * authorize. The desk only reports; the fix is the purchase order's own action
 * on its home's workbench.
 */
export function PoPositionBand({ rows, total, truncated }: { rows: PoPositionRow[]; total: number; truncated: boolean }) {
  if (total === 0) return null
  return (
    <div className="border-b bg-destructive/5 px-4 py-3">
      <p className="text-sm font-medium">
        {total} purchase {total === 1 ? "order does" : "orders do"} not reconcile{truncated ? " (first part of a very large scope)" : ""}
      </p>
      <ul className="mt-2 grid gap-x-6 gap-y-1 lg:grid-cols-2">
        {rows.map((row) => (
          <li key={row.commitmentId} className="flex items-baseline justify-between gap-3 border-b py-1 text-xs last:border-b-0">
            <Link className="min-w-0 truncate font-medium underline underline-offset-4" href={`/projects/${row.projectId}/financials/budget`}>
              {row.projectName ?? "Home"} · {row.contractNumber ?? row.title}
            </Link>
            <span className="shrink-0 text-destructive">
              {row.exceptions.map((exception) => `${PO_POSITION_EXCEPTION_LABELS[exception.kind]} ${money(exception.cents)}`).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {total > rows.length && <p className="mt-1 text-xs text-muted-foreground">Showing {rows.length} of {total}. Open a home to see the rest.</p>}
    </div>
  )
}
