// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CompanyComplianceTab } from "@/components/companies/company-compliance-tab";
import { loadCompanyAccount } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyCompliancePage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  if (account.posture !== "vendor") redirect(`/directory/${id}`);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="desk-rise border bg-background">
        <CompanyComplianceTab company={account.company} />
      </div>
    </div>
  );
}
