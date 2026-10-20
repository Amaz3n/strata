import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { TradeCompanySetup } from "@/components/trade/company-setup";
import { OwnComplianceVaultSection } from "@/components/trade/own-compliance-vault";
import { getBusinessProfile } from "@/lib/services/business-profile";
import { requireOrgContext } from "@/lib/services/context";
import { loadOwnComplianceVault } from "@/lib/services/own-compliance";
import { hasPermission, requirePermission } from "@/lib/services/permissions";
import { loadTimePolicy } from "@/lib/services/time-policy";

async function Setup() {
  await connection();
  const context = await requireOrgContext();
  const [isAdmin, canManage] = await Promise.all([
    hasPermission("org.admin", context),
    hasPermission("compliance.manage", context),
  ]);
  // Company setup is for admins; the vault is open to whoever keeps the
  // company's compliance papers, admin or not.
  if (!isAdmin && !canManage) await requirePermission("org.admin", context);
  // The vault is its own table with its own gate; failing to load it must not
  // take the rest of company setup down with it.
  const [setup, vault] = await Promise.all([
    isAdmin ? Promise.all([getBusinessProfile(), loadTimePolicy(context.orgId)]) : null,
    loadOwnComplianceVault(context.orgId).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({
        value: null,
        error: error instanceof Error ? error.message : "Could not load compliance documents.",
      }),
    ),
  ]);
  return (
    <PageLayout title="Company setup">
      {setup ? <TradeCompanySetup profile={setup[0]} timePolicy={setup[1].policy} /> : null}
      <div className={setup ? "mt-10 max-w-4xl" : "max-w-4xl"}>
        <OwnComplianceVaultSection vault={vault.value} loadError={vault.error} canManage={canManage} />
      </div>
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
