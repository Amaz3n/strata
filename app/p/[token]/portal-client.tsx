"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ClientPortalData } from "@/lib/types"
import { cn } from "@/lib/utils"
import { loadPortalMessagesAction, sendPortalMessageAction } from "./messages/actions"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface PortalPublicClientProps {
  data: ClientPortalData
  token: string
  portalType?: "client" | "sub"
  canMessage?: boolean
}

const statusStyles: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

export function PortalPublicClient({ data, token, portalType = "client", canMessage = false }: PortalPublicClientProps) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-2 text-center">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Strata Portal</p>
        <h1 className="text-2xl font-bold">{data.project.name}</h1>
        <div className="flex flex-wrap justify-center gap-2">
          <Badge variant="outline" className={cn("capitalize", statusStyles[data.project.status] ?? "")}>
            {data.project.status.replaceAll("_", " ")}
          </Badge>
          {data.project.start_date && (
            <Badge variant="secondary">Start {format(new Date(data.project.start_date), "MMM d, yyyy")}</Badge>
          )}
          {data.project.end_date && (
            <Badge variant="secondary">Target {format(new Date(data.project.end_date), "MMM d, yyyy")}</Badge>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schedule highlights</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.schedule.length === 0 ? (
              <p className="text-sm text-muted-foreground">No schedule items shared yet.</p>
            ) : (
              data.schedule.map((item) => (
                <div key={item.id} className="rounded-lg border bg-card/50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{item.name}</p>
                    <Badge variant="secondary" className="capitalize text-[11px]">
                      {item.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDateRange(item.start_date, item.end_date)}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Pending change orders</CardTitle>
            <Badge variant="outline" className="text-[11px] capitalize">
              {portalType}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.pendingChangeOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No change orders awaiting your review.</p>
            ) : (
              data.pendingChangeOrders.map((co) => (
                <div key={co.id} className="rounded-lg border bg-card/50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{co.title}</p>
                    <Badge variant="outline" className="capitalize text-[11px]">
                      {co.status}
                    </Badge>
                  </div>
                  {co.summary && <p className="text-xs text-muted-foreground mt-1">{co.summary}</p>}
                  {co.total_cents != null && (
                    <p className="text-xs font-medium mt-1">${(co.total_cents / 100).toLocaleString()}</p>
                  )}
                  <a
                    className="mt-2 inline-flex text-xs text-primary underline"
                    href={`/${portalType === "client" ? "p" : "s"}/${token}/change-orders/${co.id}`}
                  >
                    Review & approve
                  </a>
                </div>
              ))
            )}
          </CardContent>
        </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Invoices</CardTitle>
          <Badge variant="outline" className="text-[11px] capitalize">
            Billing
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices shared yet.</p>
          ) : (
            data.invoices.map((inv) => (
              <div key={inv.id} className="rounded-lg border bg-card/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">
                    {inv.invoice_number} — {inv.title}
                  </p>
                  <Badge variant="outline" className="capitalize text-[11px]">
                    {inv.status}
                  </Badge>
                </div>
                {inv.total_cents != null && (
                  <p className="text-xs font-medium mt-1">${(inv.total_cents / 100).toLocaleString()}</p>
                )}
                {inv.due_date && (
                  <p className="text-xs text-muted-foreground">Due {format(new Date(inv.due_date), "MMM d, yyyy")}</p>
                )}
                <a
                  className="mt-2 inline-flex text-xs text-primary underline"
                  href={
                    inv.token
                      ? `/i/${inv.token}`
                      : `/${portalType === "client" ? "p" : "s"}/${token}/invoices/${inv.id}`
                  }
                >
                  View invoice
                </a>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent updates</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Daily logs</h3>
            {data.recentLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No shared daily logs yet.</p>
            ) : (
              data.recentLogs.map((log) => (
                <div key={log.id} className="rounded-lg border bg-card/50 p-3">
                  <p className="text-sm font-medium">{format(new Date(log.date ?? log.created_at), "MMM d, yyyy")}</p>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {log.notes || log.summary || "No notes recorded."}
                  </p>
                </div>
              ))
            )}
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Shared files</h3>
            {data.sharedFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files shared yet.</p>
            ) : (
              <ScrollArea className="max-h-64 pr-3">
                <div className="space-y-2">
                  {data.sharedFiles.map((file) => (
                    <div key={file.id} className="rounded-lg border bg-card/40 p-3">
                      <p className="text-sm font-semibold truncate">{file.file_name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {format(new Date(file.created_at), "MMM d, yyyy")}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </CardContent>
      </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Selections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.pendingSelections.length === 0 ? (
              <p className="text-sm text-muted-foreground">No selections assigned yet.</p>
            ) : (
              <>
                {data.pendingSelections.map((selection) => (
                  <div key={selection.id} className="rounded-lg border bg-card/50 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Selection #{selection.id.slice(0, 6)}</p>
                      <Badge variant="secondary" className="capitalize text-[11px]">
                        {selection.status}
                      </Badge>
                    </div>
                    {selection.due_date && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Due {format(new Date(selection.due_date), "MMM d, yyyy")}
                      </p>
                    )}
                  </div>
                ))}
                <a
                  className="inline-flex text-sm text-primary underline"
                  href={`/${portalType === "client" ? "p" : "s"}/${token}/selections`}
                >
                  View & choose selections
                </a>
              </>
            )}
          </CardContent>
        </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Punch list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.punchItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No punch items tracked yet.</p>
          ) : (
            data.punchItems.map((item) => (
              <div key={item.id} className="rounded-lg border bg-card/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{item.title}</p>
                  <Badge variant="outline" className="capitalize text-[11px]">
                    {item.status}
                  </Badge>
                </div>
                {item.location && <p className="text-xs text-muted-foreground mt-1">{item.location}</p>}
              </div>
            ))
          )}
          {portalType === "client" && (
            <a
              className="inline-flex text-sm text-primary underline"
              href={`/p/${token}/punch-list`}
            >
              Add or review punch items
            </a>
          )}
        </CardContent>
      </Card>

      {canMessage && (
        <MessagePanel portalType={portalType} token={token} initialMessages={data.messages} />
      )}
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

function MessagePanel({
  initialMessages,
  token,
  portalType,
}: {
  initialMessages: ClientPortalData["messages"]
  token: string
  portalType: "client" | "sub"
}) {
  const [messages, setMessages] = useState(initialMessages)
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()

  const handleSend = () => {
    if (!body.trim()) return
    startTransition(async () => {
      try {
        const message = await sendPortalMessageAction({ token, body, senderName: portalType === "client" ? "Client" : "Sub" })
        setMessages((prev) => [...prev, message])
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  const refresh = () => {
    startTransition(async () => {
      const latest = await loadPortalMessagesAction(token)
      setMessages(latest)
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Messages</CardTitle>
        {isPending && <Spinner className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <Separator />
      <ScrollArea className="max-h-[320px] px-4 py-3">
        <div className="space-y-3">
          {messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
          {messages.map((msg) => (
            <div key={msg.id} className="rounded-lg border bg-card/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{msg.sender_name ?? "Portal user"}</p>
                <span className="text-[11px] text-muted-foreground">
                  {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                </span>
              </div>
              <p className="text-sm text-foreground whitespace-pre-line">{msg.body}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
      <Separator />
      <div className="space-y-2 p-4">
        <Textarea
          placeholder="Type a message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isPending}
        />
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isPending}>
            Refresh
          </Button>
          <Button onClick={handleSend} disabled={isPending || !body.trim()}>
            {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Send
          </Button>
        </div>
      </div>
    </Card>
  )
}

