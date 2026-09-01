import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { CorrespondenceWorkbench } from "@/components/correspondence/correspondence-workbench"
import { CorrespondenceWorkbenchSkeleton } from "@/components/correspondence/correspondence-workbench-skeleton"
import { hasProjectPermission } from "@/lib/services/permissions"
import { requireOrgContext } from "@/lib/services/context"
import {
  getCorrespondenceReaderTarget,
  getProjectCorrespondenceInbox,
  listCorrespondence,
} from "@/lib/services/correspondence"
import { parseCorrespondenceSearchParams } from "@/lib/validation/correspondence"
import { getProjectAction } from "../actions"

interface CorrespondencePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function single(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.trim() || null
}

export const instant = true

/**
 * The shell renders without touching `params` or `searchParams`, so the whole
 * frame — toolbar, table, footer — is prerenderable and every navigation
 * into the log lands on the real layout rather than an empty page.
 *
 * This is not cosmetic. The previous version awaited the URL at the top of the
 * page and rendered a client component that called `useSearchParams()` with no
 * boundary above it, which blocks the prerender: the shell aborted mid-flight
 * and the identity lookups already in the air came back as
 * "During prerendering, fetch() rejects when the prerender is complete", logged
 * by lib/auth/context.ts as failed org and platform-membership reads.
 */
export default function CorrespondencePage({ params, searchParams }: CorrespondencePageProps) {
  return (
    <Suspense fallback={<CorrespondenceWorkbenchSkeleton />}>
      <CorrespondenceData params={params} searchParams={searchParams} />
    </Suspense>
  )
}

async function CorrespondenceData({ params, searchParams }: CorrespondencePageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const filters = parseCorrespondenceSearchParams(id, query)
  const openEmailId = single(query.email)
  const openThreadId = single(query.thread)

  const { userId } = await requireOrgContext()
  // The open conversation is loaded here, with the log, rather than fetched by
  // the dialog once it mounts — `?email=` also arrives from global search, a
  // notification, and a party's Communications tab, and all four paths should
  // render the same way.
  const [project, list, inbox, canWrite, target] = await Promise.all([
    getProjectAction(id),
    listCorrespondence(filters),
    getProjectCorrespondenceInbox(id),
    // Project-scoped, not org-scoped: a role that cannot act on this project
    // must not be shown buttons whose action will refuse them.
    hasProjectPermission(userId, id, "correspondence.write"),
    getCorrespondenceReaderTarget({ projectId: id, emailId: openEmailId, threadId: openThreadId }),
  ])
  if (!project) notFound()

  return (
    <PageLayout
      title="Correspondence"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Correspondence" }]}
      fullBleed
    >
      <CorrespondenceWorkbench
        projectId={id}
        inbox={inbox}
        list={list}
        filters={filters}
        target={target}
        canWrite={canWrite}
      />
    </PageLayout>
  )
}
