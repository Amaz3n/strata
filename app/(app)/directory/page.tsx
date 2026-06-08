import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { DirectoryClient } from "@/components/directory/directory-client";
import {
  listDirectoryPage,
  listDirectoryTrades,
  type DirectorySortDirection,
  type DirectorySortKey,
  type DirectoryView,
} from "@/lib/services/directory";

import { requireOrgContext } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

interface DirectoryPageProps {
  searchParams: Promise<{
    view?: string;
    q?: string;
    type?: string;
    trade?: string;
    sort?: string;
    direction?: string;
    page?: string;
  }>;
}

function resolveView(value?: string): DirectoryView {
  return value === "companies" || value === "people" ? value : "all";
}

function resolveSort(value?: string): DirectorySortKey {
  return value === "type" || value === "detail" || value === "contact"
    ? value
    : "name";
}

function resolveDirection(value?: string): DirectorySortDirection {
  return value === "desc" ? "desc" : "asc";
}

function resolvePage(value?: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

async function DirectoryData({ searchParams }: DirectoryPageProps) {
  const { orgId } = await requireOrgContext();
  const resolvedSearchParams = await searchParams;
  const view = resolveView(resolvedSearchParams?.view);
  const search =
    typeof resolvedSearchParams?.q === "string"
      ? resolvedSearchParams.q.trim()
      : "";
  const typeFilter =
    typeof resolvedSearchParams?.type === "string"
      ? resolvedSearchParams.type
      : "all";
  const tradeFilter =
    typeof resolvedSearchParams?.trade === "string"
      ? resolvedSearchParams.trade
      : "all";
  const sort = resolveSort(resolvedSearchParams?.sort);
  const direction = resolveDirection(resolvedSearchParams?.direction);
  const page = resolvePage(resolvedSearchParams?.page);

  const [directoryPage, trades, permissionResult] = await Promise.all([
    listDirectoryPage({
      view,
      page,
      pageSize: PAGE_SIZE,
      search,
      type: typeFilter,
      trade: tradeFilter,
      sort,
      direction,
    }),
    listDirectoryTrades(),
    getCurrentUserPermissions(),
  ]);

  const permissions = permissionResult?.permissions ?? [];
  const canEdit =
    permissions.includes("org.member") ||
    permissions.includes("directory.write");
  const canDelete =
    permissions.includes("org.admin") || permissions.includes("members.manage");

  return (
    <DirectoryClient
      key={orgId}
      companies={directoryPage.companies}
      contacts={directoryPage.contacts}
      canCreate={canEdit}
      canDelete={canDelete}
      view={view}
      search={search}
      typeFilter={typeFilter}
      tradeFilter={tradeFilter}
      sort={sort}
      direction={direction}
      page={directoryPage.page}
      pageSize={directoryPage.pageSize}
      total={directoryPage.total}
      trades={trades}
    />
  );
}

function DirectorySkeleton() {
  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-y px-4 py-3">
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-10 w-10" />
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function DirectoryPage(props: DirectoryPageProps) {
  return (
    <PageLayout
      title="Directory"
      breadcrumbs={[{ label: "Company" }, { label: "Directory" }]}
      fullBleed
    >
      <Suspense fallback={<DirectorySkeleton />}>
        <DirectoryData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  );
}
