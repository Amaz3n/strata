import Link from "next/link";
import type { TimesheetGridWorker } from "@/lib/time/timesheet";
import { formatLocalDate } from "@/lib/utils";

const hours = (value: number) => (value ? value.toFixed(2).replace(/\.?0+$/, "") : "—");

function Total({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground">{label} </span>
      <span className={value && tone ? `font-medium ${tone}` : "font-medium"}>{hours(value)}</span>
    </span>
  );
}

function WorkerBlock({ worker, days }: { worker: TimesheetGridWorker; days: string[] }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2">
        <h3 className="text-sm font-semibold">{worker.workerName}</h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <Total label="Reg" value={worker.regular} />
          <Total label="OT" value={worker.overtime} tone="text-warning" />
          <Total label="DT" value={worker.doubleTime} tone="text-destructive" />
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums text-warning">{worker.waiting} waiting</span>
          <span className="tabular-nums text-success">{worker.approved} approved</span>
          {worker.rejected > 0 && (
            <span className="tabular-nums text-destructive">{worker.rejected} sent back</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-y text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 text-left font-medium">Job</th>
              {days.map((day) => (
                <th key={day} className="w-14 px-1 py-2 text-right font-medium tabular-nums">
                  <span className="block">{formatLocalDate(day, "EEE")}</span>
                  <span className="block">{formatLocalDate(day, "d")}</span>
                </th>
              ))}
              <th className="w-16 pl-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {worker.rows.length ? (
              worker.rows.map((row) => (
                <tr key={row.projectId} className="hover:bg-muted/30">
                  <td className="py-2 pr-4">
                    <Link href={`/projects/${row.projectId}/time`} className="hover:underline">
                      {row.projectName}
                    </Link>
                  </td>
                  {days.map((day) => (
                    <td
                      key={day}
                      className={`px-1 text-right tabular-nums ${row.byDay[day] ? "" : "text-muted-foreground/50"}`}
                    >
                      {hours(row.byDay[day] ?? 0)}
                    </td>
                  ))}
                  <td className="pl-3 text-right font-medium tabular-nums">{hours(row.total)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={days.length + 2} className="py-2 text-xs text-muted-foreground">
                  No hours counted this period.
                </td>
              </tr>
            )}
          </tbody>
          {worker.rows.length > 1 && (
            <tfoot className="border-t">
              <tr className="text-xs text-muted-foreground">
                <td className="py-2 pr-4 font-medium">Day total</td>
                {days.map((day) => (
                  <td key={day} className="px-1 text-right tabular-nums">
                    {hours(worker.dayTotals[day] ?? 0)}
                  </td>
                ))}
                <td className="pl-3 text-right font-medium tabular-nums text-foreground">
                  {hours(worker.hours)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// Hours only: rates never reach this component. Rejected entries are counted
// as "sent back" and never as hours.
export function TimesheetWeekGrid({
  grid,
  days,
  truncated,
  entryCap,
}: {
  grid: TimesheetGridWorker[];
  days: string[];
  truncated: boolean;
  entryCap: number;
}) {
  if (!grid.length) {
    return (
      <div className="py-6">
        <h3 className="text-sm font-semibold">No time this period</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Hours appear here once someone clocks in or logs time on a job.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {grid.map((worker) => (
        <WorkerBlock key={worker.key} worker={worker} days={days} />
      ))}
      {truncated && (
        <p className="text-xs text-warning">
          This period has more than {entryCap} entries. Showing the first {entryCap} by date, so
          totals here are incomplete. Narrow to a single job to see the rest.
        </p>
      )}
    </div>
  );
}
