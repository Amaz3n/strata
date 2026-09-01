import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { hasPermission } from "@/lib/services/permissions"
import { listProjectLocations } from "@/lib/services/locations"
import { listProjectVendors } from "@/lib/services/project-vendors"
import {
  getProjectPhotoFacets,
  listPhotoAlbums,
  listProjectPhotos,
  listProjectPhotoUploaders,
} from "@/lib/services/photos"
import { getProjectAction } from "../actions"
import { PhotosLens } from "./photos-lens"

export default async function ProjectPhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const [initialPage, locations, uploaders, albums, facets, vendors, canUpload, canWriteDailyLogs] = await Promise.all([
    listProjectPhotos({ projectId: id, limit: 30, filters: {} }),
    listProjectLocations(id),
    listProjectPhotoUploaders(id),
    listPhotoAlbums(id),
    getProjectPhotoFacets(id),
    listProjectVendors(id),
    hasPermission("docs.upload"),
    hasPermission("daily_log.write"),
  ])

  // Companies actually on this job, so the trade a photo is attributed to comes
  // from the project's own roster rather than the org's whole directory.
  const trades = vendors
    .filter((vendor) => vendor.company?.id && vendor.company.name)
    .map((vendor) => ({ id: vendor.company!.id, name: vendor.company!.name }))
    .filter((trade, index, all) => all.findIndex((other) => other.id === trade.id) === index)
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageLayout title="Photos" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Photos" }]} fullBleed>
      <PhotosLens
        projectId={id}
        initialPage={initialPage}
        initialFacets={facets}
        locations={locations.map((location) => ({ id: location.id, full_path: location.full_path }))}
        uploaders={uploaders}
        initialAlbums={albums}
        trades={trades}
        canUpload={canUpload}
        canFileToDailyLog={canWriteDailyLogs}
      />
    </PageLayout>
  )
}
