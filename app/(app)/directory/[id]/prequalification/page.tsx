// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PrequalificationWorkspace } from "@/components/companies/account/prequalification-workspace";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents";
import { getPrequalificationPackage } from "@/lib/services/prequalification";
import { loadVendorCompanyHeader, registerDirectoryTabCache } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CompanyPrequalificationPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={7} flush />}>
      <CompanyPrequalificationData {...props} />
    </Suspense>
  );
}

async function CompanyPrequalificationData({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return <CompanyPrequalificationContent id={id} />;
}

async function CompanyPrequalificationContent({ id }: { id: string }) {
  "use cache: private";
  registerDirectoryTabCache(id, "prequalification");

  const account = await loadVendorCompanyHeader(id);
  // Null means: not a company, or a company with no vendor role.
  if (!account) redirect(`/directory/${id}`);

  // Document types feed the program editor and name the document rows; losing
  // them should not take the tab down with them.
  const [data, documentTypes] = await Promise.all([
    getPrequalificationPackage(id),
    listComplianceDocumentTypes().catch(() => []),
  ]);

  return (
    <PrequalificationWorkspace
      companyId={id}
      companyName={account.name}
      data={data}
      documentTypes={documentTypes}
      canEdit={account.canEdit}
      canReview={account.canReviewPrequal}
    />
  );
}
