"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { format } from "date-fns"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { loadPortalMessagesAction, sendPortalMessageAction } from "@/app/p/[token]/messages/actions"
import type { ClientPortalData } from "@/lib/types"

interface PortalMessagesTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
  canMessage: boolean
}

export function PortalMessagesTab({ data, token, portalType, canMessage }: PortalMessagesTabProps) {
  const [messages, setMessages] = useState(data.messages)
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = () => {
    if (!body.trim() || !canMessage) return

    startTransition(async () => {
      try {
        const message = await sendPortalMessageAction({
          token,
          body,
          senderName: portalType === "client" ? "Client" : "Sub"
        })
        setMessages((prev) => [...prev, message])
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  const handleRefresh = () => {
    startTransition(async () => {
      const latest = await loadPortalMessagesAction(token)
      setMessages(latest)
    })
  }

  if (!canMessage) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>Messaging is not enabled for this portal</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pb-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No messages yet</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-sm font-medium">{msg.sender_name ?? "Portal user"}</p>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                </span>
              </div>
              <p className="text-sm whitespace-pre-line">{msg.body}</p>
            </div>
          ))
        )}
      </div>

      <div className="border-t pt-3 space-y-2">
        <Textarea
          placeholder="Type a message..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isPending}
          className="min-h-[80px] resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isPending}>
            {isPending && <Spinner className="mr-2 h-3 w-3" />}
            Refresh
          </Button>
          <Button onClick={handleSend} disabled={isPending || !body.trim()} size="sm">
            <Send className="h-4 w-4 mr-1" />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
