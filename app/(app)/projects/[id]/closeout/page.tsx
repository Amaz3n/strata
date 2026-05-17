import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { getCloseoutPackageAction } from "@/app/(app)/closeout/actions"
import { CloseoutClient } from "@/components/closeout/closeout-client"
import { Skeleton } from "@/components/ui/skeleton"

interface ProjectCloseoutPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectCloseoutPage({ params }: ProjectCloseoutPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout title="Closeout" breadcrumbs={[
        { label: "Project" },
        { label: "Closeout" },
      ]} />
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <ProjectCloseoutData id={id} />
      </Suspense>
    </>
  )
}

async function ProjectCloseoutData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) notFound()

  const closeout = await getCloseoutPackageAction(id)

  return (
    <div className="space-y-6">
      <CloseoutClient projectId={project.id} closeoutPackage={closeout?.package} items={closeout?.items ?? []} />
    </div>
  )
}
