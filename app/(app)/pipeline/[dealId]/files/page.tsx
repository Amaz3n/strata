import { connection } from "next/server"
import { redirect } from "next/navigation";
import ProjectDocumentsPage from "@/components/documents/project-documents-page";
import { getPreconProjectId } from "@/lib/services/precon-workspace";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { ProjectDocumentsSkeleton } from "@/components/documents/project-documents-skeleton";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ path?: string }>;
};

export const instant = { unstable_disableBuildValidation: true };

/** The deal's files, open over the pipeline. They become the job's files when it starts. */
export default function DealFilesPage(props: Props) {
  return (
    <Suspense fallback={
      <PageLayout title="Files" fullBleed>
        <ProjectDocumentsSkeleton />
      </PageLayout>
    }>
      <DealFilesData {...props} />
    </Suspense>
  );
}

async function DealFilesData({ params, searchParams }: Props) {
  await connection()
  const { dealId } = await params;
  const projectId = await getPreconProjectId(dealId);
  if (!projectId) redirect(`/pipeline/${dealId}`);
  return (
    <ProjectDocumentsPage
      prospectId={dealId}
      params={Promise.resolve({ id: projectId })}
      searchParams={searchParams}
    />
  );
}
