"use client"

import { format, formatDistanceToNowStrict } from "date-fns"
import { Activity, Clock3 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import type { FileWithUrls, FileTimelineEvent } from "@/app/(app)/files/actions"

interface FileTimelineSheetProps {
  file: FileWithUrls | null
  events: FileTimelineEvent[]
  loading: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

const sourceLabel: Record<FileTimelineEvent["source"], string> = {
  access: "Access",
  audit: "Audit",
  event: "Version",
}

export function FileTimelineSheet({
  file,
  events,
  loading,
  open,
  onOpenChange,
}: FileTimelineSheetProps) {
  if (!file) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            File Timeline
          </SheetTitle>
          <SheetDescription>
            Lifecycle and access history for {file.file_name}.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading timeline...</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No timeline activity yet.</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary">{event.action}</Badge>
                      <Badge variant="outline">{sourceLabel[event.source]}</Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock3 className="h-3 w-3" />
                        {formatDistanceToNowStrict(new Date(event.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    {(event.actor_name || event.actor_email) && (
                      <p className="text-sm text-muted-foreground truncate">
                        {event.actor_name ?? "System"}
                        {event.actor_email && <span> • {event.actor_email}</span>}
                      </p>
                    )}
                    {event.details && (
                      <p className="text-sm">{event.details}</p>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(event.created_at), "MMM d, yyyy h:mm a")}
                  </span>
                </div>
                <Separator />
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
