import { connection } from "next/server";
import { defaultTradeJobType, isTradeProfile } from "@/lib/business-profile";
import { NewTradeJob } from "@/components/trade/new-job";
import { getTradeJobCustomers } from "@/lib/services/trade-workspace";
import { WorkspaceLoading } from "@/components/layout/workspace-loading"
import { Suspense } from "react";
import { loadProjectDirectory } from "@/lib/services/project-directory";
import { projectDirectoryQuerySchema } from "@/lib/projects/directory";
import { ProjectsClient } from "./projects-client";
import { PageLayout } from "@/components/layout/page-layout";
import { Skeleton } from "@/components/ui/skeleton";

import { requireOrgContext } from "@/lib/services/context";

import { getBusinessProfile } from "@/lib/services/business-profile";
import { terminology } from "@/lib/terminology";

async function ProjectsData({
  params,
  context,
  profile,
}: {
  params: Promise<Record<string, string | undefined>>;
  context: Awaited<ReturnType<typeof requireOrgContext>>;
  profile: Awaited<ReturnType<typeof getBusinessProfile>>;
}) {
  const raw = await params;
  const query = projectDirectoryQuerySchema.parse(raw);
  const [data, tradeCustomers] = await Promise.all([
    loadProjectDirectory(query, context),
    isTradeProfile(profile) ? getTradeJobCustomers() : null,
  ]);
  return (
    <ProjectsClient
      key={`${context.orgId}:${data.divisionId ?? "all"}:${data.communityId ?? "all"}`}
      initialPage={data.page}
      initialQuery={query}
      productTier={context.productTier}
      businessProfile={profile}
      tradeCreateButton={tradeCustomers?.canManage ? <NewTradeJob contacts={tradeCustomers.contacts} contactsTotal={tradeCustomers.contactsTotal} defaultJobType={defaultTradeJobType(context.productTier)} /> : null}
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
  await connection();
  const [context, profile] = await Promise.all([requireOrgContext(), getBusinessProfile()]);
  return (
    <PageLayout title={terminology(context.productTier, profile).projects}>
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsData params={searchParams} context={context} profile={profile} />
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
    <Suspense fallback={<WorkspaceLoading destination="projects" />}>
      <ProjectsPageContent {...props} />
    </Suspense>
  )
}
