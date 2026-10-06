import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { CrewWorkspace } from "@/components/trade/crew-workspace";
import { getTradeWorkspace } from "@/lib/services/trade-workspace";
import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";
async function Crew() {
  await connection();
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
    <PageLayout title="Schedule & crew">
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
    </PageLayout>
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Schedule & crew"><PageLoadingSkeleton /></PageLayout>}>
      <Crew />
    </Suspense>
  );
}
