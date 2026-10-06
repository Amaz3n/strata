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
import { listPipelineDeals } from "@/lib/services/precon-deals";

async function PipelineDeals() {
  await connection();
  const [productTier, profile, data, permissions] = await Promise.all([
    getOrgProductTier(),
    getBusinessProfile(),
    listPipelineDeals(),
    getCurrentUserPermissions(),
  ]);
  // Production builders sell lots from the Sales desk, which owns those deals.
  if (productTier === "production" && profile.kind !== "trade") redirect("/sales");
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
