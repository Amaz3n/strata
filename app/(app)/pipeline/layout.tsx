import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PipelineList } from "@/components/pipeline/pipeline-list";
import { PipelineListSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { PipelineShell } from "@/components/pipeline/pipeline-shell";
import { getBusinessProfile } from "@/lib/services/business-profile";
import { getOrgProductTier } from "@/lib/services/context";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { shouldShowCustomBuildNavigation } from "@/lib/product-tier";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";
import { listPipelineDeals } from "@/lib/services/precon-deals";

async function PipelineDeals() {
  await connection();
  const [productTier, hasActiveNonProductionProjects, profile, data, permissions] = await Promise.all([
    getOrgProductTier(),
    orgHasActiveNonProductionProjects(),
    getBusinessProfile(),
    listPipelineDeals(),
    getCurrentUserPermissions(),
  ]);
  // Production builders sell lots from the Sales desk, which owns those deals —
  // unless the org also runs custom work, which still sells through the pipeline.
  if (!shouldShowCustomBuildNavigation(productTier, hasActiveNonProductionProjects) && profile.kind !== "trade") {
    redirect("/sales");
  }
  const granted = permissions?.permissions ?? [];
  return (
    <PipelineList
      data={data}
      canCreate={granted.includes("org.member") || granted.includes("*")}
      now={new Date().toISOString()}
    />
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
