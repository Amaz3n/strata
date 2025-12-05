"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"

import type { PortalMessage, Submittal } from "@/lib/types"
import { loadPortalEntityMessagesAction, sendPortalEntityMessageAction } from "@/app/p/[token]/messages/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface SubmittalsPortalClientProps {
  submittals: Submittal[]
  token: string
}

export function SubmittalsPortalClient({ submittals, token }: SubmittalsPortalClientProps) {
  const [selected, setSelected] = useState<Submittal | null>(null)
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    loadPortalEntityMessagesAction({ token, entityType: "submittal", entityId: selected.id })
      .then((msgs) => setMessages(msgs))
      .catch((err) => console.error("Failed to load submittal messages", err))
      .finally(() => setLoadingThread(false))
  }, [selected, token])

  const handleSend = () => {
    if (!selected || !body.trim()) return
    startTransition(async () => {
      try {
        const message = await sendPortalEntityMessageAction({
          token,
          entityType: "submittal",
          entityId: selected.id,
          body,
          senderName: "Portal user",
        })
        setMessages((prev) => [...prev, message])
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Submittals</p>
          <h1 className="text-2xl font-bold">Project submittals</h1>
          <p className="text-sm text-muted-foreground">Review materials and approvals.</p>
        </header>

        {submittals.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">No submittals yet.</CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {submittals.map((sub) => (
            <Card key={sub.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Submittal #{sub.submittal_number}</CardTitle>
                <Badge variant="secondary" className="capitalize text-[11px]">
                  {sub.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{sub.title}</p>
                  {sub.description && <p className="text-sm text-muted-foreground">{sub.description}</p>}
                  {sub.spec_section && (
                    <p className="text-xs text-muted-foreground">Spec: {sub.spec_section}</p>
                  )}
                  {sub.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {format(new Date(sub.due_date), "MMM d, yyyy")}
                    </p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelected(sub)}>
                  View messages
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selected ? `Submittal #${selected.submittal_number}: ${selected.title}` : "Messages"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Description</p>
              <p className="text-sm text-muted-foreground">
                {selected?.description ?? "No description provided."}
              </p>
            </div>
            <Separator />
            <div className="h-64 rounded-lg border">
              <ScrollArea className="h-full p-3">
                {loadingThread ? (
                  <div className="flex h-full items-center justify-center">
                    <Spinner className="h-4 w-4 text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages yet.</p>
                ) : (
                  <div className="space-y-3">
                    {messages.map((msg) => (
                      <div key={msg.id} className="rounded-md border bg-card/50 p-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{msg.sender_name ?? "Portal user"}</span>
                          <span>{format(new Date(msg.sent_at), "MMM d, h:mm a")}</span>
                        </div>
                        <p className="text-sm whitespace-pre-line">{msg.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
            <div className="space-y-2">
              <Textarea
                placeholder="Type a message"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={isPending || loadingThread}
              />
              <div className="flex justify-end">
                <Button onClick={handleSend} disabled={isPending || loadingThread || !body.trim()}>
                  {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  Send
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

