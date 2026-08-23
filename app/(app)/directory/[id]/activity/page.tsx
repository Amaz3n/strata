// Request-scoped account data; the instant shell is the layout's.
export const instant = false;

import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { ContactActivity } from "@/components/directory/account/contact-activity";
import { loadContactAssignments, loadDirectoryParty } from "../page-data";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A company does not hold assignments — its people do — so this tab exists only
 * for a party that is a person, and a company id lands back on the overview.
 */
export default async function PartyActivityPage({ params }: PageProps) {
  // A task is overdue relative to today, so render at request time.
  await connection();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const party = await loadDirectoryParty(id);
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
