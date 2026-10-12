"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AFFECTED_HOME_STATE_LABELS, type AffectedHomeState } from "@/lib/plans/plan-change-impact"
import { productChangeHeadline } from "@/lib/plans/product-change-impact"
import type { ProductChangeImpactDto } from "@/lib/services/product-change-impact"
import { cn } from "@/lib/utils"

/** Sold homes carry the most risk, so they read loudest (as in the plan change review). */
const STATE_TONE: Record<AffectedHomeState, string> = {
  unsold: "text-muted-foreground",
  spec: "text-foreground",
  contracted: "text-chart-2",
  released: "text-warning",
}

function revisionLabel(revision: number | null) {
  return revision === null ? "—" : `r${revision}`
}

/**
 * The confirm step before an elevation or option definition is saved: which
 * homes the edit reaches, sold ones first. Saving still goes ahead — a sold
 * home keeps the revision and price its agreement and release recorded.
 */
export function ProductChangeImpactConfirm({
  impact,
  note,
  pending,
  onConfirm,
  onCancel,
}: {
  impact: ProductChangeImpactDto
  /** What this particular edit means for those homes, when it is more than a definition change (e.g. retiring the item). */
  note?: string | null
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const total = Object.values(impact.counts).reduce((sum, count) => sum + count, 0)
  return (
    <div className="space-y-2 border border-warning/40 bg-warning/5 p-3" role="alertdialog" aria-label={productChangeHeadline(impact, total)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium">{productChangeHeadline(impact, total)}</p>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {impact.label} · now r{impact.revision}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        The change saves for everyone. Sold and released homes keep the revision and price their agreement and release
        recorded; homes not yet sold, and every new sale, get the change.
        {note ? ` ${note}` : ""}
      </p>
      <div className="max-h-64 overflow-auto border bg-background">
        <table className="w-full min-w-[480px] text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">Home</th>
              <th className="px-2 py-1.5 font-medium">Buyer</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 text-right font-medium">Sold at</th>
              <th className="px-2 py-1.5 text-right font-medium">Released at</th>
            </tr>
          </thead>
          <tbody>
            {impact.homes.map((home) => (
              <tr key={home.key} className="border-b last:border-b-0">
                <td className="px-2 py-1.5">
                  {home.projectId ? (
                    <Link href={`/projects/${home.projectId}`} className="font-medium hover:underline">
                      {home.lotLabel ?? home.projectName}
                    </Link>
                  ) : (
                    <span className="font-medium">{home.lotLabel}</span>
                  )}
                  <span className="block text-[10px] text-muted-foreground">{home.communityName ?? home.projectName ?? "—"}</span>
                </td>
                <td className="px-2 py-1.5">{home.buyerName ?? <span className="text-muted-foreground">—</span>}</td>
                <td className={cn("px-2 py-1.5", STATE_TONE[home.state])}>{AFFECTED_HOME_STATE_LABELS[home.state]}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{revisionLabel(home.soldRevision)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{revisionLabel(home.releasedRevision)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {impact.homesElsewhere > 0 ? (
        <p className="text-xs text-muted-foreground">
          It also reaches {impact.homesElsewhere.toLocaleString()}
          {impact.homesElsewhereTruncated ? "+" : ""} {impact.homesElsewhere === 1 ? "home" : "homes"} in divisions you can&apos;t see.
        </p>
      ) : null}
      {impact.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          Showing the first {impact.homes.length.toLocaleString()} homes; more carry this item.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7 rounded-none text-xs" disabled={pending} onClick={onCancel}>
          Keep editing
        </Button>
        <Button type="button" size="sm" className="h-7 rounded-none text-xs" disabled={pending} onClick={onConfirm}>
          {pending ? "Saving…" : "Save change"}
        </Button>
      </div>
    </div>
  )
}
