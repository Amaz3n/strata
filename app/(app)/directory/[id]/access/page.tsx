// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import {
  CompanyAccessRoster,
  ContactAccessPanel,
} from "@/components/directory/account/party-access";
import { listCompanyContactAccess, listContactAccess } from "@/lib/services/portal-access";
import { loadDirectoryParty } from "../page-data";
import { getOrgProductTier } from "@/lib/services/context";
import { terminology } from "@/lib/terminology";

const ACCESS_ROSTER_LIMIT = 50;

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * External access read from the directory's side. The person is the unit and
 * the link is a field on their record, so a company shows a roster of its
 * people and a person shows their own way in.
 */
export default async function PartyAccessPage({ params }: PageProps) {
  // An expired token is expired relative to now, so render at request time.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const [party, productTier] = await Promise.all([
    loadDirectoryParty(id),
    getOrgProductTier(),
  ]);
  if (!party) notFound();

  if (party.kind === "company") {
    const access = await listCompanyContactAccess(id);
    // A large sub can carry hundreds of people. The roster is for granting and
    // revoking access, not for browsing staff, so it shows a page's worth and
    // says when there are more rather than rendering the lot.
    const allContacts = party.company.contacts;
    const contacts = allContacts.slice(0, ACCESS_ROSTER_LIMIT);
    return (
      <CompanyAccessRoster
        contacts={contacts.map((contact) => ({
          id: contact.id,
          full_name: contact.full_name,
          email: contact.email,
          role: contact.role,
        }))}
        accessByContactId={Object.fromEntries(access)}
        totalContacts={allContacts.length}
        limit={ACCESS_ROSTER_LIMIT}
      />
    );
  }

  const summary = await listContactAccess(id);
  return (
    <ContactAccessPanel
      summary={summary}
      contactName={party.contact.full_name}
      terms={terminology(productTier)}
    />
  );
}
