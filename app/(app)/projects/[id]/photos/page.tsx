import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { hasPermission } from "@/lib/services/permissions"
import { listProjectLocations } from "@/lib/services/locations"
import { listProjectPhotos, listProjectPhotoUploaders } from "@/lib/services/photos"
import { getProjectAction } from "../actions"
import { PhotosLens } from "./photos-lens"

export default async function ProjectPhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const [initialPage, locations, uploaders, canUpload, canWriteDailyLogs] = await Promise.all([
    listProjectPhotos({ projectId: id, limit: 30, filters: {} }),
    listProjectLocations(id),
    listProjectPhotoUploaders(id),
    hasPermission("docs.upload"),
    hasPermission("daily_log.write"),
  ])

  return (
    <PageLayout title="Photos" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Photos" }]} fullBleed>
      <PhotosLens
        projectId={id}
        initialPage={initialPage}
        locations={locations.map((location) => ({ id: location.id, full_path: location.full_path }))}
        uploaders={uploaders}
        canUpload={canUpload && canWriteDailyLogs}
      />
    </PageLayout>
  )
}
