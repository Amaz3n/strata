// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { PrequalificationWorkspace } from "@/components/companies/account/prequalification-workspace";
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents";
import { getPrequalificationPackage } from "@/lib/services/prequalification";
import { loadVendorCompany } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyPrequalificationPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadVendorCompany(id);
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
      companyName={account.company.name}
      data={data}
      documentTypes={documentTypes}
      canEdit={account.canEdit}
      canReview={account.canReviewPrequal}
    />
  );
}
