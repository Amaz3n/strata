// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { z } from "zod";

import { EmptyState, Section, formatDate } from "@/components/companies/company-detail-ui";
import { VendorActivityCard } from "@/components/companies/account/vendor-activity-card";
import { VendorPaymentMethodRow } from "@/components/companies/account/vendor-payment-method-row";
import { ClientReceivablesTable } from "@/components/companies/account/client-receivables-table";
import { PartyFinancialActivity } from "@/components/financial-parties/party-financial-activity";
import {
  loadClientReceivables,
  loadCompanyAccount,
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

function formatAddress(company: { address?: unknown }) {
  const address = company.address as
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

export default async function CompanyOverviewPage({ params }: PageProps) {
  // Aging is relative to today, so render at request time.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  const { company, posture, canEdit } = account;

  if (posture === "client") {
    const receivables = await loadClientReceivables(id);
    return (
      <div className="flex flex-col gap-5 px-4 py-6 sm:px-6">
        <Section title="Receivables" count={receivables?.projects.length ?? 0} stagger={1}>
          <ClientReceivablesTable summary={receivables} />
        </Section>
        {receivables ? (
          <Section title="Activity" stagger={2}>
            <PartyFinancialActivity summary={receivables} className="border-0" />
          </Section>
        ) : null}
      </div>
    );
  }

  const isVendor = posture === "vendor";
  const [ledger, intelligence, readiness] = await Promise.all([
    isVendor ? loadVendorLedger(id).catch(() => null) : Promise.resolve(null),
    isVendor ? loadVendorIntelligence(id) : Promise.resolve({ scorecard: null, taxReadiness: null }),
    isVendor ? loadPaymentReadiness(id) : Promise.resolve(null),
  ]);

  const scorecard = intelligence.scorecard;
  const canViewBills = ledger?.summary.can_view_bills ?? false;
  const address = formatAddress(company);

  return (
    <div className="grid grid-cols-1 gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        {isVendor ? (
          <VendorActivityCard
            companyId={id}
            aging={ledger?.summary.aging ?? null}
            entries={ledger?.entries ?? []}
            canViewBills={canViewBills}
            stagger={1}
          />
        ) : (
          <NotesSection
            internalNotes={company.internal_notes}
            notes={company.notes}
            stagger={1}
          />
        )}
      </div>

      <div className="flex flex-col gap-5">
        <Section title="Details" stagger={2}>
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
          <NotesSection
            internalNotes={company.internal_notes}
            notes={company.notes}
            stagger={3}
          />
        ) : null}
      </div>
    </div>
  );
}
