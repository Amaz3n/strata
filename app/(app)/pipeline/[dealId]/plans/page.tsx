import { connection } from "next/server"
import { redirect } from "next/navigation";
import ProjectDrawingsPage from "@/components/drawings/project-drawings-page";
import { getPreconProjectId } from "@/lib/services/precon-workspace";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{
    set?: string;
    sheetId?: string;
    condition?: string;
    sourceFile?: string;
    estimate?: string;
    destination?: string;
    target?: string;
    row?: string;
    takeoff?: string;
  }>;
};

export const instant = { unstable_disableBuildValidation: true };

/** The deal's plans, open over the pipeline. A deal only has plans once pricing starts. */
export default function DealPlansPage(props: Props) {
  return (
    <Suspense fallback={
      <PageLayout title="Plans & quantities" fullBleed>
        <div className="space-y-4 p-6" role="status" aria-label="Loading plans">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-40" />)}
          </div>
        </div>
      </PageLayout>
    }>
      <DealPlansData {...props} />
    </Suspense>
  );
}

async function DealPlansData({ params, searchParams }: Props) {
  await connection()
  const { dealId } = await params;
  const projectId = await getPreconProjectId(dealId);
  if (!projectId) redirect(`/pipeline/${dealId}`);
  return (
    <ProjectDrawingsPage
      prospectId={dealId}
      params={Promise.resolve({ id: projectId })}
      searchParams={searchParams}
    />
  );
}
