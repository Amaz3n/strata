// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ComplianceWorkspace } from "@/components/companies/account/compliance-workspace";
import {
  getComplianceHeldPayables,
  listComplianceDocumentTypes,
} from "@/lib/services/compliance-documents";
import { getComplianceRules } from "@/lib/services/compliance";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import { loadVendorCompany, loadComplianceStatus } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyCompliancePage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadVendorCompany(id);
  // Null means: not a company, or a company with no vendor role.
  if (!account) redirect(`/directory/${id}`);

  // The tab is server-fed like every other tab on this page. It used to mount a
  // client component that refetched the status the layout had already loaded.
  const [status, documentTypes, held, rules, permissionResult] = await Promise.all([
    loadComplianceStatus(id),
    listComplianceDocumentTypes().catch(() => []),
    getComplianceHeldPayables(id).catch(() => ({ heldCents: 0, billCount: 0 })),
    getComplianceRules().catch(() => null),
    getCurrentUserPermissions(),
  ]);

  const permissions = permissionResult?.permissions ?? [];
  const canManage = permissions.includes("compliance.manage");
  const canReview = permissions.includes("compliance.review");

  return (
    <ComplianceWorkspace
      companyId={id}
      companyName={account.company.name}
      status={status}
      documentTypes={documentTypes}
      heldCents={held.heldCents}
      heldBillCount={held.billCount}
      canManage={canManage}
      canReview={canReview}
      blocksPayment={rules?.block_payment_on_missing_docs ?? true}
    />
  );
}
