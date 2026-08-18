// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { Section } from "@/components/companies/company-detail-ui";
import { PrequalificationCard } from "@/components/companies/prequalification-card";
import { getLatestPrequalification } from "@/lib/services/prequalification";
import { loadCompanyAccount } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompanyPrequalificationPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const account = await loadCompanyAccount(id).catch(() => null);
  if (!account) notFound();
  if (account.posture !== "vendor") redirect(`/directory/${id}`);

  const prequalification = await getLatestPrequalification(id).catch(() => null);

  return (
    <div className="px-4 py-6 sm:px-6">
      <Section title="Prequalification" stagger={1}>
        <div className="p-4">
          <PrequalificationCard
            companyId={id}
            prequalification={prequalification}
            canEdit={account.canEdit}
          />
        </div>
      </Section>
    </div>
  );
}
