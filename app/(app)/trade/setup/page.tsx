import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { TradeCompanySetup } from "@/components/trade/company-setup";
import { getBusinessProfile } from "@/lib/services/business-profile";
import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";

async function Setup() {
  await connection();
  const context = await requireOrgContext();
  await requirePermission("org.admin", context);
  const profile = await getBusinessProfile();
  return (
    <PageLayout title="Company setup">
      <TradeCompanySetup profile={profile} />
    </PageLayout>
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Company setup"><PageLoadingSkeleton /></PageLayout>}>
      <Setup />
    </Suspense>
  );
}
