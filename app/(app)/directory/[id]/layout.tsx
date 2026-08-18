import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PageLayout } from "@/components/layout/page-layout";
import { CompanyAccountHeader } from "@/components/companies/account/company-account-header";
import { CompanyAccountHeaderSkeleton } from "@/components/companies/account/company-account-skeleton";
import type { CompanyTab } from "@/components/companies/account/company-tab-nav";
import {
  loadCompanyAccount,
  loadComplianceStatus,
  loadPaymentReadiness,
  loadVendorIntelligence,
  loadVendorLedger,
} from "./page-data";

interface CompanyAccountLayoutProps {
  params: Promise<{ id: string }>;
  children: ReactNode;
}

// A fabricated company ID cannot pass authorization or existence checks, so the
// generic shell is what gets validated; real navigations are checked in dev.
export const instant = {
  unstable_disableBuildValidation: true,
};

/**
 * Everything here needs the request. It sits behind Suspense so the account
 * shell — chrome, gutters, and the region the tab renders into — paints
 * immediately and survives navigation between tabs.
 */
async function CompanyAccountHeaderData({
  params,
}: Pick<CompanyAccountLayoutProps, "params">) {
  // The ledger's aging math reads today's date.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  const { company, posture, canEdit, canArchive } = account;

  const [ledger, complianceStatus, intelligence, paymentReadiness] = await Promise.all([
    posture === "vendor" ? loadVendorLedger(id).catch(() => null) : Promise.resolve(null),
    posture === "vendor" ? loadComplianceStatus(id) : Promise.resolve(null),
    posture === "vendor"
      ? loadVendorIntelligence(id)
      : Promise.resolve({ scorecard: null, taxReadiness: null }),
    posture === "vendor" ? loadPaymentReadiness(id) : Promise.resolve(null),
  ]);

  const base = `/directory/${id}`;
  const summary = ledger?.summary.can_view_bills ? ledger.summary : null;
  const taxReadiness = intelligence.taxReadiness;

  // Attention lives on the tab that resolves it, so the header can stay one
  // identity line instead of a stack of banners.
  const w9NeedsAction =
    taxReadiness?.requires_1099 === true &&
    (taxReadiness.w9_status === "missing" || taxReadiness.w9_status === "rejected");
  const complianceNeedsAction = complianceStatus ? !complianceStatus.is_compliant : false;
  const complianceSevere =
    (complianceStatus?.missing.length ?? 0) > 0 || (complianceStatus?.expired.length ?? 0) > 0;

  const complianceAttentionLabel = complianceNeedsAction
    ? [
        complianceStatus && complianceStatus.missing.length > 0
          ? `${complianceStatus.missing.length} missing`
          : null,
        complianceStatus && complianceStatus.expired.length > 0
          ? `${complianceStatus.expired.length} expired`
          : null,
        complianceStatus && complianceStatus.expiring_soon.length > 0
          ? `${complianceStatus.expiring_soon.length} expiring`
          : null,
      ]
        .filter(Boolean)
        .join(", ")
    : w9NeedsAction
      ? `W-9 ${taxReadiness?.w9_status}`
      : undefined;

  const tabs: CompanyTab[] = [{ label: "Overview", href: base, exact: true }];
  if (posture === "vendor") {
    tabs.push(
      {
        label: "Transactions",
        href: `${base}/transactions`,
        attention: summary && summary.overdue_cents > 0 ? "destructive" : undefined,
        attentionLabel:
          summary && summary.overdue_bill_count > 0
            ? `${summary.overdue_bill_count} overdue`
            : undefined,
      },
      { label: "Commitments", href: `${base}/commitments` },
      { label: "Prequalification", href: `${base}/prequalification` },
      {
        label: "Compliance",
        href: `${base}/compliance`,
        attention:
          complianceNeedsAction && complianceSevere
            ? "destructive"
            : complianceNeedsAction || w9NeedsAction
              ? "warning"
              : undefined,
        attentionLabel: complianceAttentionLabel,
      },
    );
  }
  tabs.push({ label: "Contacts", href: `${base}/contacts` });

  return (
    <>
      <PageLayout
        title={company.name}
        breadcrumbs={[
          { label: "Directory", href: "/directory" },
          { label: "Companies", href: "/directory?view=companies" },
          { label: company.name },
        ]}
        fullBleed
      />
      <CompanyAccountHeader
        company={company}
        posture={posture}
        canEdit={canEdit}
        canArchive={canArchive}
        complianceReady={
          posture === "vendor" && complianceStatus ? complianceStatus.is_compliant : null
        }
        complianceHref={posture === "vendor" ? `${base}/compliance` : null}
        paymentStatus={paymentReadiness?.status ?? null}
        tabs={tabs}
      />
    </>
  );
}

export default function CompanyAccountLayout({ params, children }: CompanyAccountLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <Suspense fallback={<CompanyAccountHeaderSkeleton />}>
        <CompanyAccountHeaderData params={params} />
      </Suspense>
      {/*
        Full-bleed on purpose: a register is the surface, not a card dropped
        into a container. Each tab owns its own gutters so a dense table can
        run the width while reading tabs stay comfortable.
      */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
