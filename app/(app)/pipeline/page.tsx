import { Suspense, cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PageLayout } from "@/components/layout/page-layout";
import { PipelineOverview } from "@/components/pipeline/pipeline-overview";
import { PipelineOverviewSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { LeadIntakeBand, LeadIntakeBandError, LeadIntakeBandSkeleton } from "@/components/sales/lead-intake-band";
import { shouldShowCustomBuildNavigation } from "@/lib/product-tier";
import { getBusinessProfile } from "@/lib/services/business-profile";
import { getOrgProductTier } from "@/lib/services/context";
import { listLeadAttention } from "@/lib/services/lead-intake";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { listPipelineDeals } from "@/lib/services/precon-deals";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";
import { listTeamMembers } from "@/lib/services/team";

/** Production builders sell lots from the Sales desk, unless the org also runs custom work. */
const resolvePipelineAccess = cache(async () => {
  const [productTier, hasActiveNonProductionProjects, profile] = await Promise.all([
    getOrgProductTier(),
    orgHasActiveNonProductionProjects(),
    getBusinessProfile(),
  ]);
  const customBuildNavigation = shouldShowCustomBuildNavigation(productTier, hasActiveNonProductionProjects);
  if (!customBuildNavigation && profile.kind !== "trade") redirect("/sales");
  return { customBuildNavigation, trade: profile.kind === "trade" };
});

async function PipelineTitle() {
  await connection();
  const { trade } = await resolvePipelineAccess();
  return <PageLayout title={trade ? "Opportunities" : "Pipeline"} />;
}

/** Website leads that need a person. Absent when nothing waits. */
async function PipelineLeadIntake() {
  await connection();
  const { customBuildNavigation } = await resolvePipelineAccess();
  const attention = await listLeadAttention({ desk: "pipeline", customBuildNavigation }).catch(() => null);
  return attention ? <LeadIntakeBand attention={attention} /> : <LeadIntakeBandError />;
}

async function PipelineDeals() {
  await connection();
  await resolvePipelineAccess();
  const [data, members, permissions] = await Promise.all([
    listPipelineDeals(),
    listTeamMembers(undefined, { includeProjectCounts: false }),
    getCurrentUserPermissions(),
  ]);
  const granted = permissions?.permissions ?? [];
  return (
    <PipelineOverview
      data={data}
      members={members
        .filter((member) => member.status === "active")
        .map((member) => ({
          id: member.user.id,
          name: member.user.full_name || member.user.email,
          avatarUrl: member.user.avatar_url ?? null,
        }))}
      currentUserId={permissions?.userId ?? null}
      canCreate={["pipeline.write", "sales.manage", "*"].some((key) => granted.includes(key))}
      now={new Date().toISOString()}
    />
  );
}

export default function PipelinePage() {
  return (
    <>
      <Suspense fallback={null}>
        <PipelineTitle />
      </Suspense>
      <div className="desk-rise mx-auto w-full max-w-[calc(50%+36rem)] space-y-5">
        <Suspense fallback={<LeadIntakeBandSkeleton />}>
          <PipelineLeadIntake />
        </Suspense>
        <Suspense fallback={<PipelineOverviewSkeleton />}>
          <PipelineDeals />
        </Suspense>
      </div>
    </>
  );
}
