import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { DealPlans } from "@/components/pipeline/deal-plans";
import { DealWithoutProject } from "@/components/pipeline/deal-without-project";
import { DealPlansSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealPlans } from "@/lib/services/precon-deals";
import { getPreconProjectId } from "@/lib/services/precon-workspace";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ sourceFile?: string }>;
};

export const instant = { unstable_disableBuildValidation: true };

async function loadPlans(dealId: string, sourceFile: string | undefined) {
  "use cache: private";
  cacheLife("deal");
  const projectId = await getPreconProjectId(dealId);
  return projectId ? { projectId, data: await getDealPlans(dealId, projectId, sourceFile) } : null;
}

async function Plans({ params, searchParams }: Props) {
  const [{ dealId }, query] = await Promise.all([params, searchParams]);
  const plans = await loadPlans(dealId, query.sourceFile);
  if (!plans) return <DealWithoutProject tab="plans" />;
  return <DealPlans data={plans.data} projectId={plans.projectId} />;
}

/** The deal's plans: the sheets its lines are measured from. They become the job's drawings when it starts. */
export default function DealPlansPage(props: Props) {
  return (
    <Suspense fallback={<DealPlansSkeleton />}>
      <Plans {...props} />
    </Suspense>
  );
}
