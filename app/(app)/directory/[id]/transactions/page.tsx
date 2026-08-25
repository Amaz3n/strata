// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { VendorTransactionsTable } from "@/components/companies/account/vendor-transactions-table";
import {
  getVendorAccountLedger,
  type VendorLedgerEntryKind,
} from "@/lib/services/vendor-account";
import { VendorAccountSummaryStrip } from "@/components/directory/account/vendor-account-summary-strip";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import {
  loadCostCodesEnabledForProjects,
  loadVendorCompanyHeader,
  loadVendorLedger,
  registerDirectoryTabCache,
} from "../page-data";

type TransactionSearch = {
  kind?: string;
  status?: string;
  project?: string;
  filter?: string;
  from?: string;
  to?: string;
  page?: string;
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<TransactionSearch>;
}

const KINDS: VendorLedgerEntryKind[] = ["bill", "vendor_credit", "payment", "expense"];

function parseKinds(value?: string): VendorLedgerEntryKind[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .filter((entry): entry is VendorLedgerEntryKind =>
      KINDS.includes(entry as VendorLedgerEntryKind),
    );
  return parsed.length > 0 ? parsed : undefined;
}

export default function CompanyTransactionsPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={8} flush summaryFigures={4} />}>
      <CompanyTransactionsData {...props} />
    </Suspense>
  );
}

async function CompanyTransactionsData({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const query = (await searchParams) ?? {};

  return <CompanyTransactionsContent id={id} query={query} />;
}

async function CompanyTransactionsContent({
  id,
  query,
}: {
  id: string;
  query: TransactionSearch;
}) {
  "use cache: private";
  registerDirectoryTabCache(id, "transactions");

  const hasFilters = Boolean(
    query.kind || query.status || query.project || query.filter || query.from || query.to ||
      (Number(query.page) || 1) > 1,
  );

  // The layout already built the unfiltered ledger for this company to compute
  // its tab badges, and `loadVendorLedger` caches it per request. Re-running a
  // full four-source, 500-row-per-source build for an unfiltered view meant
  // every visit to this tab paid for the same work twice.
  const accountPromise = loadVendorCompanyHeader(id);
  const ledgerPromise = hasFilters
    ? getVendorAccountLedger(id, undefined, {
        kinds: parseKinds(query.kind),
        statuses: query.status?.split(",").filter(Boolean),
        projectId: query.project,
        overdueOnly: query.filter === "overdue",
        from: query.from,
        to: query.to,
        page: Number(query.page) || 1,
      })
    : loadVendorLedger(id);
  const [account, ledger] = await Promise.all([accountPromise, ledgerPromise]);
  // Null means: not a company, or a company with no vendor role.
  if (!account) redirect(`/directory/${id}`);

  // Cost coding is a per-project setting, and this register spans projects, so
  // the rows on this page carry the right answer into the detail workspace.
  const costCodesEnabledByProject = await loadCostCodesEnabledForProjects(
    Array.from(
      new Set(ledger.entries.map((entry) => entry.project_id).filter((v): v is string => !!v)),
    ),
  );

  return (
    <>
      <VendorAccountSummaryStrip
        companyId={id}
        summary={ledger.summary}
        accounting={ledger.accounting}
        books={ledger.books}
        truncated={ledger.truncated}
      />
      <VendorTransactionsTable
        companyId={id}
        companyName={account.name}
        entries={ledger.entries}
        pagination={ledger.pagination}
        facets={ledger.facets}
        truncated={ledger.truncated}
        canViewBills={ledger.summary.can_view_bills}
        costCodesEnabledByProject={costCodesEnabledByProject}
      />
    </>
  );
}
