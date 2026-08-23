// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound } from "next/navigation";
import { z } from "zod";

import { PartyCorrespondenceLog } from "@/components/directory/account/party-correspondence-log";
import {
  PARTY_CORRESPONDENCE_LIMIT,
  listPartyCorrespondence,
} from "@/lib/services/party-correspondence";
import { hasPermission } from "@/lib/services/permissions";
import { loadDirectoryParty } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Correspondence read along the party axis instead of the project axis. Works
 * for either kind: a company holds the mail its people sent under its banner, a
 * person holds their own.
 *
 * The tab is on every party, but the mail is gated on `correspondence.read` —
 * so a reader without it is told so rather than dropped on an error page.
 */
export default async function PartyCommunicationsPage({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const [party, canRead] = await Promise.all([
    loadDirectoryParty(id),
    hasPermission("correspondence.read"),
  ]);
  if (!party) notFound();

  const list = canRead
    ? await listPartyCorrespondence({ kind: party.kind, partyId: id })
    : { rows: [], limit: PARTY_CORRESPONDENCE_LIMIT, truncated: false };

  return (
    <PartyCorrespondenceLog
      rows={list.rows}
      limit={list.limit}
      truncated={list.truncated}
      partyKind={party.kind}
      canRead={canRead}
    />
  );
}
