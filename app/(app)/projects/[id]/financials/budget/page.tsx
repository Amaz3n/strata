import { Suspense } from "react";
import { notFound } from "next/navigation";

import {
  getProjectAction,
  getProjectContractAction,
} from "@/app/(app)/projects/[id]/actions";
import { fetchBudgetTabDataAction } from "@/app/(app)/projects/[id]/financials/actions";
import { BudgetTab } from "@/components/financials/budget/budget-tab";
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner";
import { PageLayout } from "@/components/layout/page-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup";
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model";
import { hasPermission } from "@/lib/services/permissions";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FinancialsBudgetPage({ params }: PageProps) {
  const { id } = await params;

  return (
    <Suspense fallback={<FinancialsBudgetSkeleton />}>
      <FinancialsBudgetData id={id} />
    </Suspense>
  );
}

async function FinancialsBudgetData({ id }: { id: string }) {
  const [project, contract, data, setupStatus, canWrite] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
    fetchBudgetTabDataAction(id),
    getProjectFinancialSetupStatusForProject(id),
    hasPermission("budget.write"),
  ]);
  if (!project) notFound();

  const featureConfig = getProjectFinancialFeatureConfig(project, contract);

  return (
    <PageLayout
      title="Budget"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Budget" },
      ]}
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <BudgetTab
        projectId={project.id}
        project={project}
        contractValueCents={contract?.total_cents ?? 0}
        budgetData={data.budgetData}
        costCodes={data.costCodes}
        costCodesEnabled={setupStatus.costCodesEnabled}
        varianceAlerts={data.varianceAlerts}
        budgetBucketCompanies={data.budgetBucketCompanies}
        buyoutStatus={data.buyoutStatus}
        loadErrors={data.errors}
        budgetTransfers={data.budgetTransfers}
        canWrite={canWrite}
        lockAfterBaseline={featureConfig.lockBudgetLinesAfterBaseline}
      />
    </PageLayout>
  );
}

/** Skeleton mirroring the real layout: KPI strip, controls bar, table rows. */
function FinancialsBudgetSkeleton() {
  return (
    <PageLayout
      title="Budget"
      breadcrumbs={[
        { label: "Project" },
        { label: "Financials" },
        { label: "Budget" },
      ]}
    >
      <div className="-mx-4 -mt-6 flex flex-col bg-card">
        <div className="grid grid-cols-2 border-b lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 border-b border-r px-4 py-4 even:border-r-0 lg:border-b-0 lg:px-6 lg:even:border-r lg:last:border-r-0"
            >
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="ml-auto h-9 w-24" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex h-[60px] items-center gap-4 px-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-4 w-24" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}
