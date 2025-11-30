import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Plus, Search, Camera, Upload } from "@/components/icons"
import type { DailyLog, Project } from "@/lib/types"
import { listDailyLogsAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function DailyLogsPage() {
  const [dailyLogs, projects, currentUser] = await Promise.all([
    listDailyLogsAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  const getProjectName = (projectId: string) => {
    return projects.find((p) => p.id === projectId)?.name || "Unknown"
  }

  return (
    <AppShell title="Daily Logs" user={currentUser} badges={{ projects: projects.length }}>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold">Daily Logs</h1>
            <p className="text-muted-foreground mt-1">Document daily progress, weather, and notes</p>
          </div>
          <Button className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New Log Entry
          </Button>
        </div>

        {/* Quick actions for mobile */}
        <div className="grid grid-cols-2 gap-3 lg:hidden">
          <Button variant="outline" className="h-auto py-4 flex-col gap-2 bg-transparent">
            <Camera className="h-5 w-5" />
            <span>Add Photos</span>
          </Button>
          <Button variant="outline" className="h-auto py-4 flex-col gap-2 bg-transparent">
            <Upload className="h-5 w-5" />
            <span>Upload Files</span>
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search logs..." className="pl-9" />
          </div>
        </div>

        {/* Logs list */}
        <div className="space-y-4">
          {dailyLogs.map((log) => (
            <Card key={log.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-lg">
                      {new Date(log.date).toLocaleDateString("en-US", {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">{getProjectName(log.project_id)}</p>
                  </div>
                  {log.weather && (
                    <Badge variant="outline" className="shrink-0">
                      {log.weather}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed">{log.notes ?? "No notes recorded for this day."}</p>

                {/* Photo grid placeholder */}
                <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 w-20 shrink-0 rounded-md bg-muted flex items-center justify-center">
                      <Camera className="h-6 w-6 text-muted-foreground/50" />
                    </div>
                  ))}
                  <button className="h-20 w-20 shrink-0 rounded-md border border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                    <Plus className="h-5 w-5" />
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Empty state for new log */}
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <Plus className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-semibold">Create Today's Log</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Document weather, crew, work completed, and any issues.
              </p>
              <Button className="mt-4">
                <Plus className="mr-2 h-4 w-4" />
                Start Daily Log
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
