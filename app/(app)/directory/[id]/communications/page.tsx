// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PartyCorrespondenceLog } from "@/components/directory/account/party-correspondence-log";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import {
  PARTY_CORRESPONDENCE_LIMIT,
  listPartyCorrespondence,
} from "@/lib/services/party-correspondence";
import { hasPermission } from "@/lib/services/permissions";
import { loadDirectoryPartyHeader, registerDirectoryTabCache } from "../page-data";

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
export default function PartyCommunicationsPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={6} flush />}>
      <PartyCommunicationsData {...props} />
    </Suspense>
  );
}

async function PartyCommunicationsData({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return <PartyCommunicationsContent id={id} />;
}

async function PartyCommunicationsContent({ id }: { id: string }) {
  "use cache: private";
  registerDirectoryTabCache(id, "communications");

  const [party, canRead] = await Promise.all([
    loadDirectoryPartyHeader(id),
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
