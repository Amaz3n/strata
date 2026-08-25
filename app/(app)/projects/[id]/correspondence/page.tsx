import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { CorrespondenceClient } from "@/components/correspondence/correspondence-client"
import { hasProjectPermission } from "@/lib/services/permissions"
import { requireOrgContext } from "@/lib/services/context"
import {
  getProjectCorrespondenceInbox,
  listArchivedCorrespondence,
  listCorrespondenceThreads,
} from "@/lib/services/correspondence"
import {
  CORRESPONDENCE_PAGE_SIZE,
  parseCorrespondenceSearchParams,
} from "@/lib/validation/correspondence"
import { getProjectAction } from "../actions"

interface CorrespondencePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function single(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.trim() || null
}

export default async function CorrespondencePage({ params, searchParams }: CorrespondencePageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const filters = parseCorrespondenceSearchParams(id, query)
  const showArchived = single(query.view) === "archived"

  const { userId } = await requireOrgContext()
  const [project, threads, archived, inbox, canWrite] = await Promise.all([
    getProjectAction(id),
    // The archived view is a different query over the same log, so only the one
    // being looked at is loaded.
    showArchived
      ? Promise.resolve(null)
      : listCorrespondenceThreads(filters),
    showArchived
      ? listArchivedCorrespondence({
          projectId: id,
          search: filters.search,
          page: filters.page,
          pageSize: CORRESPONDENCE_PAGE_SIZE,
        })
      : Promise.resolve(null),
    getProjectCorrespondenceInbox(id),
    // Project-scoped, not org-scoped: a role that cannot act on this project
    // must not be shown buttons whose action will refuse them.
    hasProjectPermission(userId, id, "correspondence.write"),
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
        threads={threads}
        archived={archived}
        filters={filters}
        showArchived={showArchived}
        openEmailId={single(query.email)}
        openThreadId={single(query.thread)}
        canWrite={canWrite}
      />
    </>
  )
}
