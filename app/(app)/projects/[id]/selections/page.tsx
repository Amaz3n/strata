import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation"

import { loadHomeSelectionExceptionsAction, loadSelectionsBuilderAction } from "@/app/(app)/selections/actions"
import { SelectionsBuilderClient } from "@/components/selections/selections-client"
import { SelectionExceptionsBand } from "@/components/selections/selection-exceptions-band"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { runAction } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { listHomeSelectionApprovals } from "@/lib/services/selection-approvals"
import { getSelectionExceptionAbilities } from "@/lib/services/selection-exceptions"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ approval?: string | string[] }>
}

async function ProjectSelectionsPageContent({ params, searchParams }: PageProps) {
  await connection()
  const [{ id }, { approval }] = await Promise.all([params, searchParams])
  await guardProjectTab(id, "selections")
  const project = await getProjectAction(id)
  if (!project) notFound()
  const context = await requireOrgContext()
  const [data, exceptions, approvals, canManageApprovals, abilities] = await Promise.all([
    loadSelectionsBuilderAction(id),
    loadHomeSelectionExceptionsAction(id),
    runAction(() => listHomeSelectionApprovals(id)),
    hasPermission("selections.write", context),
    getSelectionExceptionAbilities(id),
  ])

  return (
    <PageLayout
      title="Selections"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Selections" }]}
      fullBleed
    >
      <SelectionsBuilderClient
        data={data}
        projects={[project]}
        approvals={approvals}
        canManageApprovals={canManageApprovals}
        focusApprovalId={typeof approval === "string" ? approval : undefined}
        exceptions={
          <SelectionExceptionsBand
            key="exceptions"
            projectId={project.id}
            exceptions={exceptions.success ? exceptions.data.exceptions : []}
            truncated={exceptions.success ? exceptions.data.truncated : false}
            error={exceptions.success ? null : exceptions.error}
            abilities={abilities}
          />
        }
      />
    </PageLayout>
  )
}

export default function ProjectSelectionsPage(props: Parameters<typeof ProjectSelectionsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Selections" fullBleed>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <ProjectSelectionsPageContent {...props} />
    </Suspense>
  )
}
