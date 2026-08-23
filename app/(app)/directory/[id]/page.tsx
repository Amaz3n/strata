// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound } from "next/navigation";
import { connection } from "next/server";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";

import { EmptyState, Section, formatDate } from "@/components/companies/company-detail-ui";
import { VendorActivityCard } from "@/components/companies/account/vendor-activity-card";
import { VendorPaymentMethodRow } from "@/components/companies/account/vendor-payment-method-row";
import { ClientReceivablesTable } from "@/components/companies/account/client-receivables-table";
import { PartyFinancialActivity } from "@/components/financial-parties/party-financial-activity";
import { PartyRolesEditor } from "@/components/directory/account/party-roles-editor";
import { VendorTaxReadinessCard } from "@/components/directory/account/vendor-tax-readiness-card";
import { listRelationshipTypes } from "@/lib/services/party-roles";
import { ArrowUpRight, Building2 } from "@/components/icons";
import {
  loadClientReceivables,
  loadContactReceivables,
  loadDirectoryParty,
  loadPaymentReadiness,
  loadVendorIntelligence,
  loadVendorLedger,
} from "./page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function formatAddress(party: { address?: unknown }) {
  const address = party.address as
    | string
    | {
        formatted?: string;
        street1?: string;
        street2?: string;
        city?: string;
        state?: string;
        postal_code?: string;
      }
    | null
    | undefined;
  if (!address) return null;
  if (typeof address === "string") return address;
  return (
    address.formatted ||
    [address.street1, address.street2, address.city, address.state, address.postal_code]
      .filter(Boolean)
      .join(", ") ||
    null
  );
}

