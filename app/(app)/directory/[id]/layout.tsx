import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PageLayout } from "@/components/layout/page-layout";
import { TabPanelTransition } from "@/components/layout/tab-panel-transition";
import { PartyAccountHeader } from "@/components/directory/account/party-account-header";
import { CompanyAccountHeaderSkeleton } from "@/components/companies/account/company-account-skeleton";
import type { PartyTab } from "@/components/directory/account/party-tab-nav";
import type { DirectoryRoleState } from "@/lib/services/directory";
import type { PartyRolesData } from "@/components/directory/account/party-roles-editor";
import { listRelationshipTypes } from "@/lib/services/party-roles";
import type { DirectoryVendorHeaderSignals } from "@/lib/directory/vendor-data";
import {
  loadComplianceStatus,
  loadDirectoryParty,
  loadDirectoryPartyHeader,
  loadPaymentReadiness,
  loadPrequalificationGlance,
  loadVendorProgramSummary,
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

async function loadVendorHeaderSignals(
  id: string,
  programs: { showCompliance: boolean; showPrequalification: boolean },
): Promise<DirectoryVendorHeaderSignals> {
  // The ledger's aging math reads today's date. This is the ONLY part of the
  // header that does — identity, roles and the tab set are the same at any
  // hour — so the request dependency lives here, behind its own Suspense
  // boundary, instead of holding the whole account header out of the prefetch.
  await connection();
  const [ledger, complianceStatus, intelligence, paymentReadiness, prequalification] =
    await Promise.all([
      loadVendorLedger(id).catch(() => null),
      programs.showCompliance ? loadComplianceStatus(id).catch(() => null) : Promise.resolve(null),
      loadVendorIntelligence(id),
      loadPaymentReadiness(id),
      programs.showPrequalification ? loadPrequalificationGlance(id) : Promise.resolve(null),
    ]);
  const summary = ledger?.summary.can_view_bills ? ledger.summary : null;
  const rawW9Status = intelligence.taxReadiness?.w9_status;
  const w9Status =
    rawW9Status === "ready" ||
    rawW9Status === "missing" ||
    rawW9Status === "pending_review" ||
    rawW9Status === "rejected" ||
    rawW9Status === "not_required"
      ? rawW9Status
      : null;

  return {
    overdueCents: summary?.overdue_cents ?? 0,
    overdueBillCount: summary?.overdue_bill_count ?? 0,
    complianceState: !complianceStatus
      ? null
      : complianceStatus.enrollment === "unenrolled"
        ? "unenrolled"
        : complianceStatus.is_compliant
          ? "compliant"
          : "action_required",
    complianceMissing: complianceStatus?.missing.length ?? 0,
    complianceExpired: complianceStatus?.expired.length ?? 0,
    complianceExpiringSoon: complianceStatus?.expiring_soon.length ?? 0,
    w9Status,
    w9NeedsAction:
      intelligence.taxReadiness?.requires_1099 === true &&
      (w9Status === "missing" || w9Status === "rejected"),
    paymentStatus: paymentReadiness?.status ?? null,
    prequalificationStatus: prequalification?.status ?? null,
  };
}

/**
 * Everything here needs the request. It sits behind Suspense so the account
 * shell — chrome, gutters, and the region the tab renders into — paints
 * immediately and survives navigation between tabs.
 */
async function PartyAccountHeaderData({ params }: Pick<PartyAccountLayoutProps, "params">) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const party = await loadDirectoryPartyHeader(id);
  if (!party) notFound();

  const { capabilities, canEdit, canArchive } = party;
  const base = `/directory/${id}`;
  // Payables, commitments, compliance and prequalification are all keyed to a
  // company — `vendor_bills` and `commitments` have no contact column. Seeded
  // roles like `vendor` and `consultant` apply to people too, so gating those
  // tabs on the role alone gave a vendor CONTACT four tabs that each redirected
  // straight back here. A person's payables live on the company they work for.
  const isVendorCompany = capabilities.isVendor && party.kind === "company";
  const programSummary = isVendorCompany
    ? await loadVendorProgramSummary(id)
    : {
        hasProjectWork: false,
        complianceEnrolled: false,
        hasComplianceHistory: false,
        hasPrequalificationHistory: false,
      };
  const showTradeWork = capabilities.isTradePartner || programSummary.hasProjectWork;
  // Every vendor company gets the tab. Hiding it until the vendor already had
  // requirements or history meant the one screen that can enroll somebody was
  // unreachable for exactly the vendors who were not enrolled — and enrollment
  // is what makes the compliance badge mean anything. The tab's empty state is
  // the enrollment step.
  const showCompliance = isVendorCompany;
  const showPrequalification = showTradeWork || programSummary.hasPrequalificationHistory;
  // Started, deliberately not awaited: identity and tabs are useful without
  // ledger/compliance decoration, so those signals stream into small client
  // Suspense boundaries after the account shell is already interactive.
  const vendorSignals = isVendorCompany
    ? loadVendorHeaderSignals(id, { showCompliance, showPrequalification })
    : undefined;

  // Tabs follow the party's roles, not its kind alone: a company that is only a
  // client never had a use for Commitments, and a person has an activity trail
  // and portal access where a company has a ledger.
  const tabs: PartyTab[] = [{ label: "Overview", href: base, exact: true }];
  if (isVendorCompany) {
    tabs.push({ label: "Transactions", href: `${base}/transactions` });
    if (showTradeWork) tabs.push({ label: "Commitments", href: `${base}/commitments` });
    if (showPrequalification) {
      tabs.push({ label: "Prequalification", href: `${base}/prequalification` });
    }
    if (showCompliance) tabs.push({ label: "Compliance", href: `${base}/compliance` });
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

  const name = party.name;
  const roles: DirectoryRoleState[] = party.roles;
  const fullParty = loadDirectoryParty(id);
  const editableSubject = fullParty.then((resolved) => {
    if (!resolved) return null;
    return resolved.kind === "company"
      ? ({ kind: "company", company: resolved.company } as const)
      : ({ kind: "contact", contact: resolved.contact } as const);
  });
  // Started, deliberately not awaited: the chips above already say what this
  // party is, and only opening the manager needs the ids, categories and org
  // vocabulary behind them.
  const rolesData: Promise<PartyRolesData | null> = Promise.all([
    fullParty,
    listRelationshipTypes().catch(() => []),
  ]).then(([resolved, relationshipTypes]) =>
    resolved ? { roles: resolved.roles, relationshipTypes } : null,
  );

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
            ? {
                kind: "company",
                company: { id: party.id, name, email: party.email, trade: party.detail },
              }
            : {
                kind: "contact",
                contact: {
                  id: party.id,
                  full_name: name,
                  email: party.email,
                  role: party.detail,
                  primary_company: party.primaryCompanyName
                    ? { name: party.primaryCompanyName }
                    : undefined,
                },
              }
        }
        editableSubject={editableSubject}
        roles={roles}
        rolesData={rolesData}
        isVendor={isVendorCompany}
        isClient={capabilities.isClient}
        canEdit={canEdit}
        canArchive={canArchive}
        complianceHref={isVendorCompany && showCompliance ? `${base}/compliance` : null}
        vendorSignals={vendorSignals}
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
      <TabPanelTransition className="tab-panel-in flex min-h-0 flex-1 flex-col">
        {children}
      </TabPanelTransition>
    </div>
  );
}
