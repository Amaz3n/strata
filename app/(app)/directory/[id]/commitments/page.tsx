// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { CommitmentRegister } from "@/components/companies/account/commitment-register";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import {
  getCompanyCommitmentRegister,
  type CommitmentRegisterFlag,
  type CommitmentType,
} from "@/lib/services/commitments";
import { listCostCodes } from "@/lib/services/cost-codes";
import { listProjects } from "@/lib/services/projects";
import { loadVendorCompanyHeader, registerDirectoryTabCache } from "../page-data";

type CommitmentSearch = {
  type?: string;
  status?: string;
  project?: string;
  flag?: string;
  page?: string;
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<CommitmentSearch>;
}

const TYPES: CommitmentType[] = ["subcontract", "purchase_order"];
const FLAGS: CommitmentRegisterFlag[] = [
  "over_billed",
  "awaiting_execution",
  "pending_change_orders",
];

function parseTypes(value?: string): CommitmentType[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .filter((entry): entry is CommitmentType => TYPES.includes(entry as CommitmentType));
  return parsed.length > 0 ? parsed : undefined;
}

function parseFlag(value?: string): CommitmentRegisterFlag | undefined {
  return FLAGS.includes(value as CommitmentRegisterFlag)
    ? (value as CommitmentRegisterFlag)
    : undefined;
}

export default function CompanyCommitmentsPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={8} flush summaryFigures={4} />}>
      <CompanyCommitmentsData {...props} />
    </Suspense>
  );
}

async function CompanyCommitmentsData({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const query = (await searchParams) ?? {};

  return <CompanyCommitmentsContent id={id} query={query} />;
}

async function CompanyCommitmentsContent({
  id,
  query,
}: {
  id: string;
  query: CommitmentSearch;
}) {
  "use cache: private";
  registerDirectoryTabCache(id, "commitments");

  const account = await loadVendorCompanyHeader(id);
  // Null means: not a company, or a company with no vendor role.
  if (!account) redirect(`/directory/${id}`);

  // Projects and cost codes only feed the create dialog, so a failure there must
  // not take the register down with it.
  const [register, projects, costCodes] = await Promise.all([
    getCompanyCommitmentRegister(id, {
      types: parseTypes(query.type),
      statuses: query.status?.split(",").filter(Boolean),
      projectId: query.project,
      flag: parseFlag(query.flag),
      page: Number(query.page) || 1,
    }),
    account.canEdit ? listProjects().catch(() => []) : Promise.resolve([]),
    account.canEdit ? listCostCodes().catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <CommitmentRegister
      companyId={id}
      companyName={account.name}
      rows={register.rows}
      rollup={register.rollup}
      exceptions={register.exceptions}
      pagination={register.pagination}
      facets={register.facets}
      truncated={register.truncated}
      projects={projects}
      costCodes={costCodes}
      canEdit={account.canEdit}
    />
  );
}
