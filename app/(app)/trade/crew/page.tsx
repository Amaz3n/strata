import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { ClockCard } from "@/components/time/clock-card";
import { MyHours, MyHoursSkeleton } from "@/components/time/my-hours";
import { PayPeriodSection, PayPeriodSectionSkeleton } from "@/components/time/pay-period-section";
import {
  periodParam,
  TimesheetSection,
  TimesheetSectionSkeleton,
} from "@/components/time/timesheet-section";
import { CrewWorkspace } from "@/components/trade/crew-workspace";
import { Skeleton } from "@/components/ui/skeleton";
import { getTradeWorkspace } from "@/lib/services/trade-workspace";
import { requireOrgContext } from "@/lib/services/context";
import { hasPermission, requirePermission } from "@/lib/services/permissions";
import { getClockState } from "@/lib/services/time-clock";
import { getMyHours } from "@/lib/services/timesheets";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function ViewNav({ view }: { view: "schedule" | "time" }) {
  const link = (active: boolean) =>
    `border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
      active
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`;
  return (
    <nav aria-label="Crew views" className="flex gap-5 border-b">
      <Link href="/trade/crew" className={link(view === "schedule")} aria-current={view === "schedule" ? "page" : undefined}>
        Schedule
      </Link>
      <Link href="/trade/crew?view=time" className={link(view === "time")} aria-current={view === "time" ? "page" : undefined}>
        Time
      </Link>
    </nav>
  );
}

async function Clock() {
  if (!(await hasPermission("time.write"))) return null;
  const clock = await getClockState();
  return <ClockCard open={clock.open} jobs={clock.jobs} jobsTotal={clock.jobsTotal} />;
}

async function PayPeriod({ period }: { period?: string }) {
  if (!(await hasPermission("time.close"))) return null;
  return <PayPeriodSection period={period} />;
}

async function Hours() {
  const hours = await getMyHours();
  return <MyHours current={hours.current} previous={hours.previous} />;
}

async function Timesheet({ period }: { period?: string }) {
  if (!(await hasPermission("time.read"))) return null;
  return <TimesheetSection period={period} basePath="/trade/crew" params={{ view: "time" }} />;
}

function TimeView({ period }: { period?: string }) {
  return (
    <div className="space-y-10">
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <Clock />
      </Suspense>
      <Suspense fallback={<TimesheetSectionSkeleton />}>
        <Timesheet period={period} />
      </Suspense>
      <Suspense fallback={<PayPeriodSectionSkeleton />}>
        <PayPeriod period={period} />
      </Suspense>
      <Suspense fallback={<MyHoursSkeleton />}>
        <Hours />
      </Suspense>
    </div>
  );
}

async function Crew({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const query = await searchParams;
  const view = query.view === "time" ? "time" : "schedule";
  if (view === "time") {
    return (
      <div className="space-y-6 desk-rise">
        <ViewNav view={view} />
        <TimeView period={periodParam(query.period)} />
      </div>
    );
  }
  await requirePermission("schedule.read", await requireOrgContext());
  const {
    jobs,
    jobsTotal,
    work,
    workTotal,
    members,
    membersTotal,
    profile,
    canEditSchedule,
    canTime,
  } = await getTradeWorkspace();
  return (
    <div className="space-y-6">
      <ViewNav view={view} />
      <CrewWorkspace
        data={{
          jobs,
          jobsTotal,
          work,
          workTotal,
          members,
          membersTotal,
          profile,
          canEditSchedule,
          canTime,
        }}
      />
    </div>
  );
}

function CrewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading crew">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <PageLayout title="Schedule & crew">
      <Suspense fallback={<CrewSkeleton />}>
        <Crew searchParams={searchParams} />
      </Suspense>
    </PageLayout>
  );
}
