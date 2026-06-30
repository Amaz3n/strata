import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseNotesAdmin } from "@/components/admin/release-notes-admin"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Release Notes</h1>
          <p className="mt-2 text-muted-foreground">
            Publish Arc updates, target the right users, and control how prominently each note appears.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>What&apos;s New Publisher</CardTitle>
            <CardDescription>
              Quiet notes appear only in the feed, badge notes count as unread, and announcements open once in-app.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReleaseNotesAdmin initialNotes={notes} organizations={organizations} />
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}
