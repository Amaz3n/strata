import { connection } from "next/server"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { StudiosSkeleton, StudiosWorkbench } from "@/components/design-studio/studios-workbench"
import { requireOrgContext } from "@/lib/services/context"
import { listStudios } from "@/lib/services/design-studio-appointments"
import { hasPermission } from "@/lib/services/permissions"

async function StudiosPageContent() {
  await connection()
  const context = await requireOrgContext()
  const [directory, canManage] = await Promise.all([listStudios({ includeArchived: true }), hasPermission("design_studio.manage", context)])
  return <StudiosWorkbench directory={directory} canManage={canManage} />
}

export default function StudiosPage() {
  return (
    <PageLayout title="Studios & hours" breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Studios & hours" }]} fullBleed>
      <Suspense fallback={<StudiosSkeleton />}>
        <StudiosPageContent />
      </Suspense>
    </PageLayout>
  )
}
