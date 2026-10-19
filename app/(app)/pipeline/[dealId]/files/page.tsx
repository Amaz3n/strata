import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { DealFiles } from "@/components/pipeline/deal-files";
import { DealWithoutProject } from "@/components/pipeline/deal-without-project";
import { DealTabSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { loadDocumentsView } from "@/lib/services/files";
import { getPreconProjectId } from "@/lib/services/precon-workspace";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ path?: string }>;
};

export const instant = { unstable_disableBuildValidation: true };

/** One folder of the deal's files, cached in this browser like the deal's other tabs. */
async function loadFiles(dealId: string, path: string | undefined) {
  "use cache: private";
  cacheLife("deal");
  const projectId = await getPreconProjectId(dealId);
  if (!projectId) return null;
  const view = await loadDocumentsView({
    projectId,
    filters: { folder_path: path, root_only: path ? undefined : true, limit: 100, offset: 0 },
    childFolderPath: path,
  });
  return { projectId, view };
}

async function Files({ params, searchParams }: Props) {
  const [{ dealId }, query] = await Promise.all([params, searchParams]);
  const path = query.path?.trim() || undefined;
  const files = await loadFiles(dealId, path);
  if (!files) return <DealWithoutProject tab="files" />;
  return <DealFiles projectId={files.projectId} path={path} view={files.view} />;
}

/** The deal's files. Quotes and sent documents file themselves here; they become the job's files when it starts. */
export default function DealFilesPage(props: Props) {
  return (
    <Suspense fallback={<DealTabSkeleton />}>
      <Files {...props} />
    </Suspense>
  );
}
