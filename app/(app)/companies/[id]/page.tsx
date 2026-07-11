import { notFound } from "next/navigation";
import { PageLayout } from "@/components/layout/page-layout";
import { unwrapAction } from "@/lib/action-result"

export const dynamic = "force-dynamic";

import { z } from "zod";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import {
  getClientCompanyReceivables,
  getCompany,
  getCompanyProjects,
} from "@/lib/services/companies";
import { listCompanyCommitments } from "@/lib/services/commitments";
import { listVendorBillsForCompany } from "@/lib/services/vendor-bills";
import { getDirectoryIntelligenceForCompanies } from "@/lib/services/directory-intelligence";
import { listProjectsAction } from "@/app/(app)/projects/actions";
import { CompanyDetailPage } from "@/components/companies/company-detail-page";
import { getLatestPrequalification } from "@/lib/services/prequalification";

interface CompanyDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyDetailPageRoute({
  params,
}: CompanyDetailPageProps) {
  const { id: companyId } = await params;
  if (!z.string().uuid().safeParse(companyId).success) {
    notFound();
  }

  const [company, projectHistory, projects, permissionResult, prequalification] = await Promise.all([
    getCompany(companyId),
    getCompanyProjects(companyId),
    listProjectsAction(),
    getCurrentUserPermissions(),
    getLatestPrequalification(companyId),
  ]);

  const isClientCompany = company.company_type === "client";
  const isVendorCompany =
    company.company_type === "subcontractor" ||
    company.company_type === "supplier";
  const emptyIntelligence: Awaited<
    ReturnType<typeof getDirectoryIntelligenceForCompanies>
  > = { scorecardsByCompanyId: {}, taxReadinessByCompanyId: {} };
  const [commitments, vendorBills, clientReceivables, intelligence] =
    await Promise.all([
      isClientCompany ? Promise.resolve([]) : listCompanyCommitments(companyId),
      isClientCompany ? Promise.resolve([]) : listVendorBillsForCompany(companyId),
      isClientCompany
        ? getClientCompanyReceivables(companyId)
        : Promise.resolve(null),
      isVendorCompany
        ? getDirectoryIntelligenceForCompanies([companyId]).catch(() => emptyIntelligence)
        : Promise.resolve(emptyIntelligence),
    ]);

  const vendorScorecard = intelligence.scorecardsByCompanyId[companyId] ?? null;
  const vendorTaxReadiness =
    intelligence.taxReadinessByCompanyId[companyId] ?? null;

  const permissions = permissionResult?.permissions ?? [];
  const canEdit =
    permissions.includes("org.member") ||
    permissions.includes("directory.write");
  const canArchive = canEdit;

  const breadcrumbs = [
    { label: "Directory", href: "/directory" },
    { label: "Companies", href: "/directory?view=companies" },
    { label: company.name },
  ];

  return (
    <PageLayout title={company.name} breadcrumbs={breadcrumbs} fullBleed>
      <CompanyDetailPage
        company={company}
        projectHistory={projectHistory}
        commitments={commitments}
        vendorBills={vendorBills}
        clientReceivables={clientReceivables}
        vendorScorecard={vendorScorecard}
        vendorTaxReadiness={vendorTaxReadiness}
        projects={projects}
        canEdit={canEdit}
        canArchive={canArchive}
        prequalification={prequalification}
      />
    </PageLayout>
  );
}
