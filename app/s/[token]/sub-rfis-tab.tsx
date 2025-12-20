"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"
import { HelpCircle } from "lucide-react"
import type { PortalMessage, Rfi } from "@/lib/types"
import {
  loadPortalEntityMessagesAction,
  sendPortalEntityMessageAction,
} from "@/app/p/[token]/messages/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface SubRfisTabProps {
  rfis: Rfi[]
  token: string
}

const statusColors: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/30",
  pending: "bg-blue-500/20 text-blue-500 border-blue-500/30",
  answered: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground",
}

export function SubRfisTab({ rfis, token }: SubRfisTabProps) {
  const [selected, setSelected] = useState<Rfi | null>(null)
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    loadPortalEntityMessagesAction({
      token,
      entityType: "rfi",
      entityId: selected.id,
    })
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
          senderName: "Sub Portal",
        })
        setMessages((prev) => [...prev, message])
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  if (rfis.length === 0) {
    return (
      <div className="text-center py-12">
        <HelpCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">No RFIs assigned to you</p>
        <p className="text-sm text-muted-foreground">
          Requests for information will appear here when assigned
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {rfis.map((rfi) => (
          <Card key={rfi.id}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-base">RFI #{rfi.rfi_number}</CardTitle>
              <Badge
                variant="outline"
                className={`capitalize text-xs ${statusColors[rfi.status] ?? ""}`}
              >
                {rfi.status}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{rfi.subject}</p>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {rfi.question}
                </p>
              </div>
              <div className="flex items-center justify-between">
                {rfi.due_date && (
                  <p className="text-xs text-muted-foreground">
                    Due {format(new Date(rfi.due_date), "MMM d, yyyy")}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(rfi)}
                >
                  View & Respond
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => (open ? null : setSelected(null))}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {selected
                ? `RFI #${selected.rfi_number}: ${selected.subject}`
                : "RFI Details"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium mb-1">Question</p>
              <p className="text-sm text-muted-foreground">{selected?.question}</p>
            </div>
            <Separator />
            <div className="flex-1 min-h-0 rounded-lg border">
              <ScrollArea className="h-full max-h-[200px] p-3">
                {loadingThread ? (
                  <div className="flex h-full items-center justify-center py-8">
                    <Spinner className="h-4 w-4 text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No messages yet. Start the conversation below.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {messages.map((msg) => (
                      <div key={msg.id} className="rounded-md border bg-card/50 p-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                          <span>{msg.sender_name ?? "Portal user"}</span>
                          <span>
                            {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                          </span>
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
                placeholder="Type your response..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={isPending || loadingThread}
                rows={3}
              />
              <div className="flex justify-end">
                <Button
                  onClick={handleSend}
                  disabled={isPending || loadingThread || !body.trim()}
                >
                  {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  Send Response
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
