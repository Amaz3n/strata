// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CompanyContactsPanel } from "@/components/companies/account/company-contacts-panel";
import { listProjectsAction } from "@/app/(app)/projects/actions";
import { listCompanyContactAccess } from "@/lib/services/portal-access";
import { loadDirectoryParty } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyContactsPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadDirectoryParty(id);
  if (!account) notFound();
  // People do not have a contacts roster of their own; their own account is it.
  if (account.kind !== "company") redirect(`/directory/${id}`);

  const [projects, access] = await Promise.all([
    listProjectsAction(),
    // Reachability decorates the roster; it must never be the reason the roster
    // fails to render. An empty map reads as "nobody has access" — which the UI
    // states as an invitation to send one, not as a claim about the vendor.
    listCompanyContactAccess(id).catch(() => new Map()),
  ]);

  return (
    <CompanyContactsPanel
      company={account.company}
      projects={projects}
      canEdit={account.canEdit}
      accessByContactId={Object.fromEntries(access)}
    />
  );
}
