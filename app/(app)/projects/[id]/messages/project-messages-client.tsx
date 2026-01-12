"use client"

import { useState } from "react"
import { format } from "date-fns"
import { MessageCircle, Users, User, Send } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import type { Project, PortalMessage } from "@/lib/types"
import { sendProjectMessageAction } from "./actions"

interface ProjectMessagesClientProps {
  project: Project
  clientMessages: PortalMessage[]
  subMessages: PortalMessage[]
  clientConversationId?: string
  subConversationId?: string
}

export function ProjectMessagesClient({
  project,
  clientMessages,
  subMessages,
  clientConversationId,
  subConversationId,
}: ProjectMessagesClientProps) {
  const [clientMsgs, setClientMsgs] = useState(clientMessages)
  const [subMsgs, setSubMsgs] = useState(subMessages)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [clientMessageBody, setClientMessageBody] = useState("")
  const [subMessageBody, setSubMessageBody] = useState("")
  const [activeTab, setActiveTab] = useState<"client" | "sub">("client")

  const handleSendMessage = async (conversationId: string, body: string, channel: "client" | "sub") => {
    if (!body.trim()) return

    setSendingMessage(true)
    try {
      const message = await sendProjectMessageAction(project.id, conversationId, body.trim())

      if (channel === "client") {
        setClientMsgs(prev => [...prev, message])
        setClientMessageBody("")
      } else {
        setSubMsgs(prev => [...prev, message])
        setSubMessageBody("")
      }
    } catch (error) {
      console.error("Failed to send message:", error)
    } finally {
      setSendingMessage(false)
    }
  }

  const MessageList = ({
    messages,
    channel,
    conversationId,
    messageBody,
    setMessageBody
  }: {
    messages: PortalMessage[],
    channel: "client" | "sub",
    conversationId?: string,
    messageBody: string,
    setMessageBody: (body: string) => void
  }) => (
    <div className="space-y-4">
      {messages.length === 0 ? (
        <div className="text-center py-12">
          <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">No messages yet</p>
          <p className="text-sm text-muted-foreground">
            Messages from {channel === "client" ? "the client" : "subcontractors"} will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <Card key={msg.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    {channel === "client" ? (
                      <User className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Users className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium">
                      {msg.sender_name || (channel === "client" ? "Client" : "Subcontractor")}
                    </span>
                    <Badge variant="secondary" className="text-[11px]">
                      {channel === "client" ? "Client" : "Sub"}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-line">{msg.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Message input for PM responses */}
      <Card>
        <CardContent className="p-4">
          <div className="space-y-3">
            <Textarea
              placeholder={`Reply to ${channel === "client" ? "client" : "subcontractors"}...`}
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              disabled={sendingMessage}
              className="min-h-[80px] resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && conversationId) {
                  e.preventDefault()
                  handleSendMessage(conversationId, messageBody, channel)
                }
              }}
            />
            <div className="flex justify-end">
              <Button
                onClick={() => conversationId && handleSendMessage(conversationId, messageBody, channel)}
                disabled={sendingMessage || !messageBody.trim() || !conversationId}
                size="sm"
              >
                {sendingMessage && <Spinner className="mr-2 h-3 w-3" />}
                <Send className="h-4 w-4 mr-1" />
                Send Message
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Messages</h1>
        <p className="text-muted-foreground">
          View conversations with clients and subcontractors
        </p>
      </div>

      <Tabs defaultValue="client" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="client" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Client ({clientMsgs.length})
          </TabsTrigger>
          <TabsTrigger value="sub" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Subcontractors ({subMsgs.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="client" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Client Conversation
              </CardTitle>
            </CardHeader>
            <CardContent>
              <MessageList
                messages={clientMsgs}
                channel="client"
                conversationId={clientConversationId}
                messageBody={clientMessageBody}
                setMessageBody={setClientMessageBody}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sub" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Subcontractor Conversations
              </CardTitle>
            </CardHeader>
            <CardContent>
              <MessageList
                messages={subMsgs}
                channel="sub"
                conversationId={subConversationId}
                messageBody={subMessageBody}
                setMessageBody={setSubMessageBody}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
