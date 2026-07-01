import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { listProjectExpensesPageAction } from "@/app/(app)/projects/[id]/expenses/actions"
import { PageLayout } from "@/components/layout/page-layout"
import { ExpensesClient } from "@/components/expenses/expenses-client"

interface Props {
  params: Promise<{ id: string }>
}

export const dynamic = "force-dynamic"

export default async function ProjectExpensesPage({ params }: Props) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Expenses"
        breadcrumbs={[
          { label: "Project" },
          { label: "Expenses" },
        ]}
      />
      <Suspense fallback={<ProjectExpensesFallback />}>
        <ProjectExpensesData id={id} />
      </Suspense>
    </>
  )
}

function ProjectExpensesFallback() {
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

async function ProjectExpensesData({ id }: { id: string }) {
  const project = await getProjectAction(id)
  if (!project) notFound()

  const data = await listProjectExpensesPageAction(id).catch(() => ({ items: [] as any[], page: 1, pageSize: 50, total: 0, pageCount: 1 }))

  return (
    <PageLayout
      title="Expenses"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Expenses" },
      ]}
    >
      <ExpensesClient projectId={project.id} initialPage={data} />
    </PageLayout>
  )
}
