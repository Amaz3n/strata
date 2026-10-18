import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PipelineList } from "@/components/pipeline/pipeline-list";
import { LeadIntakeBand, LeadIntakeBandError } from "@/components/sales/lead-intake-band";
import { PipelineListSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { PipelineShell } from "@/components/pipeline/pipeline-shell";
import { getBusinessProfile } from "@/lib/services/business-profile";
import { getOrgProductTier } from "@/lib/services/context";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { shouldShowCustomBuildNavigation } from "@/lib/product-tier";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";
import { listPipelineDeals } from "@/lib/services/precon-deals";
import { listLeadAttention } from "@/lib/services/lead-intake";

async function PipelineDeals() {
  await connection();
  const [productTier, hasActiveNonProductionProjects, profile, permissions] = await Promise.all([
    getOrgProductTier(),
    orgHasActiveNonProductionProjects(),
    getBusinessProfile(),
    getCurrentUserPermissions(),
  ]);
  // Production builders sell lots from the Sales desk, which owns those deals —
  // unless the org also runs custom work, which still sells through the pipeline.
  const customBuildNavigation = shouldShowCustomBuildNavigation(productTier, hasActiveNonProductionProjects);
  if (!customBuildNavigation && profile.kind !== "trade") {
    redirect("/sales");
  }
  const granted = permissions?.permissions ?? [];
  const [data, attention] = await Promise.all([
    listPipelineDeals(),
    listLeadAttention({ desk: "pipeline", customBuildNavigation }).catch(() => null),
  ]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="max-h-[40%] shrink-0 overflow-y-auto">
        {attention ? <LeadIntakeBand attention={attention} compact /> : <LeadIntakeBandError />}
      </div>
      <div className="min-h-0 flex-1">
        <PipelineList
          data={data}
          canCreate={["pipeline.write", "sales.manage", "*"].some((key) => granted.includes(key))}
          now={new Date().toISOString()}
        />
      </div>
    </div>
  );
}

export default function PipelineLayout({ children }: { children: ReactNode }) {
  return (
    <PipelineShell
      list={
        <Suspense fallback={<PipelineListSkeleton />}>
          <PipelineDeals />
        </Suspense>
      }
    >
      {children}
    </PipelineShell>
  );
}
