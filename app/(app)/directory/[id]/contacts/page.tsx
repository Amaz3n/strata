// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound } from "next/navigation";
import { z } from "zod";

import { CompanyContactsPanel } from "@/components/companies/account/company-contacts-panel";
import { listProjectsAction } from "@/app/(app)/projects/actions";
import { loadCompanyAccount } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyContactsPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();

  const projects = await listProjectsAction();

  return (
    <div className="px-4 py-6 sm:px-6">
      <CompanyContactsPanel
        company={account.company}
        projects={projects}
        canEdit={account.canEdit}
      />
    </div>
  );
}
