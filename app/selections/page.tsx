import { AppShell } from "@/components/layout/app-shell"
import { SelectionsBuilderClient } from "@/components/selections/selections-client"
import { loadSelectionsBuilderAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function SelectionsPage() {
  const [data, projects, currentUser] = await Promise.all([
    loadSelectionsBuilderAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  return (
    <AppShell title="Selections" user={currentUser}>
      <div className="p-4 lg:p-6">
        <SelectionsBuilderClient data={data} projects={projects} />
      </div>
    </AppShell>
  )
}


