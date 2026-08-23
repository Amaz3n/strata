import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents";
import { getCompaniesPrequalificationSummary } from "@/lib/services/prequalification";
import { listProjects } from "@/lib/services/projects";
import type { PartyKind } from "@/lib/directory/roles";
import { canEditDirectory } from "@/lib/directory/permissions";
import { terminology } from "@/lib/terminology";
import { DirectoryClient } from "@/components/directory/directory-client";
import {
  listComplianceWatchCompanies,
  listDirectoryPage,
  listDirectoryTrades,
  type DirectorySortDirection,
  type DirectorySortKey,
} from "@/lib/services/directory";

import { requireOrgContext } from "@/lib/services/context";

const PAGE_SIZE = 25;

interface DirectoryPageProps {
  searchParams: Promise<{
    kind?: string;
    q?: string;
    role?: string;
    trade?: string;
    sort?: string;
    direction?: string;
  }>;
}

/** Companies is the default: it is the larger list and the operational unit. */
function resolveKind(value?: string): PartyKind {
  return value === "contact" ? "contact" : "company";
}

function resolveSort(value?: string): DirectorySortKey {
  return value === "detail" || value === "recent" ? value : "name";
}

function resolveDirection(value?: string): DirectorySortDirection {
  return value === "desc" ? "desc" : "asc";
}

async function DirectoryData({ searchParams }: DirectoryPageProps) {
  const { orgId, productTier } = await requireOrgContext();
  const resolved = await searchParams;

  const kind = resolveKind(resolved?.kind);
  const search = typeof resolved?.q === "string" ? resolved.q.trim() : "";
  const roleFilter = typeof resolved?.role === "string" ? resolved.role : "all";
  const tradeFilter = typeof resolved?.trade === "string" ? resolved.trade : "all";
  const sort = resolveSort(resolved?.sort);
  const direction = resolveDirection(resolved?.direction);

  const [directoryPage, trades, permissionResult, projects, watchList] =
    await Promise.all([
      listDirectoryPage({
        kind,
        page: 1,
        pageSize: PAGE_SIZE,
        search,
        role: roleFilter,
        trade: tradeFilter,
        sort,
        direction,
      }),
      listDirectoryTrades(),
      getCurrentUserPermissions(),
      listProjects().catch(() => []),
      listComplianceWatchCompanies().catch(() => ({
        companies: [] as Array<{ id: string; name: string }>,
        total: 0,
        truncated: false,
      })),
    ]);

  const canEdit = canEditDirectory(permissionResult?.permissions ?? []);

  // Status decorates vendor companies only, and only the ones actually on this
  // page plus the banner's watch list — the page used to load every
  // subcontractor and supplier in the org unpaginated just to feed the banner.
  const companyIdsOnPage = directoryPage.entries
    .filter((entry) => entry.kind === "company" && entry.role_categories.includes("vendor"))
    .map((entry) => entry.id);
  const statusCompanyIds = Array.from(
    new Set([...watchList.companies.map((company) => company.id), ...companyIdsOnPage]),
  );

  // A failed status read must not render as "everyone is compliant". The client
  // shows an unavailable state instead, because on this surface silence is
  // indistinguishable from an all-clear — and an all-clear releases payment.
  const [complianceResult, prequalificationResult] = await Promise.all([
    getCompaniesComplianceStatus(statusCompanyIds).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: {} }),
    ),
    getCompaniesPrequalificationSummary(statusCompanyIds).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: {} }),
    ),
  ]);

  return (
    <DirectoryClient
      key={orgId}
      entries={directoryPage.entries}
      total={directoryPage.total}
      pageSize={directoryPage.pageSize}
      relationshipTypes={directoryPage.relationshipTypes}
      complianceStatusByCompanyId={complianceResult.value}
      prequalificationByCompanyId={prequalificationResult.value}
      vendorStatusUnavailable={!complianceResult.ok || !prequalificationResult.ok}
      complianceWatchCompanies={watchList.companies}
      complianceWatchTruncated={watchList.truncated}
      complianceWatchTotal={watchList.total}
      projects={projects}
      terms={terminology(productTier)}
      showPrequalTrades={productTier === "commercial"}
      canCreate={canEdit}
      canArchive={canEdit}
      kind={kind}
      search={search}
      roleFilter={roleFilter}
      tradeFilter={tradeFilter}
      sort={sort}
      direction={direction}
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
