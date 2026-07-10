import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseNotesAdmin } from "@/components/admin/release-notes-admin"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { getFeatureFlagOrganizations } from "@/lib/services/admin"
import { listReleaseNotesForAdmin } from "@/lib/services/release-notes"

export const dynamic = "force-dynamic"

export default async function AdminReleaseNotesPage() {
  await requireAnyPermissionGuard([
    "platform.feature_flags.manage",
    "features.manage",
  ])

  const [notes, organizations] = await Promise.all([
    listReleaseNotesForAdmin(),
    getFeatureFlagOrganizations(),
  ])

  return (
    <PageLayout
      title="Release Notes"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Release Notes" },
      ]}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Quiet notes appear only in the feed, badge notes count as unread, and announcements open once in-app.
        </p>
        <ReleaseNotesAdmin initialNotes={notes} organizations={organizations} />
      </div>
    </PageLayout>
  )
}
