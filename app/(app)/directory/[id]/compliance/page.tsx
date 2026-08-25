// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { ComplianceWorkspace } from "@/components/companies/account/compliance-workspace";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import {
  getComplianceHeldPayables,
  listComplianceDocumentTypes,
} from "@/lib/services/compliance-documents";
import { getComplianceRules } from "@/lib/services/compliance";
import { getCurrentUserPermissions } from "@/lib/services/permissions";
import {
  loadVendorCompanyHeader,
  loadComplianceStatus,
  registerDirectoryTabCache,
} from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CompanyCompliancePage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={7} flush />}>
      <CompanyComplianceData {...props} />
    </Suspense>
  );
}

async function CompanyComplianceData({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return <CompanyComplianceContent id={id} />;
}

async function CompanyComplianceContent({ id }: { id: string }) {
  "use cache: private";
  registerDirectoryTabCache(id, "compliance");

  const account = await loadVendorCompanyHeader(id);
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
      companyName={account.name}
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
