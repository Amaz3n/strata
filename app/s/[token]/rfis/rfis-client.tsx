"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"

import type { PortalMessage, Rfi } from "@/lib/types"
import { loadPortalEntityMessagesAction, sendPortalEntityMessageAction } from "@/app/p/[token]/messages/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface RfisPortalClientProps {
  rfis: Rfi[]
  token: string
}

export function RfisPortalClient({ rfis, token }: RfisPortalClientProps) {
  const [selected, setSelected] = useState<Rfi | null>(null)
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    loadPortalEntityMessagesAction({ token, entityType: "rfi", entityId: selected.id })
      .then((msgs) => setMessages(msgs))
      .catch((err) => console.error("Failed to load RFI messages", err))
      .finally(() => setLoadingThread(false))
  }, [selected, token])

  const handleSend = () => {
    if (!selected || !body.trim()) return
    startTransition(async () => {
      try {
        const message = await sendPortalEntityMessageAction({
          token,
          entityType: "rfi",
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
          <p className="text-xs uppercase tracking-wide text-muted-foreground">RFIs</p>
          <h1 className="text-2xl font-bold">Requests for Information</h1>
          <p className="text-sm text-muted-foreground">Review RFIs assigned to this project.</p>
        </header>

        {rfis.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">No RFIs yet.</CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {rfis.map((rfi) => (
            <Card key={rfi.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">RFI #{rfi.rfi_number}</CardTitle>
                <Badge variant="secondary" className="capitalize text-[11px]">
                  {rfi.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{rfi.subject}</p>
                  <p className="text-sm text-muted-foreground">{rfi.question}</p>
                  {rfi.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {format(new Date(rfi.due_date), "MMM d, yyyy")}
                    </p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelected(rfi)}>
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
              {selected ? `RFI #${selected.rfi_number}: ${selected.subject}` : "Messages"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Question</p>
              <p className="text-sm text-muted-foreground">{selected?.question}</p>
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

