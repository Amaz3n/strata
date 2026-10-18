import { getWarrantyInstalledBaseReconciliation } from "@/lib/services/warranty-installed-base"
import type { CoverageExceptionKind } from "@/lib/services/warranty/installed-base"

const KIND_LABEL: Record<CoverageExceptionKind, string> = {
  uncovered: "No coverage",
  covered_twice: "Covered twice",
  duplicate_lot: "Lot recorded twice",
  date_mismatch: "Start date differs",
  term_mismatch: "Term end differs",
}

function Figure({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-medium tabular-nums ${tone === "bad" ? "text-destructive" : "text-foreground"}`}>{value.toLocaleString("en-US")}</p>
    </div>
  )
}

/** Every closed home against its coverage; reloading the page re-runs it. */
export async function InstalledBaseReconciliation({ batchId }: { batchId?: string }) {
  const report = await getWarrantyInstalledBaseReconciliation(batchId)
  return (
    <section className="mt-8 space-y-4" aria-label="Coverage reconciliation">
      <div>
        <h2 className="text-sm font-medium text-foreground">Coverage reconciliation</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every closed home against its warranty coverage as of {report.asOf}. A clean report means no home is uncovered or covered twice and every coverage date is the closing date plus its term.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Figure label="Closed homes" value={report.homes} />
        <Figure label="Covered" value={report.covered} />
        <Figure label="Active" value={report.active} />
        <Figure label="Expired" value={report.expired} />
        <Figure label="Exceptions" value={report.exceptionCount} tone={report.exceptionCount > 0 ? "bad" : undefined} />
      </div>
      {report.clean ? (
        <p className="text-sm text-success">No coverage gaps, duplicates or date disagreements.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Home</th>
                <th className="py-2 pr-4 font-medium">Finding</th>
                <th className="py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.exceptions.map(item => (
                <tr key={`${item.projectId}-${item.kind}-${item.detail}`} className="border-b last:border-0">
                  <td className="py-2 pr-4 text-foreground">{item.home}</td>
                  <td className="py-2 pr-4 text-destructive">{KIND_LABEL[item.kind]}</td>
                  <td className="py-2 text-muted-foreground">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.exceptionCount > report.exceptions.length ? (
            <p className="pt-2 text-xs text-muted-foreground">Showing the first {report.exceptions.length} of {report.exceptionCount.toLocaleString("en-US")} exceptions.</p>
          ) : null}
        </div>
      )}
    </section>
  )
}

export function InstalledBaseReconciliationSkeleton() {
  return (
    <div className="mt-8 space-y-4" aria-hidden>
      <div className="h-4 w-48 animate-pulse bg-muted" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-10 animate-pulse bg-muted" />)}
      </div>
    </div>
  )
}
