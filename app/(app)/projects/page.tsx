import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react";
import { loadProjectDirectory } from "@/lib/services/project-directory";
import { projectDirectoryQuerySchema } from "@/lib/projects/directory";
import { ProjectsClient } from "./projects-client";
import { PageLayout } from "@/components/layout/page-layout";
import { Skeleton } from "@/components/ui/skeleton";

import { requireOrgContext } from "@/lib/services/context";

import { terminology } from "@/lib/terminology";

async function ProjectsData({
  params,
}: {
  params: Promise<Record<string, string | undefined>>;
}) {
  const [context, raw] = await Promise.all([requireOrgContext(), params]);
  const query = projectDirectoryQuerySchema.parse(raw);
  const data = await loadProjectDirectory(query, context);
  return (
    <ProjectsClient
      key={`${context.orgId}:${data.divisionId ?? "all"}:${data.communityId ?? "all"}`}
      initialPage={data.page}
      initialQuery={query}
      productTier={context.productTier}
      communities={data.communities}
      communityId={data.communityId}
      canReadSchedule={data.canReadSchedule}
    />
  );
}

async function ProjectsPageContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await requireOrgContext();
  return (
    <PageLayout title={terminology(context.productTier).projects}>
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsData params={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-between items-center mb-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

export default function ProjectsPage(props: Parameters<typeof ProjectsPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <ProjectsPageContent {...props} />
    </Suspense>
  )
}
