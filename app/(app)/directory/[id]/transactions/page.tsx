// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { VendorTransactionsTable } from "@/components/companies/account/vendor-transactions-table";
import {
  getVendorAccountLedger,
  type VendorLedgerEntryKind,
} from "@/lib/services/vendor-account";
import { loadCompanyAccount, loadCostCodesEnabledForProjects } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    kind?: string;
    status?: string;
    project?: string;
    filter?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
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

export default async function CompanyTransactionsPage({ params, searchParams }: PageProps) {
  // Aging is relative to today, so render at request time.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  if (account.posture !== "vendor") redirect(`/directory/${id}`);

  const query = (await searchParams) ?? {};
  const ledger = await getVendorAccountLedger(id, undefined, {
    kinds: parseKinds(query.kind),
    statuses: query.status?.split(",").filter(Boolean),
    projectId: query.project,
    overdueOnly: query.filter === "overdue",
    from: query.from,
    to: query.to,
    page: Number(query.page) || 1,
  });

  // Cost coding is a per-project setting, and this register spans projects, so
  // the rows on this page carry the right answer into the detail workspace.
  const costCodesEnabledByProject = await loadCostCodesEnabledForProjects(
    Array.from(
      new Set(ledger.entries.map((entry) => entry.project_id).filter((v): v is string => !!v)),
    ),
  );

  return (
    <VendorTransactionsTable
      companyId={id}
      companyName={account.company.name}
      entries={ledger.entries}
      pagination={ledger.pagination}
      facets={ledger.facets}
      truncated={ledger.truncated}
      canViewBills={ledger.summary.can_view_bills}
      costCodesEnabledByProject={costCodesEnabledByProject}
    />
  );
}
