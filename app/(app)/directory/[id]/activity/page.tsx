// Browser-private account data; runtime-prefetched by the bounded tab strip.
export const instant = true;

import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { ContactActivity } from "@/components/directory/account/contact-activity";
import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";
import {
  loadContactAssignments,
  loadDirectoryPartyHeader,
  registerDirectoryTabCache,
} from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A company does not hold assignments — its people do — so this tab exists only
 * for a party that is a person, and a company id lands back on the overview.
 */
export default function PartyActivityPage(props: PageProps) {
  return (
    <Suspense fallback={<CompanyTabSkeleton rows={6} flush />}>
      <PartyActivityData {...props} />
    </Suspense>
  );
}

async function PartyActivityData({ params }: PageProps) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return <PartyActivityContent id={id} />;
}

async function PartyActivityContent({ id }: { id: string }) {
  "use cache: private";
  registerDirectoryTabCache(id, "activity");

  const party = await loadDirectoryPartyHeader(id);
  if (!party) notFound();
  if (party.kind !== "contact") redirect(`/directory/${id}`);

  const assignments = await loadContactAssignments(id);

  return (
    <ContactActivity
      schedule={assignments.schedule}
      tasks={assignments.tasks}
      limit={assignments.limit}
      scheduleTruncated={assignments.scheduleTruncated}
      tasksTruncated={assignments.tasksTruncated}
    />
  );
}