function NotesSection({
  internalNotes,
  notes,
  stagger,
}: {
  internalNotes?: string;
  notes?: string;
  stagger: number;
}) {
  return (
    <Section title="Notes" stagger={stagger}>
      {internalNotes || notes ? (
        <div className="space-y-3 px-4 py-3 text-sm">
          {internalNotes ? (
            <div>
              <div className="microlabel mb-1">Internal notes</div>
              <p className="whitespace-pre-wrap text-foreground/90">{internalNotes}</p>
            </div>
          ) : null}
          {notes ? (
            <div>
              <div className="microlabel mb-1">Shared notes</div>
              <p className="whitespace-pre-wrap text-foreground/90">{notes}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState>No notes yet.</EmptyState>
      )}
    </Section>
  );
}

export default async function PartyOverviewPage({ params }: PageProps) {
  // Aging is relative to today, so render at request time.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  // The org's role vocabulary does not depend on which party this is, so it
  // loads alongside rather than after.
  const relationshipTypesPromise = listRelationshipTypes().catch(() => []);
  const party = await loadDirectoryParty(id);
  if (!party) notFound();

  const { capabilities, canEdit, roles } = party;
  const relationshipTypes = await relationshipTypesPromise;

  const rolesSection = (stagger: number) => (
    <Section title="Roles" stagger={stagger}>
      <PartyRolesEditor
        partyId={id}
        kind={party.kind}
        roles={roles}
        relationshipTypes={relationshipTypes}
        canEdit={canEdit}
      />
    </Section>
  );

  // ── Person ───────────────────────────────────────────────────────────────
  if (party.kind === "contact") {
    const contact = party.contact;
    const receivables = capabilities.isClient ? await loadContactReceivables(id) : null;
    const address = formatAddress(contact);
    const primaryCompany = contact.company_details[0] ?? null;

    return (
      <div className="grid grid-cols-1 gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          {receivables ? (
            <>
              <Section title="Receivables" count={receivables.projects.length} stagger={1}>
                <ClientReceivablesTable summary={receivables} />
              </Section>
              <Section title="Activity" stagger={2}>
                <PartyFinancialActivity summary={receivables} className="border-0" />
              </Section>
            </>
          ) : capabilities.isVendor ? (
            // A person can hold a vendor-category role, but payables are keyed to
            // companies — `vendor_bills` and `commitments` have no contact column.
            // Rather than four tabs that redirect back here, say plainly where the
            // money lives and link to it.
            <Section title="Payables" stagger={1}>
              {primaryCompany ? (
                <div className="px-4 py-3 text-sm">
                  <p className="text-muted-foreground">
                    Bills and commitments are held against the company, not the person.
                  </p>
                  <Link
                    href={`/directory/${primaryCompany.id}/transactions`}
                    className="mt-2 inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <Building2 className="h-4 w-4" />
                    {primaryCompany.name}
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : (
                <EmptyState>
                  This person holds a vendor role but is not linked to a company, so there is
                  nowhere to record bills. Link them to one to start paying them.
                </EmptyState>
              )}
            </Section>
          ) : (
            <Section title="Companies" count={contact.company_details.length} stagger={1}>
              {contact.company_details.length > 0 ? (
                <ul className="divide-y">
                  {contact.company_details.map((company) => (
                    <li key={company.id}>
                      <Link
                        href={`/directory/${company.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/30"
                      >
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{company.name}</span>
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState>Not linked to a company.</EmptyState>
              )}
            </Section>
          )}
        </div>

        <div className="flex flex-col gap-5">
          {rolesSection(2)}
          <Section title="Details" stagger={3}>
            <div className="px-4 py-2">
              <FactRow
                label="Email"
                value={
                  contact.email ? (
                    <a
                      href={`mailto:${contact.email}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {contact.email}
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <FactRow
                label="Phone"
                value={
                  contact.phone ? (
                    <a href={`tel:${contact.phone}`} className="underline-offset-4 hover:underline">
                      {contact.phone}
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <FactRow label="Title" value={contact.role || "—"} />
              <FactRow label="Address" value={address ?? "—"} />
              <FactRow label="Added" value={formatDate(contact.created_at)} />
            </div>
          </Section>
          <NotesSection notes={contact.notes} stagger={4} />
        </div>
      </div>
    );
  }

  // ── Company ──────────────────────────────────────────────────────────────
  const company = party.company;
  const isVendor = capabilities.isVendor;
  const isClient = capabilities.isClient;

  const [ledger, intelligence, readiness, clientReceivables] = await Promise.all([
    isVendor ? loadVendorLedger(id).catch(() => null) : Promise.resolve(null),
    isVendor ? loadVendorIntelligence(id) : Promise.resolve({ scorecard: null, taxReadiness: null }),
    isVendor ? loadPaymentReadiness(id) : Promise.resolve(null),
    isClient ? loadClientReceivables(id) : Promise.resolve(null),
  ]);

  const scorecard = intelligence.scorecard;
  const canViewBills = ledger?.summary.can_view_bills ?? false;
  const address = formatAddress(company);

  return (
    <div className="grid grid-cols-1 gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        {/* A company can be both. Showing one and hiding the other is exactly
            what the single type column used to force. */}
        {isVendor ? (
          <VendorActivityCard
            companyId={id}
            aging={ledger?.summary.aging ?? null}
            entries={ledger?.entries ?? []}
            canViewBills={canViewBills}
            stagger={1}
          />
        ) : null}
        {isClient ? (
          <Section title="Receivables" count={clientReceivables?.projects.length ?? 0} stagger={2}>
            <ClientReceivablesTable summary={clientReceivables} />
          </Section>
        ) : null}
        {!isVendor && !isClient ? (
          <NotesSection
            internalNotes={company.internal_notes}
            notes={company.notes}
            stagger={1}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-5">
        {rolesSection(2)}
        <Section title="Details" stagger={3}>
          <div className="px-4 py-2">
            <FactRow
              label="Phone"
              value={
                company.phone ? (
                  <a href={`tel:${company.phone}`} className="underline-offset-4 hover:underline">
                    {company.phone}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <FactRow
              label="Website"
              value={
                company.website ? (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-4 hover:underline"
                  >
                    {company.website.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <FactRow label="Address" value={address ?? "—"} />
            <FactRow label="Payment terms" value={company.default_payment_terms || "—"} />
            {isVendor ? (
              <VendorPaymentMethodRow
                companyId={id}
                readiness={readiness}
                defaultMethod={company.default_payment_method}
                canEdit={canEdit}
              />
            ) : null}
            <FactRow label="Rating" value={company.rating ? `${company.rating}/5` : "—"} />
            {isVendor ? (
              <>
                <FactRow
                  label="Performance"
                  value={
                    scorecard && scorecard.rating_label !== "Needs data"
                      ? `${Math.round(scorecard.score)} · ${scorecard.rating_label}`
                      : "Not enough data"
                  }
                />
                {ledger?.summary.last_payment_date ? (
                  <FactRow
                    label="Last payment"
                    value={formatDate(ledger.summary.last_payment_date)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </Section>

        {isVendor ? (
          <VendorTaxReadinessCard
            company={company}
            taxReadiness={intelligence.taxReadiness}
            complianceHref={`/directory/${id}/compliance`}
            stagger={4}
          />
        ) : null}

        {isVendor || isClient ? (
          <NotesSection
            internalNotes={company.internal_notes}
            notes={company.notes}
            stagger={5}
          />
        ) : null}
      </div>
    </div>
  );
}
