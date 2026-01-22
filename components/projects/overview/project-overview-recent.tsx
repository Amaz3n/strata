"use client"

import { useState } from "react"
import Link from "next/link"
import { formatDistanceToNow, parseISO } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  CheckCircle,
  CalendarDays,
  FileText,
  Building2,
  ClipboardList,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  File,
  Image,
  FileSpreadsheet,
  Activity,
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
    task_created: { icon: <CheckCircle className="h-3.5 w-3.5 text-success" />, title: "Task created" },
    task_updated: { icon: <CheckCircle className="h-3.5 w-3.5 text-primary" />, title: "Task updated" },
    task_completed: { icon: <CheckCircle className="h-3.5 w-3.5 text-success" />, title: "Task completed" },
    daily_log_created: { icon: <ClipboardList className="h-3.5 w-3.5 text-chart-2" />, title: "Daily log added" },
    schedule_item_created: { icon: <CalendarDays className="h-3.5 w-3.5 text-chart-3" />, title: "Schedule item added" },
    schedule_item_updated: { icon: <CalendarDays className="h-3.5 w-3.5 text-primary" />, title: "Schedule updated" },
    file_uploaded: { icon: <FileText className="h-3.5 w-3.5 text-chart-4" />, title: "File uploaded" },
    project_updated: { icon: <Building2 className="h-3.5 w-3.5 text-primary" />, title: "Project updated" },
    project_created: { icon: <Building2 className="h-3.5 w-3.5 text-success" />, title: "Project created" },
    rfi_created: { icon: <FileText className="h-3.5 w-3.5 text-chart-1" />, title: "RFI created" },
    rfi_response_added: { icon: <FileText className="h-3.5 w-3.5 text-chart-1" />, title: "RFI response" },
    rfi_decided: { icon: <FileText className="h-3.5 w-3.5 text-success" />, title: "RFI decided" },
    submittal_created: { icon: <FileText className="h-3.5 w-3.5 text-chart-2" />, title: "Submittal created" },
    submittal_decided: { icon: <FileText className="h-3.5 w-3.5 text-success" />, title: "Submittal decided" },
    punch_item_created: { icon: <AlertCircle className="h-3.5 w-3.5 text-warning" />, title: "Punch item added" },
    warranty_request_created: { icon: <AlertCircle className="h-3.5 w-3.5 text-chart-4" />, title: "Warranty request" },
    closeout_item_created: { icon: <FileText className="h-3.5 w-3.5 text-chart-5" />, title: "Closeout item added" },
    closeout_item_updated: { icon: <FileText className="h-3.5 w-3.5 text-chart-5" />, title: "Closeout item updated" },
  }

  const config = eventMap[event.event_type] ?? { icon: <AlertCircle className="h-3.5 w-3.5" />, title: event.event_type.replace(/_/g, " ") }
  const description = event.payload?.title ?? event.payload?.name ?? event.payload?.summary ?? ""

  return { ...config, description }
}

function getFileIcon(mimeType?: string | null) {
  if (!mimeType) return <File className="h-3.5 w-3.5" />
  if (mimeType.startsWith("image/")) return <Image className="h-3.5 w-3.5" />
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return <FileSpreadsheet className="h-3.5 w-3.5" />
  if (mimeType.includes("pdf")) return <FileText className="h-3.5 w-3.5 text-destructive" />
  return <File className="h-3.5 w-3.5" />
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
  const [isOpen, setIsOpen] = useState(false)

  const displayActivity = activity.slice(0, 8)
  const displayFiles = recentFiles.slice(0, 4)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Recent Activity</span>
              <span className="text-xs text-muted-foreground">
                {activity.length} events &bull; {recentFiles.length} files
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild onClick={(e) => e.stopPropagation()}>
                <Link href={`/projects/${projectId}/files`}>
                  Files
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
              {isOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            <div className="grid gap-4 lg:grid-cols-3">
              {/* Recent Activity */}
              <div className="lg:col-span-2 space-y-2">
                {displayActivity.length > 0 ? displayActivity.map((event) => {
                  const { icon, title, description } = formatActivityEvent(event)
                  return (
                    <div key={event.id} className="flex items-center gap-2 text-sm">
                      <div className="flex-shrink-0 opacity-70">{icon}</div>
                      <span className="font-medium">{title}</span>
                      {description && (
                        <span className="text-muted-foreground truncate flex-1">{description}</span>
                      )}
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatDistanceToNow(parseISO(event.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  )
                }) : (
                  <p className="text-sm text-muted-foreground">No recent activity</p>
                )}
              </div>

              {/* Recent Files */}
              <div className="space-y-2">
                {displayFiles.length > 0 ? displayFiles.map((file) => (
                  <Link key={file.id} href={file.link} className="block">
                    <div className="flex items-center gap-2 text-sm rounded-md px-2 py-1.5 hover:bg-muted/80 transition-colors">
                      <div className="flex-shrink-0 opacity-70">
                        {getFileIcon(file.mime_type)}
                      </div>
                      <span className="font-medium truncate flex-1">{file.name}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatFileSize(file.size)}
                      </span>
                    </div>
                  </Link>
                )) : (
                  <p className="text-sm text-muted-foreground">No recent files</p>
                )}
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
