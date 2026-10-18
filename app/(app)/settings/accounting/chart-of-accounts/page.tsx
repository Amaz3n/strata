import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AccountingSection } from "@/components/settings/accounting-section";
import { SettingsPanelSkeleton } from "@/components/settings/settings-skeleton";
import { ChartOfAccounts } from "@/components/settings/chart-of-accounts";
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module";
import { getBooksWorkspace } from "@/lib/services/books/workspace";

async function ChartData() {
  await connection();
  if (!(await isBooksWorkspaceEnabled())) redirect("/settings?tab=accounting");
  const workspace = await getBooksWorkspace(undefined, "chart");
  return (
    <ChartOfAccounts
      accounts={workspace.accounts}
      canManage={workspace.capabilities.manage}
      asOf={workspace.asOf}
    />
  );
}

export default function ChartOfAccountsPage() {
  return (
    <AccountingSection title="Chart of accounts">
      <Suspense fallback={<SettingsPanelSkeleton />}>
        <ChartData />
      </Suspense>
    </AccountingSection>
  );
}
