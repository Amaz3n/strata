import { AppShell } from "@/components/layout/app-shell"
import { StatsCards } from "@/components/dashboard/stats-cards"
import { ProjectList } from "@/components/dashboard/project-list"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { TasksPreview } from "@/components/dashboard/tasks-preview"
import { OnboardingChecklist } from "@/components/dashboard/onboarding-checklist"
import { getDashboardSnapshotAction } from "@/app/actions/dashboard"
import { getCurrentUserAction } from "@/app/actions/user"
import { getOnboardingStateAction } from "@/app/actions/orgs"

export default async function DashboardPage() {
  const [snapshot, currentUser, onboarding] = await Promise.all([
    getDashboardSnapshotAction(),
    getCurrentUserAction(),
    getOnboardingStateAction(),
  ])
  const projectBadge = snapshot.projects.filter((p) => p.status !== "completed" && p.status !== "cancelled").length
  const taskBadge = snapshot.tasks.filter((t) => t.status !== "done").length

  return (
    <AppShell title="Dashboard" user={currentUser} badges={{ projects: projectBadge, tasks: taskBadge }}>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Page header */}
        <div className="hidden lg:block">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Welcome back. Here's what's happening with your projects.</p>
        </div>

        {/* Stats */}
        <StatsCards stats={snapshot.stats} />

        {/* Main content grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column - Projects & Tasks */}
          <div className="space-y-6 lg:col-span-2">
            <ProjectList projects={snapshot.projects} />
            <TasksPreview tasks={snapshot.tasks} projects={snapshot.projects} />
          </div>

          {/* Right column - Activity */}
          <div className="space-y-6">
            <OnboardingChecklist
              members={onboarding.members}
              projects={onboarding.projects}
              contacts={onboarding.contacts}
            />
            <ActivityFeed />
          </div>
        </div>
      </div>
    </AppShell>
  )
}
