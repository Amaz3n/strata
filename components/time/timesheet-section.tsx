import { getTimesheet } from "@/lib/services/timesheets";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeApprovalQueue } from "@/components/time/time-approval-queue";
import { TimesheetPeriodNav } from "@/components/time/timesheet-period-nav";
import { TimesheetWeekGrid } from "@/components/time/timesheet-week-grid";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// `?period=` is user input; anything that is not a date falls back to the current period.
export function periodParam(value: string | string[] | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  return first && ISO_DATE.test(first) ? first : undefined;
}

// The week grid and approval queue, for the whole crew or one job. Shared by
// /trade/crew and a job's Crew time tab.
export async function TimesheetSection({
  period,
  projectId,
  basePath,
  params,
}: {
  period?: string;
  projectId?: string;
  basePath: string;
  params?: Record<string, string>;
}) {
  const sheet = await getTimesheet({ period, projectId });
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="week-grid-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="microlabel" id="week-grid-title">
            Week grid
          </p>
          <TimesheetPeriodNav
            period={sheet.period}
            current={sheet.current}
            basePath={basePath}
            params={params}
          />
        </div>
        <TimesheetWeekGrid
          grid={sheet.grid}
          days={sheet.days}
          truncated={sheet.truncated}
          entryCap={sheet.entryCap}
        />
      </section>
      {sheet.canApprove && (
        <section className="space-y-3" aria-labelledby="approval-title">
          <p className="microlabel" id="approval-title">
            Approval queue
          </p>
          <TimeApprovalQueue queue={sheet.queue} />
        </section>
      )}
    </div>
  );
}

export function TimesheetSectionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading crew time">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-5 w-48" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}
