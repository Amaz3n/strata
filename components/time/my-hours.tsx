import type { MyHoursPeriod } from "@/lib/services/timesheets";
import { formatLocalDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { TimesheetWeekGrid } from "@/components/time/timesheet-week-grid";

function Period({ label, data }: { label: string; data: MyHoursPeriod }) {
  const sentBack = data.entries.filter((entry) => entry.status === "rejected");
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">
        {label}
        <span className="ml-2 font-normal text-muted-foreground tabular-nums">
          {formatLocalDate(data.period.startsOn, "MMM d")} – {formatLocalDate(data.period.endsOn, "MMM d")}
        </span>
      </h3>
      <TimesheetWeekGrid
        grid={data.grid ? [data.grid] : []}
        days={data.days}
        truncated={false}
        entryCap={0}
      />
      {sentBack.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-destructive">Sent back</p>
          <ul className="divide-y border-y text-sm">
            {sentBack.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2">
                <span>
                  <span className="tabular-nums">{formatLocalDate(entry.workDate, "EEE MMM d")}</span>
                  <span className="ml-2 text-muted-foreground">{entry.projectName}</span>
                  <span className="ml-2 tabular-nums">{entry.hours.toFixed(2)} h</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.rejectionReason ?? "No reason given"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MyHours({ current, previous }: { current: MyHoursPeriod; previous: MyHoursPeriod }) {
  return (
    <section className="space-y-6" aria-labelledby="my-hours-title">
      <p className="microlabel" id="my-hours-title">
        My hours
      </p>
      <Period label="This period" data={current} />
      <Period label="Last period" data={previous} />
    </section>
  );
}

export function MyHoursSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your hours">
      <Skeleton className="h-4 w-20" />
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}
