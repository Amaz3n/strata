"use client"

import { format, formatDistanceToNowStrict } from "date-fns"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import type { FileWithUrls } from "./actions"
import type { FileAccessEvent } from "./actions"

interface FileActivitySheetProps {
  file: FileWithUrls | null
  events: FileAccessEvent[]
  loading: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

const actionLabels: Record<FileAccessEvent["action"], string> = {
  view: "Viewed",
  download: "Downloaded",
  share: "Shared",
  unshare: "Unshared",
  print: "Printed",
}

export function FileActivitySheet({
  file,
  events,
  loading,
  open,
  onOpenChange,
}: FileActivitySheetProps) {
  if (!file) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>File Activity</SheetTitle>
          <SheetDescription>
            Recent access events for {file.file_name}.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading activity...</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-4">
              {events.map((event) => (
                <div key={event.id} className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{actionLabels[event.action]}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNowStrict(new Date(event.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm">
                        {event.actor_name ?? "Portal user"}
                        {event.actor_email && (
                          <span className="text-muted-foreground"> • {event.actor_email}</span>
                        )}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(event.created_at), "MMM d, yyyy h:mm a")}
                    </span>
                  </div>
                  {(event.ip_address || event.user_agent) && (
                    <div className="text-xs text-muted-foreground">
                      {event.ip_address && <span>IP {event.ip_address}</span>}
                      {event.ip_address && event.user_agent && <span> • </span>}
                      {event.user_agent && <span>{event.user_agent}</span>}
                    </div>
                  )}
                  <Separator />
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
