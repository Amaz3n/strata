"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { formatDistanceToNow } from "date-fns"
import {
  MessageCircle,
  Send,
  User,
  Inbox,
  PenSquare,
  X,
  Paperclip,
  FileText,
  Download,
  FolderPlus,
  Loader2,
  Check,
  ChevronLeft,
  MoreVertical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { Project, PortalMessage } from "@/lib/types"
import type { ConversationWithCompany, MessageAttachment } from "@/lib/services/conversations"
import {
  sendProjectMessageAction,
  createSubConversationAction,
  loadSubConversationMessagesAction,
  uploadMessageFileAction,
  getMessageAttachmentsAction,
  saveAttachmentToProjectFilesAction,
  getFileSignedUrlAction,
} from "./actions"

interface ConversationWithPreview extends ConversationWithCompany {
  last_message_body?: string | null
  last_message_sender_name?: string | null
}

interface SubCompany {
  id: string
  name: string
  trade?: string
}

interface PendingFile {
  id: string
  file: File
  uploading: boolean
  uploaded: boolean
  fileId?: string
  url?: string
  error?: string
}

interface MessageWithAttachments extends PortalMessage {
  attachments?: MessageAttachment[]
}

interface ProjectMessagesClientProps {
  project: Project
  conversations: ConversationWithPreview[]
  subCompanies: SubCompany[]
  initialMessages: PortalMessage[]
  initialConversationId: string | null
  unreadCounts: Record<string, number>
}

export function ProjectMessagesClient({
  project,
  conversations: initialConversations,
  subCompanies,
  initialMessages,
  initialConversationId,
  unreadCounts: initialUnreadCounts,
}: ProjectMessagesClientProps) {
  const [conversations, setConversations] = useState(initialConversations)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(initialConversationId)
  const [messages, setMessages] = useState<MessageWithAttachments[]>(initialMessages)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [messageBody, setMessageBody] = useState("")
  const [unreadCounts, setUnreadCounts] = useState(initialUnreadCounts)
  const [isComposing, setIsComposing] = useState(false)
  const [creatingConversation, setCreatingConversation] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [savingAttachment, setSavingAttachment] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<"list" | "thread">("list")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId)
  const hasClientConversation = conversations.some((c) => c.channel === "client")

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Auto-switch to thread view on mobile when conversation is selected
  useEffect(() => {
    if (selectedConversationId) {
      setMobileView("thread")
    }
  }, [selectedConversationId])

  const loadAttachmentsForMessages = useCallback(async (msgs: PortalMessage[]) => {
    const messagesWithAttachments = await Promise.all(
      msgs.map(async (msg) => {
        if (msg.payload?.has_attachments) {
          try {
            const attachments = await getMessageAttachmentsAction(project.id, msg.id)
            return { ...msg, attachments }
          } catch (error) {
            console.error("Failed to load attachments:", error)
            return msg
          }
        }
        return msg
      })
    )
    return messagesWithAttachments
  }, [project.id])

  const handleSelectConversation = async (conversationId: string) => {
    if (conversationId === selectedConversationId && !isComposing) {
      setMobileView("thread")
      return
    }

    setSelectedConversationId(conversationId)
    setLoadingMessages(true)
    setIsComposing(false)
    setPendingFiles([])
    setMobileView("thread")

    try {
      const loadedMessages = await loadSubConversationMessagesAction(project.id, conversationId)
      const messagesWithAttachments = await loadAttachmentsForMessages(loadedMessages)
      setMessages(messagesWithAttachments)
      setUnreadCounts((prev) => ({ ...prev, [conversationId]: 0 }))
    } catch (error) {
      console.error("Failed to load messages:", error)
      toast.error("Failed to load messages")
    } finally {
      setLoadingMessages(false)
    }
  }

  const handleFileSelect = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const maxSize = 25 * 1024 * 1024

    for (const file of fileArray) {
      if (file.size > maxSize) {
        toast.error(`${file.name} exceeds 25MB limit`)
        continue
      }

      const pendingId = `${file.name}-${Date.now()}`
      setPendingFiles((prev) => [
        ...prev,
        { id: pendingId, file, uploading: true, uploaded: false },
      ])

      try {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", project.id)

        const result = await uploadMessageFileAction(formData)

        setPendingFiles((prev) =>
          prev.map((pf) =>
            pf.id === pendingId
              ? { ...pf, uploading: false, uploaded: true, fileId: result.id, url: result.url }
              : pf
          )
        )
      } catch (error) {
        console.error("Failed to upload file:", error)
        setPendingFiles((prev) =>
          prev.map((pf) =>
            pf.id === pendingId
              ? { ...pf, uploading: false, error: "Upload failed" }
              : pf
          )
        )
        toast.error(`Failed to upload ${file.name}`)
      }
    }
  }, [project.id])

  const removePendingFile = (id: string) => {
    setPendingFiles((prev) => prev.filter((pf) => pf.id !== id))
  }

  const handleSendMessage = async () => {
    if (!selectedConversationId) return
    if (!messageBody.trim() && pendingFiles.length === 0) return

    const uploadedFileIds = pendingFiles
      .filter((pf) => pf.uploaded && pf.fileId)
      .map((pf) => pf.fileId!)

    setSendingMessage(true)
    try {
      const message = await sendProjectMessageAction(
        project.id,
        selectedConversationId,
        messageBody.trim() || (uploadedFileIds.length > 0 ? "📎 Attachment" : ""),
        uploadedFileIds.length > 0 ? uploadedFileIds : undefined
      )

      let messageWithAttachments: MessageWithAttachments = message
      if (uploadedFileIds.length > 0) {
        try {
          const attachments = await getMessageAttachmentsAction(project.id, message.id)
          messageWithAttachments = { ...message, attachments }
        } catch (e) {
          console.error("Failed to load attachments for new message")
        }
      }

      setMessages((prev) => [...prev, messageWithAttachments])
      setMessageBody("")
      setPendingFiles([])

      setConversations((prev) =>
        prev.map((conv) =>
          conv.id === selectedConversationId
            ? {
                ...conv,
                last_message_body: message.body,
                last_message_sender_name: message.sender_name ?? "You",
                last_message_at: message.sent_at,
              }
            : conv
        )
      )
    } catch (error) {
      console.error("Failed to send message:", error)
      toast.error("Failed to send message")
    } finally {
      setSendingMessage(false)
    }
  }

  const handleStartNewChat = () => {
    setIsComposing(true)
    setSelectedConversationId(null)
    setMessages([])
    setMessageBody("")
    setPendingFiles([])
    setMobileView("thread")
  }

  const handleBackToList = () => {
    setMobileView("list")
    setIsComposing(false)
  }

  const handleSelectRecipient = async (type: "client" | "sub", companyId?: string) => {
    setCreatingConversation(true)
    try {
      if (type === "client") {
        const clientConv = conversations.find((c) => c.channel === "client")
        if (clientConv) {
          await handleSelectConversation(clientConv.id)
        }
      } else if (companyId) {
        const existingConv = conversations.find((c) => c.audience_company_id === companyId)
        if (existingConv) {
          await handleSelectConversation(existingConv.id)
        } else {
          const newConversation = await createSubConversationAction(project.id, companyId)
          const company = subCompanies.find((c) => c.id === companyId)
          const conversationWithPreview = {
            ...newConversation,
            audience_company_name: company?.name ?? null,
            last_message_body: null,
            last_message_sender_name: null,
          }
          setConversations((prev) => [conversationWithPreview, ...prev])
          setSelectedConversationId(newConversation.id)
          setMessages([])
          setIsComposing(false)
        }
      }
    } catch (error) {
      console.error("Failed to select recipient:", error)
      toast.error("Failed to create conversation")
    } finally {
      setCreatingConversation(false)
    }
  }

  const handleSaveToProjectFiles = async (fileId: string) => {
    setSavingAttachment(fileId)
    try {
      await saveAttachmentToProjectFilesAction(project.id, fileId)
      toast.success("File saved to project files")
    } catch (error) {
      console.error("Failed to save file:", error)
      toast.error("Failed to save file")
    } finally {
      setSavingAttachment(null)
    }
  }

  const handleDownloadAttachment = async (fileId: string, fileName: string) => {
    try {
      const url = await getFileSignedUrlAction(fileId)
      const link = document.createElement("a")
      link.href = url
      link.download = fileName
      link.target = "_blank"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error("Failed to download file:", error)
      toast.error("Failed to download file")
    }
  }

  const getConversationLabel = (conv: ConversationWithPreview) => {
    if (conv.channel === "client") return "Client"
    return conv.audience_company_name || "Unknown"
  }

  const getInitials = (name: string) => {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const isImageFile = (mimeType?: string) => mimeType?.startsWith("image/")

  // Conversation List Component
  const ConversationList = () => (
    <div className={cn(
      "flex flex-col h-full bg-background",
      "md:w-80 md:border-r md:bg-muted/20",
      mobileView === "thread" && "hidden md:flex"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <h2 className="font-semibold text-lg">Messages</h2>
        <Button size="sm" onClick={handleStartNewChat} className="gap-1.5">
          <PenSquare className="h-4 w-4" />
          <span className="hidden sm:inline">New</span>
        </Button>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <Inbox className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium text-sm">No conversations</p>
            <p className="text-xs text-muted-foreground mt-1">Start a new message to begin</p>
          </div>
        ) : (
          <div className="divide-y">
            {conversations.map((conv) => {
              const unread = unreadCounts[conv.id] ?? 0
              const isSelected = conv.id === selectedConversationId
              const label = getConversationLabel(conv)

              return (
                <button
                  key={conv.id}
                  onClick={() => handleSelectConversation(conv.id)}
                  className={cn(
                    "w-full text-left p-3 transition-colors hover:bg-muted/50",
                    isSelected && "bg-primary/5 md:bg-primary/10"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 flex-shrink-0">
                      <AvatarFallback className={cn(
                        "text-xs font-medium",
                        conv.channel === "client"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      )}>
                        {getInitials(label)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-sm truncate",
                          unread > 0 ? "font-semibold" : "font-medium"
                        )}>
                          {label}
                        </span>
                        <Badge variant="outline" className={cn(
                          "text-[10px] px-1.5 py-0 h-4 font-normal flex-shrink-0",
                          conv.channel === "client"
                            ? "border-blue-200 text-blue-600 bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:bg-blue-950/50"
                            : "border-amber-200 text-amber-600 bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:bg-amber-950/50"
                        )}>
                          {conv.channel === "client" ? "Client" : "Sub"}
                        </Badge>
                        {unread > 0 && (
                          <Badge className="h-5 min-w-5 px-1.5 text-xs flex-shrink-0">
                            {unread}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {conv.last_message_body ? (
                          <p className={cn(
                            "text-xs truncate flex-1",
                            unread > 0 ? "text-foreground font-medium" : "text-muted-foreground"
                          )}>
                            {conv.last_message_body}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">No messages yet</p>
                        )}
                        {conv.last_message_at && (
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">
                            {formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: false })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )

  // Thread View Component
  const ThreadView = () => (
    <div className={cn(
      "flex-1 flex flex-col min-w-0 bg-background",
      mobileView === "list" && "hidden md:flex"
    )}>
      {isComposing ? (
        <>
          {/* Compose Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Button variant="ghost" size="icon" className="md:hidden h-9 w-9" onClick={handleBackToList}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h3 className="font-semibold flex-1">New Message</h3>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => {
              setIsComposing(false)
              setMobileView("list")
              if (conversations.length > 0) {
                handleSelectConversation(conversations[0].id)
              }
            }}>
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Recipient Selection */}
          <ScrollArea className="flex-1">
            <div className="p-4">
              <p className="text-sm text-muted-foreground mb-4">Select recipient:</p>
              <div className="space-y-2">
                {hasClientConversation && (
                  <button
                    onClick={() => handleSelectRecipient("client")}
                    disabled={creatingConversation}
                    className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        <User className="h-5 w-5" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">Client</p>
                      <p className="text-xs text-muted-foreground">Project client</p>
                    </div>
                  </button>
                )}

                {subCompanies.length > 0 && (
                  <>
                    <div className="pt-2 pb-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Subcontractors</p>
                    </div>
                    {subCompanies.map((company) => {
                      const hasConversation = conversations.some((c) => c.audience_company_id === company.id)
                      return (
                        <button
                          key={company.id}
                          onClick={() => handleSelectRecipient("sub", company.id)}
                          disabled={creatingConversation}
                          className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
                        >
                          <Avatar className="h-10 w-10">
                            <AvatarFallback className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-sm">
                              {getInitials(company.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{company.name}</p>
                            {company.trade && <p className="text-xs text-muted-foreground">{company.trade}</p>}
                          </div>
                          <Badge variant="outline" className="text-xs">
                            {hasConversation ? "Continue" : "New"}
                          </Badge>
                        </button>
                      )
                    })}
                  </>
                )}

                {subCompanies.length === 0 && !hasClientConversation && (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No contacts available</p>
                  </div>
                )}
              </div>

              {creatingConversation && (
                <div className="flex justify-center mt-4">
                  <Spinner className="h-5 w-5" />
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      ) : selectedConversation ? (
        <>
          {/* Thread Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Button variant="ghost" size="icon" className="md:hidden h-9 w-9" onClick={handleBackToList}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <Avatar className="h-9 w-9">
              <AvatarFallback className={cn(
                "text-xs font-medium",
                selectedConversation.channel === "client"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              )}>
                {getInitials(getConversationLabel(selectedConversation))}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm truncate">{getConversationLabel(selectedConversation)}</h3>
              <p className="text-xs text-muted-foreground">
                {selectedConversation.channel === "client" ? "Client" : "Subcontractor"}
              </p>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1">
            <div className="p-3 sm:p-4">
              {loadingMessages ? (
                <div className="flex justify-center py-12">
                  <Spinner className="h-6 w-6" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <MessageCircle className="h-10 w-10 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">No messages yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg) => {
                    const isOwn = !!msg.sender_id
                    const senderName = msg.sender_name || msg.payload?.sender_name ||
                      (selectedConversation.channel === "client" ? "Client" : "Subcontractor")

                    return (
                      <div key={msg.id} className={cn("flex", isOwn ? "justify-end" : "justify-start")}>
                        <div className={cn("flex gap-2 max-w-[85%] sm:max-w-[75%]", isOwn && "flex-row-reverse")}>
                          {!isOwn && (
                            <Avatar className="h-7 w-7 flex-shrink-0 mt-1">
                              <AvatarFallback className="text-[10px] bg-muted">
                                {getInitials(senderName)}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <div className="space-y-1 min-w-0">
                            {!isOwn && (
                              <p className="text-[11px] text-muted-foreground px-1">{senderName}</p>
                            )}
                            {msg.body && msg.body !== "📎 Attachment" && (
                              <div className={cn(
                                "rounded-2xl px-3 py-2",
                                isOwn
                                  ? "bg-primary text-primary-foreground rounded-br-sm"
                                  : "bg-muted rounded-bl-sm"
                              )}>
                                <p className="text-sm whitespace-pre-wrap break-words">{msg.body}</p>
                              </div>
                            )}

                            {/* Attachments */}
                            {msg.attachments && msg.attachments.length > 0 && (
                              <div className="space-y-1.5">
                                {msg.attachments.map((attachment) => (
                                  <div
                                    key={attachment.id}
                                    className={cn(
                                      "group rounded-lg border overflow-hidden",
                                      isOwn ? "bg-primary/5" : "bg-muted/50"
                                    )}
                                  >
                                    {isImageFile(attachment.mime_type) ? (
                                      <div className="relative">
                                        <img
                                          src={attachment.storage_path ? `/api/files/${attachment.file_id}/preview` : undefined}
                                          alt={attachment.file_name}
                                          className="max-w-full sm:max-w-[260px] max-h-[180px] object-cover"
                                          onError={(e) => { e.currentTarget.style.display = "none" }}
                                        />
                                        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                          <Button
                                            variant="secondary"
                                            size="icon"
                                            className="h-7 w-7"
                                            onClick={() => handleDownloadAttachment(attachment.file_id, attachment.file_name)}
                                          >
                                            <Download className="h-3.5 w-3.5" />
                                          </Button>
                                          {!isOwn && (
                                            <Button
                                              variant="secondary"
                                              size="icon"
                                              className="h-7 w-7"
                                              disabled={savingAttachment === attachment.file_id}
                                              onClick={() => handleSaveToProjectFiles(attachment.file_id)}
                                            >
                                              {savingAttachment === attachment.file_id ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                              ) : (
                                                <FolderPlus className="h-3.5 w-3.5" />
                                              )}
                                            </Button>
                                          )}
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2.5 p-2.5">
                                        <div className="h-9 w-9 rounded bg-muted flex items-center justify-center flex-shrink-0">
                                          <FileText className="h-4 w-4 text-muted-foreground" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-medium truncate">{attachment.file_name}</p>
                                          <p className="text-[10px] text-muted-foreground">
                                            {attachment.size_bytes ? formatFileSize(attachment.size_bytes) : "File"}
                                          </p>
                                        </div>
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100">
                                              <MoreVertical className="h-4 w-4" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handleDownloadAttachment(attachment.file_id, attachment.file_name)}>
                                              <Download className="h-4 w-4 mr-2" /> Download
                                            </DropdownMenuItem>
                                            {!isOwn && (
                                              <DropdownMenuItem onClick={() => handleSaveToProjectFiles(attachment.file_id)}>
                                                <FolderPlus className="h-4 w-4 mr-2" /> Save to Files
                                              </DropdownMenuItem>
                                            )}
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}

                            <p className={cn(
                              "text-[10px] text-muted-foreground px-1",
                              isOwn && "text-right"
                            )}>
                              {formatDistanceToNow(new Date(msg.sent_at), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="p-3 border-t bg-background">
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {pendingFiles.map((pf) => (
                  <div key={pf.id} className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted text-xs">
                    {pf.uploading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : pf.error ? (
                      <X className="h-3 w-3 text-destructive" />
                    ) : (
                      <Check className="h-3 w-3 text-green-600" />
                    )}
                    <span className="truncate max-w-[100px]">{pf.file.name}</span>
                    <button onClick={() => removePendingFile(pf.id)} className="hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-end">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.zip"
                onChange={(e) => {
                  if (e.target.files?.length) handleFileSelect(e.target.files)
                  e.target.value = ""
                }}
                className="hidden"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 flex-shrink-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={sendingMessage}
              >
                <Paperclip className="h-5 w-5" />
              </Button>
              <Textarea
                placeholder="Type a message..."
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                disabled={sendingMessage}
                className="min-h-[40px] max-h-24 resize-none flex-1 text-sm"
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
              />
              <Button
                onClick={handleSendMessage}
                disabled={sendingMessage || (!messageBody.trim() && !pendingFiles.some((pf) => pf.uploaded))}
                size="icon"
                className="h-9 w-9 flex-shrink-0"
              >
                {sendingMessage ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-3">
            <MessageCircle className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="font-semibold">Select a conversation</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs">
            Choose from the list or start a new message
          </p>
          <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={handleStartNewChat}>
            <PenSquare className="h-4 w-4" />
            New Message
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100vh-10rem)] sm:h-[calc(100vh-12rem)] border rounded-lg overflow-hidden bg-background">
        <ConversationList />
        <ThreadView />
      </div>
    </TooltipProvider>
  )
}
