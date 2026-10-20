import { PayrollCorrectionWorkflowLink } from "@/components/time/payroll-correction-workflow-link"
import { connection } from "next/server"
import { Suspense } from "react"
import Link from "next/link"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listProjectTimeEntries } from "@/lib/services/cost-plus"
import { hasPermission } from "@/lib/services/permissions"
import { listTeamMembers } from "@/lib/services/team"
import { PageLayout } from "@/components/layout/page-layout"
import { TimeEntriesClient } from "@/components/time/time-entries-client"
import { periodParam, TimesheetSection, TimesheetSectionSkeleton } from "@/components/time/timesheet-section"
import { Button } from "@/components/ui/button"

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}


export default function ProjectTimePage({ params, searchParams }: Props) {
  return (
    <>
      <PageLayout
        title="Time"
        breadcrumbs={[
          { label: "Project" },
          { label: "Time" },
        ]}
      />
      <Suspense fallback={<ProjectTimeFallback />}>
        <ProjectTimePageRoute params={params} searchParams={searchParams} />
      </Suspense>
    </>
  )
}

async function ProjectTimePageRoute({ params, searchParams }: Props) {
  await connection()
  const [{ id }, query] = await Promise.all([params, searchParams])

  return <ProjectTimeData id={id} period={periodParam(query.period)} />
}

function ProjectTimeFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

async function ProjectTimeData({ id, period }: { id: string; period?: string }) {
  const canManageCrewPromise = hasPermission("time.manage").catch(() => false)
  // The roster picks who the hours are for. Pay rates stay on the server: the
  // entry is priced from the rate on file.
  const teamMembersPromise = canManageCrewPromise.then(async (canManageCrew) => {
    if (!canManageCrew) return []
    const members = await listTeamMembers(undefined, { includeProjectCounts: false }).catch(() => [])
    return members.map((member) => ({
      ...member,
      labor_cost_rate_cents: undefined,
      labor_bill_rate_cents: undefined,
      labor_burden_multiplier: undefined,
      labor_is_billable_default: undefined,
    }))
  })

  const [project, costCodes, data, canManageCrew, teamMembers] = await Promise.all([
    getProjectAction(id),
    listCostCodes().catch(() => []),
    listProjectTimeEntries(id),
    canManageCrewPromise,
    teamMembersPromise,
  ])

  if (!project) notFound()

  return (
    <PageLayout
      title="Time"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Time" },
      ]}
    >
      <Suspense fallback={null}><PayrollCorrectionWorkflowLink projectId={project.id} /></Suspense>
      {project.is_public_work ? (
        <div className="mb-4 flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${project.id}/time/certified-payroll`}>Certified payroll</Link>
          </Button>
        </div>
      ) : null}
      <div className="mb-8">
        <Suspense fallback={<TimesheetSectionSkeleton />}>
          <TimesheetSection
            period={period}
            projectId={project.id}
            basePath={`/projects/${project.id}/time`}
          />
        </Suspense>
      </div>
      <TimeEntriesClient
        projectId={project.id}
        initialEntries={data ?? []}
        costCodes={costCodes as any}
        teamMembers={teamMembers}
        canManageCrew={canManageCrew}
      />
    </PageLayout>
  )
}
