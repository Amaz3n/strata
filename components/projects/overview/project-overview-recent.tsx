import Link from "next/link"
import { format, formatDistanceToNow, parseISO } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  CheckCircle,
  CalendarDays,
  FileText,
  Building2,
  ClipboardList,
  AlertCircle,
  ChevronRight,
  File,
  Image,
  FileSpreadsheet,
} from "@/components/icons"
import type { ProjectActivity } from "@/app/(app)/projects/[id]/actions"
import type { RecentFile } from "@/app/(app)/projects/[id]/overview-actions"

interface ProjectOverviewRecentProps {
  projectId: string
  activity: ProjectActivity[]
  recentFiles: RecentFile[]
}

function formatActivityEvent(event: ProjectActivity): { icon: React.ReactNode; title: string; description: string } {
  const eventMap: Record<string, { icon: React.ReactNode; title: string }> = {
    task_created: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task created" },
    task_updated: { icon: <CheckCircle className="h-4 w-4 text-primary" />, title: "Task updated" },
    task_completed: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task completed" },
    daily_log_created: { icon: <ClipboardList className="h-4 w-4 text-chart-2" />, title: "Daily log added" },
    schedule_item_created: { icon: <CalendarDays className="h-4 w-4 text-chart-3" />, title: "Schedule item added" },
    schedule_item_updated: { icon: <CalendarDays className="h-4 w-4 text-primary" />, title: "Schedule updated" },
    file_uploaded: { icon: <FileText className="h-4 w-4 text-chart-4" />, title: "File uploaded" },
    project_updated: { icon: <Building2 className="h-4 w-4 text-primary" />, title: "Project updated" },
    project_created: { icon: <Building2 className="h-4 w-4 text-success" />, title: "Project created" },
    rfi_created: { icon: <FileText className="h-4 w-4 text-chart-1" />, title: "RFI created" },
    rfi_response_added: { icon: <FileText className="h-4 w-4 text-chart-1" />, title: "RFI response" },
    rfi_decided: { icon: <FileText className="h-4 w-4 text-success" />, title: "RFI decided" },
    submittal_created: { icon: <FileText className="h-4 w-4 text-chart-2" />, title: "Submittal created" },
    submittal_decided: { icon: <FileText className="h-4 w-4 text-success" />, title: "Submittal decided" },
    punch_item_created: { icon: <AlertCircle className="h-4 w-4 text-warning" />, title: "Punch item added" },
    warranty_request_created: { icon: <AlertCircle className="h-4 w-4 text-chart-4" />, title: "Warranty request" },
    closeout_item_created: { icon: <FileText className="h-4 w-4 text-chart-5" />, title: "Closeout item added" },
    closeout_item_updated: { icon: <FileText className="h-4 w-4 text-chart-5" />, title: "Closeout item updated" },
  }

  const config = eventMap[event.event_type] ?? { icon: <AlertCircle className="h-4 w-4" />, title: event.event_type.replace(/_/g, " ") }
  const description = event.payload?.title ?? event.payload?.name ?? event.payload?.summary ?? ""

  return { ...config, description }
}

function getFileIcon(mimeType?: string | null) {
  if (!mimeType) return <File className="h-4 w-4" />
  if (mimeType.startsWith("image/")) return <Image className="h-4 w-4" />
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return <FileSpreadsheet className="h-4 w-4" />
  if (mimeType.includes("pdf")) return <FileText className="h-4 w-4 text-destructive" />
  return <File className="h-4 w-4" />
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectOverviewRecent({
  projectId,
  activity,
  recentFiles,
}: ProjectOverviewRecentProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Recent Activity */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
          <CardDescription>Latest updates on this project</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[320px] pr-4">
            <div className="space-y-4">
              {activity.length > 0 ? activity.map((event) => {
                const { icon, title, description } = formatActivityEvent(event)
                return (
                  <div key={event.id} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      {icon}
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium leading-none">{title}</p>
                      {description && (
                        <p className="text-sm text-muted-foreground truncate">{description}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(parseISO(event.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                )
              }) : (
                <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Recent Files */}
      <Card className="flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Recent Files</CardTitle>
            <CardDescription>Latest uploads</CardDescription>
          </div>
          <Link href={`/projects/${projectId}/files`}>
            <Button variant="ghost" size="sm" className="gap-1">
              All files
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="flex-1">
          <ScrollArea className="h-[320px] pr-4">
            <div className="space-y-3">
              {recentFiles.length > 0 ? recentFiles.map((file) => (
                <Link
                  key={file.id}
                  href={file.link}
                  className="block"
                >
                  <div className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                      {getFileIcon(file.mime_type)}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm font-medium leading-none truncate">{file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                        {file.size && " \u00b7 "}
                        {formatDistanceToNow(parseISO(file.uploaded_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                </Link>
              )) : (
                <p className="text-sm text-muted-foreground text-center py-8">No recent files</p>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
