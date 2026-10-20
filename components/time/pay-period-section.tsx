import { getPayPeriodSummary } from "@/lib/services/timesheets";
import type { PeriodSummaryLine } from "@/lib/time/timesheet";
import { formatLocalDate, formatMoneyCentsExact } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PayPeriodActions } from "@/components/time/pay-period-actions";

const hours = (value: number) => value.toFixed(2);

function SummaryTable({ title, lines, total }: { title: string; lines: PeriodSummaryLine[]; total: PeriodSummaryLine }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="border-y text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 text-left font-medium">{title}</th>
            <th className="px-3 text-right font-medium">Hours</th>
            <th className="px-3 text-right font-medium">Regular</th>
            <th className="px-3 text-right font-medium">OT</th>
            <th className="px-3 text-right font-medium">DT</th>
            <th className="pl-3 text-right font-medium">Labor cost</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => (
            <tr key={line.key} className="hover:bg-muted/30">
              <td className="py-2 pr-4">{line.label}</td>
              <td className="px-3 text-right tabular-nums">{hours(line.hours)}</td>
              <td className="px-3 text-right tabular-nums">{hours(line.regular)}</td>
              <td className="px-3 text-right tabular-nums">{hours(line.overtime)}</td>
              <td className="px-3 text-right tabular-nums">{hours(line.doubleTime)}</td>
              <td className="pl-3 text-right tabular-nums">{formatMoneyCentsExact(line.costCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t font-medium">
          <tr>
            <td className="py-2 pr-4">Total</td>
            <td className="px-3 text-right tabular-nums">{hours(total.hours)}</td>
            <td className="px-3 text-right tabular-nums">{hours(total.regular)}</td>
            <td className="px-3 text-right tabular-nums">{hours(total.overtime)}</td>
            <td className="px-3 text-right tabular-nums">{hours(total.doubleTime)}</td>
            <td className="pl-3 text-right tabular-nums">{formatMoneyCentsExact(total.costCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function importStatus(payrollImport: { status: string; reconciled: boolean }) {
  const status = payrollImport.status.replaceAll("_", " ");
  return payrollImport.reconciled ? `${status}, reconciled` : status;
}

// Approved hours and labor cost for a period, and the close and export controls.
// Cost is payroll data: the service requires time.close, so callers check first.
export async function PayPeriodSection({ period }: { period?: string }) {
  const data = await getPayPeriodSummary({ period: period ?? "current" });
  const { summary } = data;
  const closed = Boolean(data.closed);
  const blocker = !data.periodEnded
    ? `Period ends ${formatLocalDate(data.period.endsOn, "MMM d")}`
    : data.waiting > 0
      ? `${data.waiting} ${data.waiting === 1 ? "entry is" : "entries are"} still waiting`
      : null;
  return (
    <section className="space-y-4" aria-labelledby="pay-period-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="microlabel" id="pay-period-title">
            Pay period
          </p>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            {formatLocalDate(data.period.startsOn, "MMM d")} – {formatLocalDate(data.period.endsOn, "MMM d, yyyy")}
            {closed && data.closed ? (
              <span className="ml-2 font-medium text-success">
                Closed {formatLocalDate(data.closed.closed_at.slice(0, 10), "MMM d")}
              </span>
            ) : data.waiting > 0 ? (
              <span className="ml-2 font-medium text-warning">{data.waiting} waiting</span>
            ) : null}
          </p>
        </div>
        <PayPeriodActions startsOn={data.period.startsOn} closed={closed} blocker={blocker} />
      </div>
      {summary.byWorker.length ? (
        <div className="space-y-6">
          <SummaryTable
            title="Worker"
            lines={summary.byWorker}
            total={{ key: "total", label: "Total", ...summary.totals }}
          />
          <SummaryTable
            title="Job"
            lines={summary.byJob}
            total={{ key: "total", label: "Total", ...summary.totals }}
          />
        </div>
      ) : (
        <div className="py-4">
          <h3 className="text-sm font-semibold">No approved time yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Payroll counts approved and locked hours. Approve submitted time above.
          </p>
        </div>
      )}
      {data.truncated && (
        <p className="text-xs text-warning">
          This period has more entries than one summary can hold, so these totals are incomplete.
        </p>
      )}
      {data.payrollImport && (
        <p className="text-sm text-muted-foreground">
          Books payroll import: <span className="font-medium text-foreground capitalize">{importStatus(data.payrollImport)}</span>
        </p>
      )}
    </section>
  );
}

export function PayPeriodSectionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading pay period">
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}
