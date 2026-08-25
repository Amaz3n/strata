// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { CompanyContactsPanel } from "@/components/companies/account/company-contacts-panel";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import { listProjectSummariesAction } from "@/app/(app)/projects/actions";
import { listCompanyContactAccess } from "@/lib/services/portal-access";
import { loadDirectoryParty, registerDirectoryTabCache } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CompanyContactsPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={7} flush />}>
      <CompanyContactsData {...props} />
    </Suspense>
  );
}

async function CompanyContactsData({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return <CompanyContactsContent id={id} />;
}

async function CompanyContactsContent({ id }: { id: string }) {
  "use cache: private";
  registerDirectoryTabCache(id, "contacts");

  const account = await loadDirectoryParty(id);
  if (!account) notFound();
  // People do not have a contacts roster of their own; their own account is it.
  if (account.kind !== "company") redirect(`/directory/${id}`);

  const [projects, access] = await Promise.all([
    listProjectSummariesAction(),
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
