import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseNotesPage } from "@/components/release-notes/release-notes-page"
import { requireAuth } from "@/lib/auth/context"
import { getFeatureFlagOrganizations } from "@/lib/services/admin"
import { hasAnyPermission } from "@/lib/services/permissions"
import {
  getReleaseNotesOverview,
  listReleaseNotesForAdmin,
} from "@/lib/services/release-notes"

export const dynamic = "force-dynamic"

const MANAGE_PERMISSIONS = ["platform.feature_flags.manage", "features.manage"]

export default async function WhatsNewPage() {
  const { user, orgId } = await requireAuth()
  const canManage = await hasAnyPermission(MANAGE_PERMISSIONS, {
    userId: user.id,
    orgId: orgId ?? undefined,
  })

  if (canManage) {
    const [notes, organizations] = await Promise.all([
      listReleaseNotesForAdmin(),
      getFeatureFlagOrganizations(),
    ])

    return (
      <PageLayout title="What's New">
        <ReleaseNotesPage canManage notes={notes} organizations={organizations} />
      </PageLayout>
    )
  }

  const { notes } = await getReleaseNotesOverview()

  return (
    <PageLayout title="What's New">
      <ReleaseNotesPage notes={notes} />
    </PageLayout>
  )
}
