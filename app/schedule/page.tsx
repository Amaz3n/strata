import { AppShell } from "@/components/layout/app-shell"
import { ScheduleClient } from "./schedule-client"
import { listScheduleItemsAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function SchedulePage() {
  const [scheduleItems, projects, currentUser] = await Promise.all([
    listScheduleItemsAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  const activeProjects = projects.filter((project) => project.status !== "completed" && project.status !== "cancelled").length

  return (
    <AppShell title="Schedule" user={currentUser} badges={{ projects: activeProjects }}>
      <div className="p-4 lg:p-6">
        <ScheduleClient scheduleItems={scheduleItems} projects={projects} />
      </div>
    </AppShell>
  )
}
