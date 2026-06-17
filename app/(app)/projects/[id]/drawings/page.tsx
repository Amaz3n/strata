import { notFound } from "next/navigation"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { DrawingsSetsView } from "@/components/drawings"
import { getProjectAction } from "../actions"
import { listDrawingSets, listDrawingSheetsWithUrls } from "@/lib/services/drawings"

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ set?: string; sheetId?: string }>
}

export default async function ProjectDrawingsPage({
  params,
  searchParams,
}: ProjectDrawingsPageProps) {
  const { id } = await params
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Drawings"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Drawings" },
      ]}
    >
      <Suspense
        fallback={
          <div className="p-6 space-y-4">
            <Skeleton className="h-8 w-48 mb-6" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <ProjectDrawingsData id={id} project={project} searchParams={searchParams} />
      </Suspense>
    </PageLayout>
  )
}

async function ProjectDrawingsData({
  id,
  project,
  searchParams,
}: {
  id: string
  project: any
  searchParams: Promise<{ set?: string; sheetId?: string }>
}) {
  const query = await searchParams

  const [sets, sheets] = await Promise.all([
    listDrawingSets({ project_id: id, limit: 100 }),
    listDrawingSheetsWithUrls({ project_id: id, limit: 500 }),
  ])

  const initialSelectedSetId =
    query.set && sets.some((set) => set.id === query.set) ? query.set : undefined

  return (
    <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
      <DrawingsSetsView
        initialSets={sets}
        initialSheets={sheets}
        projects={[{ id: project.id, name: project.name }]}
        selectedProjectId={project.id}
        lockProject
        initialSelectedSetId={initialSelectedSetId}
        initialSheetId={query.sheetId}
      />
    </div>
  )
}
