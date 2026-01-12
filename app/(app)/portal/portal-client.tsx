"use client"

import type React from "react"
import { useState, useTransition } from "react"
import { format, formatDistanceToNow } from "date-fns"

import type { ConversationChannel, PortalMessage, PortalView, Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { toast } from 'sonner'
import { Spinner } from "@/components/ui/spinner"
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  FileText,
  MessageSquare,
  Users,
  Clock,
} from "@/components/icons"
import { loadPortalViewAction, sendPortalMessageAction } from "./actions"

interface PortalClientProps {
  projects: Project[]
  initialChannel: ConversationChannel
  initialView: PortalView | null
}

const statusStyles: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

export function PortalClient({ projects, initialChannel, initialView }: PortalClientProps) {
  const [selectedProjectId, setSelectedProjectId] = useState(initialView?.project.id ?? projects[0]?.id ?? "")
  const [channel, setChannel] = useState<ConversationChannel>(initialChannel)
  const [view, setView] = useState<PortalView | null>(initialView)
  const [messageBody, setMessageBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const [isSending, setIsSending] = useState(false)

  const handleProjectChange = (value: string) => {
    setSelectedProjectId(value)
    startTransition(async () => {
      try {
        const nextView = await loadPortalViewAction(value, channel)
        setView(nextView)
      } catch (error) {
        console.error("Unable to load portal view", error)
        toast.error("Unable to load portal", {
          description: "We couldn't load that project's portal. Try again.",
        })
      }
    })
  }

  const handleChannelChange = (value: ConversationChannel) => {
    setChannel(value)
    if (!selectedProjectId) return

    startTransition(async () => {
      try {
        const nextView = await loadPortalViewAction(selectedProjectId, value)
        setView(nextView)
      } catch (error) {
        console.error("Unable to switch portal audience", error)
        toast.error("Channel switch failed", {
          description: "Could not load the requested portal view.",
        })
      }
    })
  }

  const handleSendMessage = async () => {
    if (!selectedProjectId || !messageBody.trim()) return

    setIsSending(true)
    try {
      const message = await sendPortalMessageAction({
        project_id: selectedProjectId,
        channel,
        body: messageBody,
      })

      setView((current) => (current ? { ...current, messages: [...current.messages, message] } : current))
      setMessageBody("")
    } catch (error) {
      console.error("Failed to send portal message", error)
      toast.error("Message not sent", {
        description: "Please try again in a few seconds.",
      })
    } finally {
      setIsSending(false)
    }
  }

  if (!projects.length) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground">
          No projects available yet. Create a project to open a client or sub portal.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Portals</p>
          <h1 className="text-2xl font-bold">Client & Sub Portal</h1>
          <p className="text-muted-foreground text-sm">
            Share read-only status, files, and a dedicated message thread with external partners.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select value={selectedProjectId} onValueChange={handleProjectChange}>
            <SelectTrigger className="min-w-[220px]">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 rounded-lg border bg-card/50 p-1">
            {(["client", "sub"] as ConversationChannel[]).map((audience) => (
              <Button
                key={audience}
                variant={channel === audience ? "default" : "ghost"}
                size="sm"
                className={cn("h-9 px-3", channel === audience ? "shadow-sm" : "text-muted-foreground")}
                onClick={() => handleChannelChange(audience)}
                disabled={isPending}
              >
                <div className="flex items-center gap-2">
                  {audience === "client" ? <MessageSquare className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                  <span className="capitalize">{audience}</span>
                </div>
              </Button>
            ))}
          </div>
        </div>
      </div>

      {view ? (
        <div className="grid gap-6 lg:grid-cols-[2fr,1.1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div className="space-y-2">
                  <CardTitle className="text-xl">{view.project.name}</CardTitle>
                  {view.project.address && <p className="text-sm text-muted-foreground">{view.project.address}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn("capitalize", statusStyles[view.project.status] ?? "")}>{view.project.status}</Badge>
                    {view.project.start_date && (
                      <Badge variant="secondary" className="gap-1">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {format(new Date(view.project.start_date), "MMM d, yyyy")}
                      </Badge>
                    )}
                    {view.project.end_date && (
                      <Badge variant="secondary" className="gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {format(new Date(view.project.end_date), "MMM d, yyyy")}
                      </Badge>
                    )}
                  </div>
                </div>
                {isPending && <Spinner className="text-muted-foreground" />}
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <StatTile label="Audience" value={channel === "client" ? "Client-facing" : "Sub-facing"} icon={MessageSquare} />
                <StatTile label="Shared files" value={`${view.sharedFiles.length} files`} icon={FileText} />
                <StatTile label="Recent logs" value={`${view.recentLogs.length} entries`} icon={ClipboardList} />
                <StatTile label="Upcoming items" value={`${view.schedule.length} scheduled`} icon={CalendarDays} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarDays className="h-4 w-4" /> Upcoming schedule
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {view.schedule.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No schedule items shared for this project yet.</p>
                ) : (
                  view.schedule.map((item) => (
                    <div key={item.id} className="rounded-lg border bg-card/50 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-sm">{item.name}</p>
                          <p className="text-xs text-muted-foreground capitalize">{item.item_type}</p>
                        </div>
                        <Badge variant="secondary" className="capitalize text-xs">
                          {item.status.replaceAll("_", " ")}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{formatDateRange(item.start_date, item.end_date)}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ClipboardList className="h-4 w-4" /> Recent daily logs
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {view.recentLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No daily logs shared yet.</p>
                  ) : (
                    view.recentLogs.map((log) => (
                      <div key={log.id} className="rounded-lg border bg-card/50 p-3">
                        <p className="text-sm font-medium">{format(new Date(log.date), "MMM d, yyyy")}</p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{log.notes || "No notes recorded."}</p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-4 w-4" /> Shared files
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {view.sharedFiles.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No files shared with this audience yet.</p>
                  ) : (
                    view.sharedFiles.map((file) => (
                      <div key={file.id} className="flex items-center justify-between rounded-lg border bg-card/50 p-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{file.file_name}</p>
                            <p className="text-xs text-muted-foreground">{format(new Date(file.created_at), "MMM d")}</p>
                          </div>
                        </div>
                        <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Messages ({channel})</CardTitle>
                <p className="text-xs text-muted-foreground">Shared thread visible to the selected audience.</p>
              </div>
              {isPending && <Spinner className="text-muted-foreground" />}
            </CardHeader>
            <Separator />
            <ScrollArea className="flex-1 px-4 py-3">
              <div className="space-y-4">
                {view.messages.length === 0 ? (
                  <div className="rounded-lg border bg-card/40 p-4 text-sm text-muted-foreground">
                    No messages yet. Start the conversation to brief the {channel}.
                  </div>
                ) : (
                  view.messages.map((message) => <MessageBubble key={message.id} message={message} />)
                )}
              </div>
            </ScrollArea>
            <Separator />
            <div className="space-y-2 p-4">
              <Textarea
                placeholder={channel === "client" ? "Share an update for the client..." : "Share an update for subs..."}
                value={messageBody}
                onChange={(event) => setMessageBody(event.target.value)}
                disabled={isSending}
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Portal messages post to the shared thread for this project.</p>
                <Button onClick={handleSendMessage} disabled={!messageBody.trim() || isSending || isPending}>
                  {isSending ? <Spinner className="mr-2 h-4 w-4" /> : <ArrowUpRight className="mr-2 h-4 w-4" />}
                  Send
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="p-6 text-muted-foreground">
            Select a project to load its portal view.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card/50 p-3">
      <div className="rounded-md bg-muted p-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold">{value}</p>
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: PortalMessage }) {
  const senderName = message.sender_name || "Portal user"
  const timestamp = formatDistanceToNow(new Date(message.sent_at), { addSuffix: true })

  return (
    <div className="flex gap-3">
      <Avatar className="h-9 w-9">
        {message.sender_avatar_url && <AvatarImage src={message.sender_avatar_url} alt={senderName} />}
        <AvatarFallback>{getInitials(senderName)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold leading-tight">{senderName}</p>
          <span className="text-xs text-muted-foreground whitespace-nowrap">{timestamp}</span>
        </div>
        <div className="rounded-lg border bg-card/60 p-3 text-sm leading-relaxed">{message.body || "(no content)"}</div>
      </div>
    </div>
  )
}

function formatDateRange(start?: string, end?: string) {
  if (!start && !end) return "No dates"
  if (start && end && start === end) return format(new Date(start), "MMM d, yyyy")
  if (start && end) return `${format(new Date(start), "MMM d")} – ${format(new Date(end), "MMM d")}`
  if (start) return format(new Date(start), "MMM d, yyyy")
  if (end) return format(new Date(end), "MMM d, yyyy")
  return "No dates"
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}
