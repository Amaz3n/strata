import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import {
  getCompaniesComplianceStatus,
  listPendingComplianceReviews,
} from "@/lib/services/compliance-documents";
import { getCompaniesPrequalificationSummary } from "@/lib/services/prequalification";
import type { PartyKind } from "@/lib/directory/roles";
import { canEditDirectory } from "@/lib/directory/permissions";
import type { DirectoryVendorData } from "@/lib/directory/vendor-data";
import { terminology } from "@/lib/terminology";
import { DirectoryClient } from "@/components/directory/directory-client";
import {
  listComplianceWatchCompanies,
  listDirectoryInitialPages,
  type DirectoryPageWindow,
  type DirectorySortDirection,
  type DirectorySortKey,
} from "@/lib/services/directory";

import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context";

const PAGE_SIZE = 25;

// This page owns a useful shell and keeps runtime data behind Suspense, so
// Next.js 16.3 can validate and prefetch it as an Instant Navigation target.
export const instant = true;

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

async function loadVendorData(
  directoryPagePromise: Promise<DirectoryPageWindow>,
  context: OrgServiceContext,
): Promise<DirectoryVendorData> {
  // The watch list starts alongside the core rows, but none of this work gates
  // the toolbar or table. The client consumes this promise in small Suspense
  // boundaries and treats pending/failed data as unknown, never as all-clear.
  const watchPromise = listComplianceWatchCompanies(200, context).then(
    (value) => ({ ok: true as const, value }),
    () => ({
      ok: false as const,
      value: {
        companies: [] as Array<{ id: string; name: string }>,
        total: 0,
        truncated: false,
      },
    }),
  );
  const [directoryPage, watchResult] = await Promise.all([
    directoryPagePromise,
    watchPromise,
  ]);

  const companyIdsOnPage = directoryPage.entries
    .filter((entry) => entry.kind === "company" && entry.role_categories.includes("vendor"))
    .map((entry) => entry.id);
  const statusCompanyIds = Array.from(
    new Set([
      ...watchResult.value.companies.map((company) => company.id),
      ...companyIdsOnPage,
    ]),
  );

  const [complianceResult, prequalificationResult, reviewQueueResult] = await Promise.all([
    getCompaniesComplianceStatus(statusCompanyIds, context.orgId).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: {} }),
    ),
    getCompaniesPrequalificationSummary(statusCompanyIds, context.orgId).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: {} }),
    ),
    // Org-wide and independent of which vendors this page loaded: a document
    // waiting on a decision is work whether or not its vendor is on screen.
    listPendingComplianceReviews(context.orgId).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: null }),
    ),
  ]);

  return {
    complianceStatusByCompanyId: complianceResult.value,
    prequalificationByCompanyId: prequalificationResult.value,
    complianceWatchCompanies: watchResult.value.companies,
    complianceReviewQueue: reviewQueueResult.value,
    complianceWatchTruncated: watchResult.value.truncated,
    complianceWatchTotal: watchResult.value.total,
    statusUnavailable:
      !watchResult.ok ||
      !complianceResult.ok ||
      !prequalificationResult.ok ||
      !reviewQueueResult.ok,
  };
}

async function DirectoryData({ searchParams }: DirectoryPageProps) {
  const [context, resolved] = await Promise.all([requireOrgContext(), searchParams]);
  const { orgId, productTier } = context;

  const kind = resolveKind(resolved?.kind);
  const search = typeof resolved?.q === "string" ? resolved.q.trim() : "";
  const roleFilter = typeof resolved?.role === "string" ? resolved.role : "all";
  const tradeFilter = typeof resolved?.trade === "string" ? resolved.trade : "all";
  const sort = resolveSort(resolved?.sort);
  const direction = resolveDirection(resolved?.direction);

  const sharedInput = {
    page: 1,
    pageSize: PAGE_SIZE,
    search,
    sort,
    direction,
  } as const;
  const initialPagesPromise = listDirectoryInitialPages(
    {
      company: {
        ...sharedInput,
        kind: "company",
        role: kind === "company" ? roleFilter : "all",
        trade: kind === "company" ? tradeFilter : "all",
      },
      contact: {
        ...sharedInput,
        kind: "contact",
        role: kind === "contact" ? roleFilter : "all",
        trade: "all",
      },
    },
    context,
  );
  const companyPagePromise = initialPagesPromise.then((pages) => pages.company);
  const vendorData = loadVendorData(companyPagePromise, context);
  const [initialPages, permissionResult] = await Promise.all([
    initialPagesPromise,
    getCurrentUserPermissions(orgId),
  ]);
  const directoryPage = initialPages[kind];

  const currentPageKey = [
    kind,
    search,
    roleFilter,
    tradeFilter,
    sort,
    direction,
  ].join("|");
  const alternateKind: PartyKind = kind === "company" ? "contact" : "company";
  const alternatePageKey = [
    alternateKind,
    search,
    "all",
    "all",
    sort,
    direction,
  ].join("|");

  const canEdit = canEditDirectory(permissionResult?.permissions ?? []);

  return (
    <DirectoryClient
      key={orgId}
      entries={directoryPage.entries}
      total={directoryPage.total}
      pageSize={directoryPage.pageSize}
      relationshipTypes={initialPages.relationshipTypes}
      initialPageCache={{
        [currentPageKey]: directoryPage,
        [alternatePageKey]: initialPages[alternateKind],
      }}
      vendorData={vendorData}
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
      trades={initialPages.trades}
    />
  );
}

function DirectorySkeleton() {
  return (
    <div
      data-instant-shell="directory"
      className="flex min-h-full flex-col bg-background"
    >
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
