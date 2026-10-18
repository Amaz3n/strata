import type { ReactNode } from "react"
import { getCutoverReconciliation, type CutoverSection } from "@/lib/services/cutover/reconciliation"
import { formatMoneyCentsExact } from "@/lib/utils"

const FIGURE_LABEL: Record<string, string> = {
  deposits_cents: "Deposits",
  selections: "Selections",
  selections_total_cents: "Selections total",
  change_order_balance_cents: "Change-order balance",
  inspections: "Inspections",
}

const show = (key: string, value: number) => (key.endsWith("_cents") ? formatMoneyCentsExact(value) : value.toLocaleString("en-US"))

function Figure({ label, value, tone }: { label: string; value: string; tone?: "bad" | "good" }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-base font-medium tabular-nums ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-success" : "text-foreground"}`}>{value}</p>
    </div>
  )
}

function Section({ title, description, section, extra }: { title: string; description: string; section: CutoverSection; extra?: ReactNode }) {
  const keys = Object.keys(section.sourceTotals)
  return (
    <div className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {extra}
        <Figure label="Homes stated" value={section.homes.toLocaleString("en-US")} />
        <Figure label="Matching" value={section.matched.toLocaleString("en-US")} tone={section.homes > 0 && section.mismatchCount === 0 ? "good" : undefined} />
        <Figure label="Differences" value={section.mismatchCount.toLocaleString("en-US")} tone={section.mismatchCount > 0 ? "bad" : undefined} />
        {keys.map((key) => <Figure key={key} label={`${FIGURE_LABEL[key] ?? key}: source / Arc`} value={`${show(key, section.sourceTotals[key])} / ${show(key, section.arcTotals[key])}`} tone={section.sourceTotals[key] !== section.arcTotals[key] ? "bad" : undefined} />)}
      </div>
      {section.truncated ? <p className="text-xs text-warning">More records than one report reads; these figures cover part of the import.</p> : null}
      {section.homes === 0 ? <p className="text-sm text-muted-foreground">Nothing imported yet.</p> : section.mismatchCount === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Home</th>
                <th className="py-2 pr-4 font-medium">Figure</th>
                <th className="py-2 pr-4 text-right font-medium">Source</th>
                <th className="py-2 text-right font-medium">Arc</th>
              </tr>
            </thead>
            <tbody>
              {section.mismatches.flatMap((item) => item.differences.map((key) => (
                <tr key={`${item.projectId}-${key}`} className="border-b last:border-0">
                  <td className="py-2 pr-4 text-foreground">{item.home}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{FIGURE_LABEL[key] ?? key}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{show(key, item.source[key])}</td>
                  <td className="py-2 text-right tabular-nums text-destructive">{show(key, item.arc[key])}</td>
                </tr>
              )))}
            </tbody>
          </table>
          {section.mismatchCount > section.mismatches.length ? <p className="pt-2 text-xs text-muted-foreground">Showing the first {section.mismatches.length} of {section.mismatchCount.toLocaleString("en-US")} homes with differences.</p> : null}
        </div>
      )}
    </div>
  )
}

/** Every cutover record against what the source stated, by home, for the sections the viewer may see. Reloading re-runs it. */
export async function CutoverReconciliation() {
  const report = await getCutoverReconciliation()
  const { agreements, selections, inspections, warranty } = report
  if (!agreements && !selections && !inspections && !warranty) return null
  return (
    <section className="mt-8 space-y-4" aria-label="Cutover reconciliation">
      <div>
        <h2 className="text-sm font-medium text-foreground">Cutover reconciliation</h2>
        <p className="mt-1 text-xs text-muted-foreground">What the previous system stated for each home against what Arc now holds.</p>
      </div>
      {agreements ? (
        <Section title="Agreements and deposits" description="Imported agreements by evidence, and each home's deposits as the signed-agreements file states them against deposits received in Arc." section={agreements}
          extra={<>
            <Figure label="Imported agreements" value={agreements.imported.toLocaleString("en-US")} />
            <Figure label="Executed copy on file" value={agreements.executed.toLocaleString("en-US")} />
            <Figure label="Accepted without file" value={agreements.accepted.toLocaleString("en-US")} />
            <Figure label="Awaiting review" value={agreements.evidenceMissing.toLocaleString("en-US")} tone={agreements.evidenceMissing > 0 ? "bad" : undefined} />
            {agreements.unlinkedOpeningDeposits !== null && agreements.unlinkedOpeningDeposits > 0 ? <Figure label="Opening deposits with no home" value={agreements.unlinkedOpeningDeposits.toLocaleString("en-US")} tone="bad" /> : null}
          </>} />
      ) : null}
      {selections ? <Section title="Selections and change orders" description="Each home's selection count, selections total and change-order balance from the latest home-totals file, against Arc." section={selections} /> : null}
      {inspections ? <Section title="Inspection history" description="Past inspections each home's source files list, against the history records Arc holds." section={inspections} /> : null}
      {warranty ? (
        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">Homes under warranty</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Closed homes against their coverage; open Homes under warranty for the findings.</p>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Figure label="Closed homes" value={warranty.homes.toLocaleString("en-US")} />
            <Figure label="Covered" value={warranty.covered.toLocaleString("en-US")} />
            <Figure label="Active" value={warranty.active.toLocaleString("en-US")} />
            <Figure label="Expired" value={warranty.expired.toLocaleString("en-US")} />
            <Figure label="Exceptions" value={warranty.exceptionCount.toLocaleString("en-US")} tone={warranty.exceptionCount > 0 ? "bad" : warranty.clean && warranty.homes > 0 ? "good" : undefined} />
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function CutoverReconciliationSkeleton() {
  return (
    <div className="mt-8 space-y-4" aria-hidden>
      <div className="h-4 w-48 animate-pulse bg-muted" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-10 animate-pulse bg-muted" />)}
      </div>
    </div>
  )
}
