import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PageLayout } from "@/components/layout/page-layout";
import { PartyAccountHeader } from "@/components/directory/account/party-account-header";
import { CompanyAccountHeaderSkeleton } from "@/components/companies/account/company-account-skeleton";
import type { PartyTab } from "@/components/directory/account/party-tab-nav";
import type { DirectoryRoleState } from "@/lib/services/directory";
import { isCurrentRole } from "@/lib/directory/roles";
import {
  loadComplianceStatus,
  loadDirectoryParty,
  loadPaymentReadiness,
  loadPrequalificationGlance,
  loadVendorIntelligence,
  loadVendorLedger,
} from "./page-data";

interface PartyAccountLayoutProps {
  params: Promise<{ id: string }>;
  children: ReactNode;
}

// A fabricated party ID cannot pass authorization or existence checks, so the
// generic shell is what gets validated; real navigations are checked in dev.
export const instant = {
  unstable_disableBuildValidation: true,
};

/**
 * Everything here needs the request. It sits behind Suspense so the account
 * shell — chrome, gutters, and the region the tab renders into — paints
 * immediately and survives navigation between tabs.
 */
async function PartyAccountHeaderData({ params }: Pick<PartyAccountLayoutProps, "params">) {
  // The ledger's aging math reads today's date.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const party = await loadDirectoryParty(id);
  if (!party) notFound();

  const { capabilities, canEdit, canArchive } = party;
  const base = `/directory/${id}`;
  // Payables, commitments, compliance and prequalification are all keyed to a
  // company — `vendor_bills` and `commitments` have no contact column. Seeded
  // roles like `vendor` and `consultant` apply to people too, so gating those
  // tabs on the role alone gave a vendor CONTACT four tabs that each redirected
  // straight back here. A person's payables live on the company they work for.
  const isVendorCompany = capabilities.isVendor && party.kind === "company";

  const [ledger, complianceStatus, intelligence, paymentReadiness, prequalification] =
    await Promise.all([
      isVendorCompany ? loadVendorLedger(id).catch(() => null) : Promise.resolve(null),
      isVendorCompany ? loadComplianceStatus(id).catch(() => null) : Promise.resolve(null),
      isVendorCompany
        ? loadVendorIntelligence(id)
        : Promise.resolve({ scorecard: null, taxReadiness: null }),
      isVendorCompany ? loadPaymentReadiness(id) : Promise.resolve(null),
      isVendorCompany ? loadPrequalificationGlance(id) : Promise.resolve(null),
    ]);

  const summary = ledger?.summary.can_view_bills ? ledger.summary : null;
  const taxReadiness = intelligence.taxReadiness;

  // Attention lives on the tab that resolves it, so the header can stay one
  // identity line instead of a stack of banners.
  const w9NeedsAction =
    taxReadiness?.requires_1099 === true &&
    (taxReadiness.w9_status === "missing" || taxReadiness.w9_status === "rejected");
  const complianceNeedsAction = complianceStatus ? !complianceStatus.is_compliant : false;
  const prequalificationNeedsReview =
    prequalification?.status === "submitted" || prequalification?.status === "under_review";
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

  // Tabs follow the party's roles, not its kind alone: a company that is only a
  // client never had a use for Commitments, and a person has an activity trail
  // and portal access where a company has a ledger.
  const tabs: PartyTab[] = [{ label: "Overview", href: base, exact: true }];
  if (isVendorCompany) {
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
      {
        label: "Prequalification",
        href: `${base}/prequalification`,
        // A returned package is sitting on the builder, which is the one state
        // here they are the blocker for.
        attention: prequalificationNeedsReview
          ? "destructive"
          : prequalification?.status === "expired"
            ? "warning"
            : undefined,
        attentionLabel: prequalificationNeedsReview
          ? "Awaiting your review"
          : prequalification?.status === "expired"
            ? "Expired"
            : undefined,
      },
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
  if (party.kind === "company") {
    tabs.push({ label: "Contacts", href: `${base}/contacts` });
  } else {
    tabs.push({ label: "Activity", href: `${base}/activity` });
  }
  tabs.push(
    { label: "Communications", href: `${base}/communications` },
    { label: "Access", href: `${base}/access` },
  );

  const name = party.kind === "company" ? party.company.name : party.contact.full_name;
  // Same liveness rule the list and capabilities use — a role marked inactive is
  // history, and showing it as a current chip would contradict the tabs.
  const roles: DirectoryRoleState[] = party.roles
    .filter((role) => isCurrentRole(role))
    .map((role) => ({ key: role.key, label: role.label, status: role.status }));

  return (
    <>
      <PageLayout
        title={name}
        breadcrumbs={[{ label: "Directory", href: "/directory" }, { label: name }]}
        fullBleed
      />
      <PartyAccountHeader
        subject={
          party.kind === "company"
            ? { kind: "company", company: party.company }
            : { kind: "contact", contact: party.contact }
        }
        roles={roles}
        isVendor={isVendorCompany}
        isClient={capabilities.isClient}
        canEdit={canEdit}
        canArchive={canArchive}
        complianceReady={isVendorCompany && complianceStatus ? complianceStatus.is_compliant : null}
        complianceHref={isVendorCompany ? `${base}/compliance` : null}
        paymentStatus={paymentReadiness?.status ?? null}
        tabs={tabs}
      />
    </>
  );
}

export default function PartyAccountLayout({ params, children }: PartyAccountLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <Suspense fallback={<CompanyAccountHeaderSkeleton />}>
        <PartyAccountHeaderData params={params} />
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
