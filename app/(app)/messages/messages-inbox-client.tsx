"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNow } from "date-fns"

import {
  listProjectSubRecipientsAction,
  loadConversationMessagesAction,
  sendConversationMessageAction,
  startConversationAction,
} from "./actions"
import type { OrgConversationInboxItem } from "@/lib/services/conversations"
import type { PortalMessage } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Plus, Send } from "@/components/icons"

type ProjectSummary = {
  id: string
  name: string
  status?: string
}

interface MessagesInboxClientProps {
  conversations: OrgConversationInboxItem[]
  initialConversationId: string | null
  initialMessages: PortalMessage[]
  projects: ProjectSummary[]
}

function getThreadLabel(item: OrgConversationInboxItem) {
  if (item.channel === "client") return "Client"
  if (item.channel === "sub") return item.audience_company_name || "Subcontractor"
  return "Internal"
}

function getLastActivity(lastMessageAt?: string | null) {
  if (!lastMessageAt) return "No activity yet"
  return formatDistanceToNow(new Date(lastMessageAt), { addSuffix: true })
}

function sortByLastActivity(items: OrgConversationInboxItem[]) {
  return [...items].sort((a, b) => {
    const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
    const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
    return bTime - aTime
  })
}

export function MessagesInboxClient({
  conversations: initialConversations,
  initialConversationId,
  initialMessages,
  projects,
}: MessagesInboxClientProps) {
  const router = useRouter()
  const [conversations, setConversations] = useState<OrgConversationInboxItem[]>(
    sortByLastActivity(initialConversations)
  )
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(initialConversationId)
  const [messages, setMessages] = useState<PortalMessage[]>(initialMessages)
  const [draft, setDraft] = useState("")
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatProjectId, setNewChatProjectId] = useState<string>("")
  const [newChatChannel, setNewChatChannel] = useState<"client" | "sub">("client")
  const [subRecipients, setSubRecipients] = useState<{ id: string; name: string; trade?: string }[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("")
  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [creatingConversation, setCreatingConversation] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    if (!newChatOpen || !newChatProjectId || newChatChannel !== "sub") {
      setSubRecipients([])
      setSelectedCompanyId("")
      return
    }

    let cancelled = false
    setLoadingRecipients(true)
    listProjectSubRecipientsAction(newChatProjectId)
      .then((companies) => {
        if (!cancelled) {
          setSubRecipients(companies)
        }
      })
      .catch((error) => {
        console.error("Failed to load subcontractor recipients", error)
        if (!cancelled) {
          setSubRecipients([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRecipients(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [newChatOpen, newChatProjectId, newChatChannel])

  const handleSelectConversation = async (conversationId: string) => {
    if (conversationId === selectedConversationId) return

    setSelectedConversationId(conversationId)
    setLoadingMessages(true)
    router.replace(`/messages?conversationId=${conversationId}`, { scroll: false })

    try {
      const loaded = await loadConversationMessagesAction(conversationId)
      setMessages(loaded)
    } catch (error) {
      console.error("Failed to load conversation messages", error)
      setMessages([])
    } finally {
      setLoadingMessages(false)
    }
  }

  const handleStartConversation = async () => {
    if (!newChatProjectId) return
    if (newChatChannel === "sub" && !selectedCompanyId) return

    setCreatingConversation(true)
    try {
      const conversation = await startConversationAction({
        projectId: newChatProjectId,
        channel: newChatChannel,
        companyId: newChatChannel === "sub" ? selectedCompanyId : undefined,
      })

      const existing = conversations.find((item) => item.id === conversation.id)
      if (!existing) {
        const project = projectMap.get(newChatProjectId)
        const newInboxItem: OrgConversationInboxItem = {
          ...conversation,
          project_name: project?.name ?? "Unknown project",
          project_status: project?.status ?? null,
          last_message_at: conversation.last_message_at ?? null,
          last_message_body: null,
          last_message_sender_name: null,
        }
        setConversations((prev) => sortByLastActivity([newInboxItem, ...prev]))
      }

      setSelectedConversationId(conversation.id)
      setLoadingMessages(true)
      router.replace(`/messages?conversationId=${conversation.id}`, { scroll: false })
      const loaded = await loadConversationMessagesAction(conversation.id)
      setMessages(loaded)
      setDraft("")
      setNewChatOpen(false)
      setNewChatProjectId("")
      setNewChatChannel("client")
      setSelectedCompanyId("")
      setSubRecipients([])
    } catch (error) {
      console.error("Failed to start conversation", error)
    } finally {
      setLoadingMessages(false)
      setCreatingConversation(false)
    }
  }

  const handleSend = () => {
    if (!selectedConversationId || !draft.trim()) return

    const body = draft
    setDraft("")

    startTransition(async () => {
      try {
        const sent = await sendConversationMessageAction(selectedConversationId, body)
        setMessages((prev) => [...prev, sent])
        setConversations((prev) => {
          const updated = prev.map((item) =>
            item.id === selectedConversationId
              ? {
                  ...item,
                  last_message_body: sent.body ?? null,
                  last_message_sender_name: sent.sender_name ?? "You",
                  last_message_at: sent.sent_at,
                }
              : item
          )
          return sortByLastActivity(updated)
        })
      } catch (error) {
        console.error("Failed to send message", error)
        setDraft(body)
      }
    })
  }

  return (
    <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-1 overflow-hidden rounded-xl border bg-card lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="border-r">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">All Conversations</h2>
          <Button size="sm" variant="outline" onClick={() => setNewChatOpen(true)}>
            <Plus className="size-4" />
            New chat
          </Button>
        </div>
        <ScrollArea className="h-[calc(100%-53px)]">
          <div className="space-y-1 p-2">
            {conversations.map((conversation) => {
              const isSelected = conversation.id === selectedConversationId
              const preview = conversation.last_message_body?.trim() || "No messages yet"
              const projectName = conversation.project_name ?? "Unknown project"

              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => handleSelectConversation(conversation.id)}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent/40",
                    isSelected && "bg-accent border-accent-foreground/20"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{projectName}</span>
                    <Badge variant="outline" className="shrink-0">
                      {getThreadLabel(conversation)}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{preview}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{getLastActivity(conversation.last_message_at)}</p>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="border-b px-4 py-3">
          {selectedConversation ? (
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{selectedConversation.project_name ?? "Unknown project"}</h3>
              <Badge variant="outline">{getThreadLabel(selectedConversation)}</Badge>
            </div>
          ) : (
            <h3 className="text-sm font-semibold">Select a conversation</h3>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {!selectedConversation ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              Select a conversation to start messaging.
            </div>
          ) : loadingMessages ? (
            <div className="flex h-full items-center justify-center p-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-3 p-4">
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages yet.</p>
                ) : (
                  messages.map((message) => (
                    <div key={message.id} className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">
                        {message.sender_name ?? "Unknown"} · {getLastActivity(message.sent_at)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{message.body ?? ""}</p>
                    </div>
                  ))
                )}
                <div ref={endRef} />
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={selectedConversation ? "Type a message..." : "Select a conversation first"}
              className="min-h-[76px]"
              disabled={!selectedConversation || isPending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  handleSend()
                }
              }}
            />
            <Button onClick={handleSend} disabled={!selectedConversation || !draft.trim() || isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start New Chat</DialogTitle>
            <DialogDescription>Create or open a thread for a project audience.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Project</Label>
              <Select value={newChatProjectId} onValueChange={setNewChatProjectId}>
                <SelectTrigger className="w-full">
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
            </div>

            <div className="space-y-2">
              <Label>Audience</Label>
              <Select
                value={newChatChannel}
                onValueChange={(value: "client" | "sub") => setNewChatChannel(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">Client</SelectItem>
                  <SelectItem value="sub">Subcontractor</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newChatChannel === "sub" && (
              <div className="space-y-2">
                <Label>Subcontractor</Label>
                <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        !newChatProjectId
                          ? "Select project first"
                          : loadingRecipients
                            ? "Loading recipients..."
                            : "Select subcontractor"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {subRecipients.map((recipient) => (
                      <SelectItem key={recipient.id} value={recipient.id}>
                        {recipient.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setNewChatOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleStartConversation}
              disabled={
                creatingConversation ||
                !newChatProjectId ||
                (newChatChannel === "sub" && !selectedCompanyId)
              }
            >
              {creatingConversation ? <Loader2 className="size-4 animate-spin" /> : null}
              Open chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
