import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { requireOrgContext } from "@/lib/services/context"
import { listDrawingSets, listDrawingSheets, getDisciplineCounts } from "@/lib/services/drawings"
import { DrawingsClient } from "@/components/drawings/drawings-client"

export const dynamic = "force-dynamic"

export default async function DrawingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>
}) {
  const params = await searchParams
  const [currentUser, context] = await Promise.all([
    getCurrentUserAction(),
    requireOrgContext(),
  ])
  const { supabase, orgId } = context

  // Get projects for filter
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .in("status", ["planning", "bidding", "active", "on_hold"])
    .order("name", { ascending: true })

  // Get initial drawing sets
  const sets = await listDrawingSets({
    project_id: params.project,
    limit: 50,
  })

  // Get initial sheets if a project is selected
  let sheets: Awaited<ReturnType<typeof listDrawingSheets>> = []
  let disciplineCounts: Record<string, number> = {}

  if (params.project) {
    sheets = await listDrawingSheets({
      project_id: params.project,
      limit: 100,
    })
    disciplineCounts = await getDisciplineCounts(params.project)
  }

  return (
    <AppShell title="Drawings" user={currentUser}>
      <div className="p-6 h-full">
        <DrawingsClient
          initialSets={sets}
          initialSheets={sheets}
          initialDisciplineCounts={disciplineCounts}
          projects={projects ?? []}
          defaultProjectId={params.project}
        />
      </div>
    </AppShell>
  )
}
