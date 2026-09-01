import { notFound } from "next/navigation";

import { getProjectAction } from "@/app/(app)/projects/[id]/actions";
import { BudgetSnapshotComparison } from "@/components/financials/budget-snapshot-comparison";
import { PageLayout } from "@/components/layout/page-layout";
import { listBudgetSnapshots } from "@/lib/services/budgets";
import { listCostCodes } from "@/lib/services/cost-codes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ForecastHistoryPage({ params }: PageProps) {
  const { id } = await params;
  const [project, snapshots, costCodes] = await Promise.all([
    getProjectAction(id),
    listBudgetSnapshots(id),
    listCostCodes(),
  ]);
  if (!project) notFound();

  return (
    <PageLayout
      title="Forecast History"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Reports", href: `/projects/${project.id}/reports` },
        { label: "Forecast History" },
      ]}
      fullBleed
    >
      <div className="desk-rise mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <BudgetSnapshotComparison
          projectId={project.id}
          snapshots={snapshots}
          costCodes={costCodes}
        />
      </div>
    </PageLayout>
  );
}
