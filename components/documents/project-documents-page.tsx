import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProjectDocumentsSkeleton } from "@/components/documents/project-documents-skeleton";
import { PageLayout } from "@/components/layout/page-layout";
import { getProjectAction } from "@/app/(app)/projects/[id]/actions";
import { loadDocumentsViewAction } from "@/app/(app)/documents/actions";
import { UnifiedDocumentsLayout } from "@/components/documents";

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ path?: string }>;
}

export default function ProjectFilesPage({ params, searchParams }: ProjectFilesPageProps) {
  return (
    <PageLayout title="Documents" fullBleed>
      <div data-instant-shell="project-documents" className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <Suspense fallback={<ProjectDocumentsSkeleton />}>
            <ProjectFilesData params={params} searchParams={searchParams} />
          </Suspense>
        </div>
      </div>
    </PageLayout>
  );
}

async function ProjectFilesData({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ path?: string }>;
}) {
  await connection();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const project = await getProjectAction(id);

  if (!project) {
    notFound();
  }

  const normalizedPath = query.path?.trim() ? query.path : undefined;

  const view = await loadDocumentsViewAction({
    projectId: id,
    filters: {
      folder_path: normalizedPath,
      root_only: normalizedPath ? undefined : true,
      limit: 100,
      offset: 0,
    },
    childFolderPath: normalizedPath,
  });
  const folders = view.childFolders ?? [];

  return (
    <UnifiedDocumentsLayout
      preconstruction={project.phase === "precon"}
      project={{ id: project.id, name: project.name }}
      initialFiles={view.files}
      initialTotalCount={view.totalCount}
      initialHasMore={view.hasMore}
      initialCounts={view.counts ?? {}}
      initialFolders={folders.map((folder) => folder.path)}
      initialFolderCounts={Object.fromEntries(
        folders.map((folder) => [folder.path, folder.itemCount]),
      )}
      initialFolderPermissions={view.folderPermissions ?? []}
      initialPath={query.path}
    />
  );
}
