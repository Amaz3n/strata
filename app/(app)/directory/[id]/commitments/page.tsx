// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CommitmentRegister } from "@/components/companies/account/commitment-register";
import {
  getCompanyCommitmentRegister,
  type CommitmentRegisterFlag,
  type CommitmentType,
} from "@/lib/services/commitments";
import { listCostCodes } from "@/lib/services/cost-codes";
import { listProjects } from "@/lib/services/projects";
import { loadCompanyAccount } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    type?: string;
    status?: string;
    project?: string;
    flag?: string;
    page?: string;
  }>;
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

export default async function CompanyCommitmentsPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  if (account.posture !== "vendor") redirect(`/directory/${id}`);

  const query = (await searchParams) ?? {};

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
      companyName={account.company.name}
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
