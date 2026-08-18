// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CompanyCommitments } from "@/components/companies/company-commitments";
import { listCompanyCommitments } from "@/lib/services/commitments";
import { listProjectsAction } from "@/app/(app)/projects/actions";
import { loadCompanyAccount } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyCommitmentsPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  if (account.posture !== "vendor") redirect(`/directory/${id}`);

  const [commitments, projects] = await Promise.all([
    listCompanyCommitments(id),
    listProjectsAction(),
  ]);

  return (
    <div className="px-4 py-6 sm:px-6">
      <CompanyCommitments
        companyId={id}
        commitments={commitments}
        projects={projects}
        canEdit={account.canEdit}
        stagger={1}
        expanded
      />
    </div>
  );
}
