import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { CorrespondenceClient } from "@/components/correspondence/correspondence-client"
import { hasPermission } from "@/lib/services/permissions"
import {
  getProjectCorrespondenceInbox,
  listProjectCorrespondence,
} from "@/lib/services/project-email-ingest"
import { getProjectAction } from "../actions"

interface CorrespondencePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ q?: string; classification?: string; direction?: string; email?: string }>
}

export default async function CorrespondencePage({ params, searchParams }: CorrespondencePageProps) {
  const { id } = await params
  const filters = await searchParams

  const [project, list, inbox, canWrite, canWriteChangeEvents] = await Promise.all([
    getProjectAction(id),
    listProjectCorrespondence(id, {
      search: filters.q,
      classification: filters.classification,
      direction: filters.direction,
    }),
    getProjectCorrespondenceInbox(id),
    hasPermission("correspondence.write"),
    hasPermission("change_events.write"),
  ])
  if (!project) notFound()

  return (
    <>
      <PageLayout
        title="Correspondence"
        breadcrumbs={[{ label: project.name }, { label: "Correspondence" }]}
      />
      <CorrespondenceClient
        projectId={id}
        inbox={inbox}
        emails={list.emails}
        truncated={list.truncated}
        limit={list.limit}
        canWrite={canWrite}
        canWriteChangeEvents={canWriteChangeEvents}
      />
    </>
  )
}
