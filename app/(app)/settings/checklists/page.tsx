import { PageLayout } from "@/components/layout/page-layout"
import { listChecklistTemplates } from "@/lib/services/inspections"
import { ChecklistsClient } from "./checklists-client"

export const dynamic = "force-dynamic"

export default async function ChecklistsPage() {
  const templates = await listChecklistTemplates(undefined, { includeInactive: true })

  return (
    <PageLayout
      title="Checklist Templates"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Checklists" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Safety and quality checklist templates used to run project inspections. Running inspections snapshot their
            items, so editing a template never changes past inspections.
          </p>
        </div>
        <ChecklistsClient templates={templates} />
      </div>
    </PageLayout>
  )
}
