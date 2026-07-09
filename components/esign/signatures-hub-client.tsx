"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import {
  bulkSendTemplateEnvelopesAction,
  createMySigningLinkAction,
  deleteDraftDocumentAction,
  getEnvelopeExecutedDownloadUrlAction,
  listESignTemplatesAction,
  listSignatureStartTargetsAction,
  markEnvelopeSignedOfflineAction,
  resendEnvelopeAction,
  sendDocumentSigningReminderAction,
  voidEnvelopeAction,
  type ESignTemplateSummary,
} from "@/app/(app)/signatures/actions"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AlertTriangle, Ban, Download, Eye, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, FileText, Users, Calendar, Plus, Search, Filter, ChevronRight, Upload } from "@/components/icons"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

type QueueFilter = "all" | "waiting" | "executed" | "expiring" | "drafts" | "voided"
type SignatureHubRow = {
  envelope_id: string
  document_id: string
  document_title: string
  document_type: string
  document_status: string
  document_metadata: Record<string, any>
  source_file_id: string | null
  project_id: string
  project_name: string | null
  source_entity_type: string | null
  source_entity_id: string | null
  envelope_status: string
  created_at: string
  sent_at: string | null
  executed_at: string | null
  expires_at: string | null
  voided_at: string | null
  signer_summary: {
    total: number
    signed: number
    viewed: number
    pending: number
  }
  next_pending_request_id: string | null
  next_pending_sequence: number | null
  next_pending_emails: string[]
  recipient_names: string[]
  next_pending_names: string[]
  recipient_statuses: Array<{
    id: string
    name: string
    email: string | null
    signer_role: string | null
    sequence: number
    status: string
    sent_at: string | null
    viewed_at: string | null
    signed_at: string | null
    signed_by_name: string | null
    signed_by_email: string | null
    identity_mismatch: boolean
    is_current: boolean
    can_remind: boolean
  }>
  activity: Array<{
    id: string
    event_type: string
    label: string
    created_at: string
    actor_label: string | null
    detail: string | null
  }>
  last_event_at: string | null
  can_remind: boolean
  can_void: boolean
  can_resend: boolean
  can_download: boolean
  can_delete_draft: boolean
  can_sign_myself: boolean
  can_mark_offline: boolean
  queue_flags: {
    waiting_on_client: boolean
    executed_this_week: boolean
    expiring_soon: boolean
  }
}

type SignaturesHubSummary = {
  total: number
  waiting_on_client: number
  executed_this_week: number
  expiring_soon: number
}

type SignatureEnvelopeProject = {
  id: string
  name: string
}

type SignatureStartTarget = Awaited<ReturnType<typeof listSignatureStartTargetsAction>>[number]

interface SignaturesHubClientProps {
  initialData: {
    rows: SignatureHubRow[]
    summary: SignaturesHubSummary
    generated_at: string
  }
  scope: "org" | "project"
  projectsForNewEnvelope: SignatureEnvelopeProject[]
}

const envelopeStatusClassName: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  partially_signed: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  executed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  voided: "bg-rose-500/15 text-rose-700 border-rose-500/30",
  expired: "bg-orange-500/15 text-orange-700 border-orange-500/30",
}

type RowAction = "preview_source" | "download" | "resend" | "sign_myself" | "mark_offline" | "duplicate_packet" | "void" | "delete_draft" | "continue_draft" | "view_source"

function formatDateTime(value?: string | null) {
  if (!value) return "—"
  return format(new Date(value), "MMM d, yyyy h:mm a")
}

function formatStatusLabel(value: string) {
  return value.replaceAll("_", " ")
}

function formatEnvelopeStatusLabel(value: string) {
  switch (value) {
    case "sent":
      return "Waiting on client"
    case "partially_signed":
      return "Partially signed"
    case "executed":
      return "Executed"
    case "draft":
      return "Draft"
    case "voided":
      return "Voided"
    case "expired":
      return "Expired"
    default:
      return formatStatusLabel(value)
  }
}

function formatDocumentType(value: string) {
  switch (value) {
    case "estimate":
      return "Estimate"
    case "change_order":
      return "Change Order"
    case "subcontract_change_order":
      return "Subcontract Change Order"
    case "proposal":
      return "Proposal"
    case "contract":
      return "Contract"
    default:
      return formatStatusLabel(value)
  }
}

function getSourceLabel(row: SignatureHubRow) {
  switch (row.source_entity_type) {
    case "change_order":
      return `Change Order · ${row.document_title}`
    case "estimate":
      return `Estimate · ${row.document_title}`
    case "proposal":
      return `Proposal · ${row.document_title}`
    case "selection":
      return `Selection · ${row.document_title}`
    case "subcontract":
      return `Subcontract · ${row.document_title}`
    case "subcontract_change_order":
      return `Subcontract Change Order · ${row.document_title}`
    case "closeout":
      return `Closeout · ${row.document_title}`
    default:
      return row.document_title
  }
}

function getOpenSourceActionLabel(row: SignatureHubRow) {
  switch (row.source_entity_type) {
    case "change_order":
      return "Open change order"
    case "estimate":
      return "Open estimate"
    case "proposal":
      return "Open proposal"
    case "selection":
      return "Open selection"
    case "subcontract":
      return "Open commitment"
    case "subcontract_change_order":
      return "Open commitment change order"
    default:
      return "Open source"
  }
}

function getProgressPercent(row: SignatureHubRow) {
  if (row.signer_summary.total === 0) {
    return row.envelope_status === "executed" ? 100 : 0
  }
  return Math.round((row.signer_summary.signed / row.signer_summary.total) * 100)
}

function getPendingLabel(row: SignatureHubRow) {
  if (row.signer_summary.pending === 0) return null
  if (row.next_pending_names.length > 0) return `Waiting on: ${row.next_pending_names.join(", ")}`
  if (row.next_pending_sequence != null) return `Waiting on signer ${row.next_pending_sequence}`
  return `${row.signer_summary.pending} pending`
}

function getViewedLabel(row: SignatureHubRow) {
  const viewedStatuses = row.recipient_statuses.filter((recipient) => recipient.viewed_at && recipient.status !== "signed")
  if (viewedStatuses.length === 0) return null
  const latestViewed = viewedStatuses
    .map((recipient) => recipient.viewed_at)
    .filter((value): value is string => !!value)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
  if (!latestViewed) return null
  return `${viewedStatuses.length} viewed, last ${format(new Date(latestViewed), "MMM d")}`
}

function hasIdentityMismatch(row: SignatureHubRow) {
  return row.recipient_statuses.some((recipient) => recipient.identity_mismatch)
}

function getAvailableActions(row: SignatureHubRow): RowAction[] {
  const actions: RowAction[] = []
  if (row.document_status === "draft") actions.push("continue_draft")
  if (row.source_file_id) actions.push("preview_source")
  if (row.can_download) actions.push("download")
  if (row.can_remind) actions.push("resend")
  if (row.can_sign_myself) actions.push("sign_myself")
  if (row.can_mark_offline) actions.push("mark_offline")
  if (row.can_resend && row.envelope_status !== "draft") actions.push("duplicate_packet")
  if (row.can_void) actions.push("void")
  if (row.can_delete_draft) actions.push("delete_draft")
  if (row.source_entity_id) actions.push("view_source")
  return actions
}

function getVersionLabel(row: SignatureHubRow) {
  const versionNumber = Number(row.document_metadata?.version_number ?? 0)
  if (!Number.isFinite(versionNumber) || versionNumber <= 0) return null
  const isCurrent = row.document_metadata?.is_current_version !== false
  return isCurrent ? `v${versionNumber}` : `v${versionNumber} (older)`
}

function getActionLabel(action: RowAction, row: SignatureHubRow) {
  switch (action) {
    case "preview_source":
      return "Preview source PDF"
    case "view_source":
      return getOpenSourceActionLabel(row)
    case "resend":
      return "Send reminder"
    case "sign_myself":
      return "Sign myself now"
    case "mark_offline":
      return "Upload signed copy"
    case "download":
      return "Download executed PDF"
    case "duplicate_packet":
      return "Void & send new copy"
    case "continue_draft":
      return "Continue draft"
    case "void":
      return "Void envelope"
    case "delete_draft":
      return "Delete draft"
  }
}

function SummaryTiles({ summary }: { summary: SignaturesHubSummary }) {
  const tiles = [
    { label: "Total", value: summary.total, icon: FileText },
    { label: "Waiting", value: summary.waiting_on_client, icon: Users },
    { label: "Executed this week", value: summary.executed_this_week, icon: CheckCircle2 },
    { label: "Expiring soon", value: summary.expiring_soon, icon: Calendar },
  ]

  return (
    <div className="grid gap-3 border-b bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => {
        const Icon = tile.icon
        return (
          <Card key={tile.label} className="rounded-md shadow-none">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">{tile.label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-4 pb-3">
              <p className="text-2xl font-semibold leading-none">{tile.value}</p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

export function SignaturesHubClient({
  initialData,
  scope,
  projectsForNewEnvelope,
}: SignaturesHubClientProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const rows = initialData.rows
  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all")
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareSource, setPrepareSource] = useState<EnvelopeWizardSourceEntity | null>(null)
  const [prepareDocumentId, setPrepareDocumentId] = useState<string | null>(null)
  const [newEnvelopeProjectId, setNewEnvelopeProjectId] = useState("")
  const [sourceTargets, setSourceTargets] = useState<SignatureStartTarget[]>([])
  const [loadingSourceTargets, setLoadingSourceTargets] = useState(false)

  // Detail & Action State
  const [selectedRow, setSelectedRow] = useState<SignatureHubRow | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [voidDialogOpen, setVoidDialogOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [resendDialogOpen, setResendDialogOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [templates, setTemplates] = useState<ESignTemplateSummary[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [bulkTemplateId, setBulkTemplateId] = useState("")
  const [bulkRecipientsText, setBulkRecipientsText] = useState("")
  const [bulkExpiresInDays, setBulkExpiresInDays] = useState("14")
  const [bulkRemindersEnabled, setBulkRemindersEnabled] = useState(true)
  const [bulkReminderIntervalDays, setBulkReminderIntervalDays] = useState("3")
  const [offlineDialogOpen, setOfflineDialogOpen] = useState(false)
  const [offlineSignerName, setOfflineSignerName] = useState("")
  const [offlineNote, setOfflineNote] = useState("")
  const [offlineFile, setOfflineFile] = useState<File | null>(null)
  const offlineFileInputRef = useRef<HTMLInputElement>(null)

  // Mobile UI state
  const [mobileProjectPickerOpen, setMobileProjectPickerOpen] = useState(false)
  const [mobileActionsRow, setMobileActionsRow] = useState<SignatureHubRow | null>(null)

  useEffect(() => {
    if (scope === "org") {
      setNewEnvelopeProjectId("")
      return
    }
    if (projectsForNewEnvelope.length === 0) {
      setNewEnvelopeProjectId("")
      return
    }
    if (!newEnvelopeProjectId || !projectsForNewEnvelope.some((project) => project.id === newEnvelopeProjectId)) {
      setNewEnvelopeProjectId(projectsForNewEnvelope[0].id)
    }
  }, [newEnvelopeProjectId, projectsForNewEnvelope, scope])

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((row) => {
      const queueMatch =
        queueFilter === "all" ||
        (queueFilter === "waiting" && row.queue_flags.waiting_on_client) ||
        (queueFilter === "executed" && row.envelope_status === "executed") ||
        (queueFilter === "expiring" && row.queue_flags.expiring_soon) ||
        (queueFilter === "drafts" && row.envelope_status === "draft") ||
        (queueFilter === "voided" && row.envelope_status === "voided")

      if (!queueMatch) return false
      if (!term) return true

      const haystack = [
        row.document_title,
        row.document_type,
        row.project_name ?? "",
        row.envelope_status,
        row.source_entity_type ?? "",
        ...row.recipient_names,
      ]
        .join(" ")
        .toLowerCase()

      return haystack.includes(term)
    })
  }, [rows, queueFilter, search])

  const withPendingAction = async (envelopeId: string, fn: () => Promise<void>) => {
    setPendingActionId(envelopeId)
    try {
      await fn()
      router.refresh()
    } catch (error: any) {
      console.error(error)
      toast.error("Action failed", { description: error?.message ?? "Please try again." })
    } finally {
      setPendingActionId(null)
    }
  }

  const handleResendReminder = async (row: SignatureHubRow) => {
    if (!row.next_pending_request_id) return
    await withPendingAction(row.envelope_id, async () => {
      unwrapAction(await sendDocumentSigningReminderAction(row.next_pending_request_id as string))
      toast.success("Reminder sent")
    })
  }

  const handleVoidTrigger = (row: SignatureHubRow) => {
    setSelectedRow(row)
    setVoidReason("")
    setVoidDialogOpen(true)
  }

  const handleConfirmVoid = async () => {
    if (!selectedRow) return
    await withPendingAction(selectedRow.envelope_id, async () => {
      unwrapAction(await voidEnvelopeAction({ 
        envelopeId: selectedRow.envelope_id, 
        reason: voidReason || "Voided from signatures hub" 
      }))
      toast.success("Envelope voided")
      setVoidDialogOpen(false)
    })
  }

  const handleDownload = async (row: SignatureHubRow) => {
    await withPendingAction(row.envelope_id, async () => {
      const result = await getEnvelopeExecutedDownloadUrlAction({ envelopeId: row.envelope_id })
      window.open(result.url, "_blank", "noopener,noreferrer")
    })
  }

  const handleSignMyself = async (row: SignatureHubRow) => {
    await withPendingAction(row.envelope_id, async () => {
      const result = unwrapAction(await createMySigningLinkAction({ envelopeId: row.envelope_id }))
      window.open(result.url, "_blank", "noopener,noreferrer")
    })
  }

  const handleOfflineTrigger = (row: SignatureHubRow) => {
    setSelectedRow(row)
    setOfflineSignerName(row.next_pending_names[0] ?? row.recipient_names[0] ?? "")
    setOfflineNote("")
    setOfflineFile(null)
    setOfflineDialogOpen(true)
  }

  const handleConfirmOffline = async () => {
    if (!selectedRow || !offlineFile) {
      toast.error("Upload the signed PDF")
      return
    }
    const formData = new FormData()
    formData.append("file", offlineFile)
    formData.append("signer_name", offlineSignerName)
    formData.append("note", offlineNote)
    await withPendingAction(selectedRow.envelope_id, async () => {
      unwrapAction(await markEnvelopeSignedOfflineAction({ envelopeId: selectedRow.envelope_id, formData }))
      toast.success("Signed copy recorded")
      setOfflineDialogOpen(false)
    })
  }

  const handleDuplicatePacketTrigger = (row: SignatureHubRow) => {
    setSelectedRow(row)
    setResendDialogOpen(true)
  }

  const handleConfirmDuplicatePacket = async () => {
    if (!selectedRow) return
    await withPendingAction(selectedRow.envelope_id, async () => {
      unwrapAction(await resendEnvelopeAction({ envelopeId: selectedRow.envelope_id }))
      toast.success("New signature copy sent")
      setResendDialogOpen(false)
    })
  }

  const handlePreviewSource = (row: SignatureHubRow) => {
    if (!row.source_file_id) return
    window.open(`/api/files/${row.source_file_id}/raw`, "_blank", "noopener,noreferrer")
  }

  const handleDeleteTrigger = (row: SignatureHubRow) => {
    setSelectedRow(row)
    setDeleteDialogOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (!selectedRow) return
    await withPendingAction(selectedRow.envelope_id, async () => {
      unwrapAction(await deleteDraftDocumentAction({ documentId: selectedRow.document_id }))
      toast.success("Draft deleted")
      setDeleteDialogOpen(false)
    })
  }

  const handleViewSource = (row: SignatureHubRow) => {
    if (!row.source_entity_id) return
    const projectId = row.project_id
    
    // If it's a file source, go to documents with highlighting
    if (row.source_entity_type === "file" || row.source_entity_type === "other") {
      router.push(`/projects/${projectId}/documents?fileId=${row.source_entity_id}`)
      return
    }

    // Otherwise go to the specific entity type page if we have a mapping
    const entityRoutes: Record<string, string> = {
      estimate: "estimates",
      proposal: "proposals",
      change_order: "change-orders",
      selection: "selections",
      subcontract: "commitments",
      subcontract_change_order: "commitments",
      closeout: "closeout",
      lien_waiver: "financials",
    }

    if (entityRoutes[row.source_entity_type as string]) {
      router.push(`/projects/${projectId}/${entityRoutes[row.source_entity_type as string]}`)
    } else {
      router.push(`/projects/${projectId}/documents`)
    }
  }

  const handleOpenSourcePicker = async (projectId = newEnvelopeProjectId) => {
    if (!projectId) {
      toast.error("Project context is required before starting a signature envelope.")
      return
    }

    setPrepareSource(null)
    setPrepareDocumentId(null)
    setNewEnvelopeProjectId(projectId)
    setPrepareOpen(true)
    setLoadingSourceTargets(true)
    try {
      const targets = await listSignatureStartTargetsAction({ projectId })
      setSourceTargets(targets)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not load linked records", { description: error?.message ?? "Please try again." })
      setSourceTargets([])
    } finally {
      setLoadingSourceTargets(false)
    }
  }

  const handleContinueDraft = (row: SignatureHubRow) => {
    const sourceType = row.source_entity_type
    const isLinkedSource =
      sourceType === "proposal" ||
      sourceType === "change_order" ||
      sourceType === "lien_waiver" ||
      sourceType === "selection" ||
      sourceType === "subcontract" ||
      sourceType === "subcontract_change_order" ||
      sourceType === "closeout" ||
      sourceType === "other"

    setPrepareSource(
      isLinkedSource && row.source_entity_id
        ? {
            type: sourceType,
            id: row.source_entity_id,
            project_id: row.project_id,
            title: row.document_title,
            document_type: (row.document_type as "proposal" | "contract" | "change_order" | "other") ?? "other",
          }
        : {
            standalone: true,
            type: "other",
            id: crypto.randomUUID(),
            project_id: row.project_id,
            title: row.document_title,
            document_type: (row.document_type as "proposal" | "contract" | "change_order" | "other") ?? "other",
          },
    )
    setPrepareDocumentId(row.document_id)
    setPrepareOpen(true)
  }

  const prepareSourceLabel = prepareDocumentId ? "Draft" : prepareSource?.standalone ? "Envelope" : "Record"
  const prepareSheetTitle = prepareDocumentId
    ? "Continue draft envelope"
    : prepareSource?.standalone
    ? "Prepare signature envelope"
    : "Prepare linked signature envelope"

  const handleMobileNewEnvelope = () => {
    if (scope === "org" && projectsForNewEnvelope.length > 1) {
      setMobileProjectPickerOpen(true)
      return
    }
    void handleOpenSourcePicker(newEnvelopeProjectId || projectsForNewEnvelope[0]?.id || "")
  }

  const handleDesktopNewEnvelope = () => {
    if (scope === "org" && projectsForNewEnvelope.length > 1) {
      setProjectPickerOpen(true)
      return
    }
    void handleOpenSourcePicker(newEnvelopeProjectId || projectsForNewEnvelope[0]?.id || "")
  }

  const loadTemplatesForBulk = async (projectId = newEnvelopeProjectId || projectsForNewEnvelope[0]?.id || "") => {
    if (!projectId) {
      toast.error("Choose a project before bulk sending.")
      return
    }
    setNewEnvelopeProjectId(projectId)
    setLoadingTemplates(true)
    try {
      const rows = await listESignTemplatesAction({ projectId })
      setTemplates(rows ?? [])
      setBulkTemplateId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? ""))
    } catch (error: any) {
      console.error(error)
      toast.error("Could not load templates", { description: error?.message ?? "Please try again." })
    } finally {
      setLoadingTemplates(false)
    }
  }

  const openBulkDialog = async () => {
    if (projectsForNewEnvelope.length === 0) return
    if (!newEnvelopeProjectId && projectsForNewEnvelope.length > 1 && scope === "org") {
      setBulkDialogOpen(true)
      return
    }
    setBulkDialogOpen(true)
    await loadTemplatesForBulk(newEnvelopeProjectId || projectsForNewEnvelope[0]?.id || "")
  }

  const parseBulkRecipients = () => {
    return bulkRecipientsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [nameOrEmail, maybeEmail, maybeTitle] = line.split(",").map((part) => part.trim())
        const email = maybeEmail || nameOrEmail
        const name = maybeEmail ? nameOrEmail : ""
        return { name, email, title: maybeTitle }
      })
      .filter((recipient) => recipient.email.includes("@"))
  }

  const handleBulkSend = async () => {
    if (!bulkTemplateId || !newEnvelopeProjectId) {
      toast.error("Choose a project and template")
      return
    }
    const recipients = parseBulkRecipients()
    if (recipients.length === 0) {
      toast.error("Add recipients as name,email rows")
      return
    }
    setPendingActionId("bulk-send")
    try {
      const expiryDays = Math.max(1, Math.min(180, Number(bulkExpiresInDays) || 14))
      const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
      const result = unwrapAction(await bulkSendTemplateEnvelopesAction({
        templateId: bulkTemplateId,
        projectId: newEnvelopeProjectId,
        recipients,
        expires_at: expiresAt,
        reminder_enabled: bulkRemindersEnabled,
        reminder_interval_days: Math.max(1, Math.min(30, Number(bulkReminderIntervalDays) || 3)),
      }))
      toast.success(`Bulk send complete: ${result.sent} sent${result.failed ? `, ${result.failed} failed` : ""}`)
      setBulkDialogOpen(false)
      router.refresh()
    } catch (error: any) {
      console.error(error)
      toast.error("Bulk send failed", { description: error?.message ?? "Please try again." })
    } finally {
      setPendingActionId(null)
    }
  }

  const queueFilterLabels: Record<QueueFilter, string> = {
    all: "All envelopes",
    waiting: "Waiting on signers",
    executed: "Executed envelopes",
    expiring: "Expiring soon",
    drafts: "Drafts only",
    voided: "Voided / Canceled",
  }

  return (
    <TooltipProvider>
      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search signatures..."
                  className="h-10 pl-9 pr-3 text-sm"
                  inputMode="search"
                />
              </div>
              <Button
                size="icon"
                className="h-10 w-10 shrink-0"
                onClick={handleMobileNewEnvelope}
                disabled={projectsForNewEnvelope.length === 0}
                aria-label="New signature envelope"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="-mx-px flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(Object.keys(queueFilterLabels) as QueueFilter[]).map((key) => {
                const active = queueFilter === key
                const shortLabel =
                  key === "all" ? "All" :
                  key === "waiting" ? "Waiting" :
                  key === "executed" ? "Executed" :
                  key === "expiring" ? "Expiring" :
                  key === "drafts" ? "Drafts" :
                  "Voided"
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setQueueFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {shortLabel}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search documents..."
                className="w-full pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={queueFilter} onValueChange={(value) => setQueueFilter(value as QueueFilter)}>
                <SelectTrigger className="w-9 px-0 flex justify-center [&>svg:last-child]:hidden" aria-label="Filter queue" title="Filter queue">
                  <Filter className="h-4 w-4" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All envelopes</SelectItem>
                  <SelectItem value="waiting">Waiting on signers</SelectItem>
                  <SelectItem value="executed">Executed envelopes</SelectItem>
                  <SelectItem value="expiring">Expiring soon</SelectItem>
                  <SelectItem value="drafts">Drafts only</SelectItem>
                  <SelectItem value="voided">Voided / Canceled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto sm:items-center">
            <Button variant="outline" onClick={() => void openBulkDialog()} disabled={projectsForNewEnvelope.length === 0} className="w-full sm:w-auto">
              <Mail className="mr-2 h-4 w-4" />
              Bulk Send
            </Button>
            <Button onClick={handleDesktopNewEnvelope} disabled={projectsForNewEnvelope.length === 0} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New Signature Envelope
            </Button>
          </div>
        </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {!isMobile ? <SummaryTiles summary={initialData.summary} /> : null}
          {isMobile ? (
            <MobileEnvelopeList
              rows={filteredRows}
              scope={scope}
              pendingActionId={pendingActionId}
              onRowOpen={(row) => {
                setSelectedRow(row)
                setDetailOpen(true)
              }}
              onRowActions={(row) => setMobileActionsRow(row)}
              onNewEnvelope={handleMobileNewEnvelope}
              canCreate={projectsForNewEnvelope.length > 0}
            />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-4 w-[28%] min-w-[200px]">Document</TableHead>
                <TableHead className="px-4 w-[10%] min-w-[100px] text-center">Type</TableHead>
                {scope === "org" ? <TableHead className="px-4 w-[12%] min-w-[120px]">Project</TableHead> : null}
                <TableHead className="px-4 w-[14%] min-w-[140px]">Signers</TableHead>
                <TableHead className="px-4 w-[10%] min-w-[100px] text-center">Status</TableHead>
                <TableHead className="px-4 w-[14%] min-w-[120px]">Progress</TableHead>
                <TableHead className="px-4 w-[12%] min-w-[100px]">Expires</TableHead>
                <TableHead className="pr-4 w-[60px] text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => {
                const isPending = pendingActionId === row.envelope_id
                const availableActions = getAvailableActions(row)
                const hasActions = availableActions.length > 0

                return (
                  <TableRow 
                    key={row.envelope_id} 
                    className="group cursor-pointer hover:bg-muted/30"
                    onClick={() => {
                      setSelectedRow(row)
                      setDetailOpen(true)
                    }}
                  >
                    <TableCell className="pl-4 min-w-0">
                      <div className="space-y-1">
                        <span className="text-sm font-semibold block truncate">{getSourceLabel(row)}</span>
                        {getVersionLabel(row) ? (
                          <span className="text-xs text-muted-foreground block">{getVersionLabel(row)}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 text-center">
                      <span className="text-sm text-muted-foreground capitalize block truncate">
                        {formatDocumentType(row.document_type)}
                      </span>
                    </TableCell>
                    {scope === "org" ? (
                      <TableCell className="px-4">
                        <span className="text-sm text-muted-foreground block truncate">
                          {row.project_name ?? "—"}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell className="px-4">
                      <span className="text-xs text-muted-foreground line-clamp-2">{row.recipient_names.join(", ") || "—"}</span>
                    </TableCell>
                    <TableCell className="px-4 text-center">
                      <Badge
                        variant="secondary"
                        className={`capitalize border text-[11px] h-5 px-2 ${envelopeStatusClassName[row.envelope_status] ?? ""}`}
                      >
                        {formatEnvelopeStatusLabel(row.envelope_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="space-y-1.5 w-full pr-4">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>{row.signer_summary.signed}/{row.signer_summary.total}</span>
                          {hasIdentityMismatch(row) ? (
                            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="h-3 w-3" />
                              mismatch
                            </span>
                          ) : null}
                        </div>
                        <Progress value={getProgressPercent(row)} className="h-1.5" />
                        {getPendingLabel(row) ? (
                          <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium truncate">{getPendingLabel(row)}</p>
                        ) : null}
                        {getViewedLabel(row) ? (
                          <p className="text-[10px] text-muted-foreground truncate">{getViewedLabel(row)}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="text-xs">
                        {row.expires_at ? (
                          <div className={cn(
                            "flex items-center gap-1.5",
                            row.queue_flags.expiring_soon ? "text-orange-600 font-medium" : "text-muted-foreground"
                          )}>
                            <Calendar className="h-3 w-3" />
                            {format(new Date(row.expires_at), "MMM d, yyyy")}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end">
                        {hasActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity" disabled={isPending} title="More actions">
                                <MoreHorizontal className="h-3.5 w-3.5" />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setSelectedRow(row)
                                setDetailOpen(true)
                              }}>
                                <FileText className="mr-2 h-4 w-4" />
                                View details
                              </DropdownMenuItem>
                              {availableActions.includes("view_source") ? (
                                <DropdownMenuItem onClick={() => handleViewSource(row)}>
                                  <Link2 className="mr-2 h-4 w-4" />
                                  {getOpenSourceActionLabel(row)}
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("resend") ? (
                                <DropdownMenuItem onClick={() => void handleResendReminder(row)}>
                                  <Mail className="mr-2 h-4 w-4" />
                                  Resend reminder
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("sign_myself") ? (
                                <DropdownMenuItem onClick={() => void handleSignMyself(row)}>
                                  <Link2 className="mr-2 h-4 w-4" />
                                  Sign myself now
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("mark_offline") ? (
                                <DropdownMenuItem onClick={() => handleOfflineTrigger(row)}>
                                  <Upload className="mr-2 h-4 w-4" />
                                  Upload signed copy
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("preview_source") ? (
                                <DropdownMenuItem onClick={() => handlePreviewSource(row)}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  Preview source PDF
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("continue_draft") ? (
                                <DropdownMenuItem onClick={() => handleContinueDraft(row)}>
                                  <RefreshCcw className="mr-2 h-4 w-4" />
                                  Continue
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("download") ? (
                                <DropdownMenuItem onClick={() => void handleDownload(row)}>
                                  <Download className="mr-2 h-4 w-4" />
                                  Download executed PDF
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("duplicate_packet") ? (
                                <DropdownMenuItem onClick={() => handleDuplicatePacketTrigger(row)}>
                                  <RefreshCcw className="mr-2 h-4 w-4" />
                                  Void & send new copy
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("void") ? (
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleVoidTrigger(row)}>
                                  <Ban className="mr-2 h-4 w-4" />
                                  Void envelope
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("delete_draft") ? (
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDeleteTrigger(row)}>
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete draft
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={scope === "org" ? 8 : 7} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <FileText className="h-6 w-6" />
                      </div>
                      <div className="text-center max-w-[400px]">
                        <p className="font-medium">No envelopes found</p>
                        <p className="text-sm text-muted-foreground mt-0.5">Adjust your filters or create a new envelope.</p>
                      </div>
                      {projectsForNewEnvelope.length > 0 ? (
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={handleDesktopNewEnvelope} disabled={projectsForNewEnvelope.length === 0}>
                            <Plus className="mr-2 h-4 w-4" />
                            New Signature Envelope
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          )}
        </div>

        <EnvelopeWizard
          open={prepareOpen}
          onOpenChange={(nextOpen) => {
            setPrepareOpen(nextOpen)
            if (!nextOpen) {
              setPrepareSource(null)
              setPrepareDocumentId(null)
            }
          }}
          sourceEntity={prepareSource}
          resumeDocumentId={prepareDocumentId}
          sourceLabel={prepareSourceLabel}
          sheetTitle={prepareSheetTitle}
          sourceOptions={sourceTargets}
          sourceOptionsLoading={loadingSourceTargets}
          defaultProjectId={newEnvelopeProjectId}
          defaultProjectName={projectsForNewEnvelope.find((project) => project.id === newEnvelopeProjectId)?.name ?? null}
          onSourceEntitySelect={(sourceEntity) => {
            setPrepareSource(sourceEntity)
            setPrepareDocumentId(null)
          }}
          onEnvelopeSent={() => {
            router.refresh()
          }}
        />

        <Dialog open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Choose project</DialogTitle>
              <DialogDescription>
                Select the project for this signature envelope.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] space-y-1 overflow-y-auto py-2">
              {projectsForNewEnvelope.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    setProjectPickerOpen(false)
                    void handleOpenSourcePicker(project.id)
                  }}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="truncate">{project.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* Detail Drawer - Desktop (right) */}
        {!isMobile ? (
        <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
          <SheetContent
            side="right"
            mobileFullscreen
            className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
            style={{
              animationDuration: '150ms',
              transitionDuration: '150ms'
            } as React.CSSProperties}
          >
            {selectedRow && (
              <>
                <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
                  <div className="flex items-center gap-2">
                    <FileText className="h-5 w-5 text-primary" />
                    <SheetTitle className="text-xl">
                      {getSourceLabel(selectedRow)}
                    </SheetTitle>
                    <Badge
                      variant="secondary"
                      className={`capitalize border ${envelopeStatusClassName[selectedRow.envelope_status] ?? ""}`}
                    >
                      {formatEnvelopeStatusLabel(selectedRow.envelope_status)}
                    </Badge>
                  </div>
                  <SheetDescription className="text-left mt-2">
                    <div className="flex items-center gap-2">
                      <span>{formatDocumentType(selectedRow.document_type)}</span>
                      <span>•</span>
                      {selectedRow.project_name ? `Project: ${selectedRow.project_name}` : "Global envelope"}
                    </div>
                  </SheetDescription>
                </SheetHeader>

                <ScrollArea className="flex-1">
                  <div className="px-6 py-4 space-y-6">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Created</p>
                        <p className="text-sm">{formatDateTime(selectedRow.created_at)}</p>
                      </div>
                      {selectedRow.sent_at && (
                        <div className="space-y-1">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Sent</p>
                          <p className="text-sm">{formatDateTime(selectedRow.sent_at)}</p>
                        </div>
                      )}
                      {selectedRow.expires_at && (
                        <div className="space-y-1">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Expires</p>
                          <p className="text-sm">{formatDateTime(selectedRow.expires_at)}</p>
                        </div>
                      )}
                      {selectedRow.executed_at && (
                        <div className="space-y-1">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Executed</p>
                          <p className="text-sm">{formatDateTime(selectedRow.executed_at)}</p>
                        </div>
                      )}
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        Source
                      </h3>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {selectedRow.source_entity_type
                                ? formatDocumentType(selectedRow.source_entity_type)
                                : "Standalone document"}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{selectedRow.document_title}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {selectedRow.source_file_id ? (
                              <Button variant="outline" size="sm" onClick={() => handlePreviewSource(selectedRow)}>
                                <Eye className="mr-2 h-4 w-4" />
                                Preview PDF
                              </Button>
                            ) : null}
                            {selectedRow.source_entity_id ? (
                              <Button variant="outline" size="sm" onClick={() => handleViewSource(selectedRow)}>
                                {getOpenSourceActionLabel(selectedRow)}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        {selectedRow.source_entity_type === "change_order" ? (
                          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                            Execution will mark this change order approved and update the change order register.
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                          <Users className="h-4 w-4" />
                          Recipients
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          {selectedRow.signer_summary.signed}/{selectedRow.signer_summary.total} signed
                        </span>
                      </div>
                      <div className="space-y-3">
                        {selectedRow.recipient_statuses.map((recipient, idx) => {
                          const isSigned = recipient.status === "signed"
                          const isPending = recipient.is_current && selectedRow.envelope_status !== "executed" && selectedRow.envelope_status !== "voided"
                          
                          return (
                            <div key={recipient.id} className="flex items-center justify-between gap-3 border rounded-lg p-3 bg-muted/30">
                              <div className="flex items-center gap-3">
                                <div className={cn(
                                  "h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium",
                                  isSigned ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400" : 
                                  isPending ? "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400" :
                                  "bg-muted text-muted-foreground"
                                )}>
                                  {isSigned ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">{recipient.name}</p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {isSigned
                                      ? `Signed${recipient.signed_at ? ` ${format(new Date(recipient.signed_at), "MMM d")}` : ""}`
                                      : recipient.viewed_at
                                      ? `Viewed ${format(new Date(recipient.viewed_at), "MMM d, h:mm a")}`
                                      : isPending
                                      ? "Current signer"
                                      : "Awaiting previous signers"}
                                  </p>
                                  {recipient.identity_mismatch ? (
                                    <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                                      <AlertTriangle className="h-3 w-3" />
                                      Signed by {recipient.signed_by_email}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              {recipient.can_remind && (
                                <Button variant="outline" size="sm" className="h-8" onClick={() => void handleResendReminder(selectedRow)}>
                                  Remind
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 pt-4">
                      {getAvailableActions(selectedRow).map(action => (
                        <Button 
                          key={action}
                          variant={action === "void" || action === "delete_draft" ? "destructive" : "outline"}
                          className="w-full justify-start h-10"
                          onClick={() => {
                            if (action === "preview_source") handlePreviewSource(selectedRow)
                            if (action === "view_source") handleViewSource(selectedRow)
                            if (action === "resend") handleResendReminder(selectedRow)
                            if (action === "sign_myself") handleSignMyself(selectedRow)
                            if (action === "mark_offline") handleOfflineTrigger(selectedRow)
                            if (action === "download") handleDownload(selectedRow)
                            if (action === "duplicate_packet") handleDuplicatePacketTrigger(selectedRow)
                            if (action === "continue_draft") handleContinueDraft(selectedRow)
                            if (action === "void") handleVoidTrigger(selectedRow)
                            if (action === "delete_draft") handleDeleteTrigger(selectedRow)
                          }}
                        >
                          {action === "preview_source" && <><Eye className="mr-2 h-4 w-4" /> Preview source PDF</>}
                          {action === "view_source" && <><Link2 className="mr-2 h-4 w-4" /> {getOpenSourceActionLabel(selectedRow)}</>}
                          {action === "resend" && <><Mail className="mr-2 h-4 w-4" /> Send reminder</>}
                          {action === "sign_myself" && <><Link2 className="mr-2 h-4 w-4" /> Sign myself now</>}
                          {action === "mark_offline" && <><Upload className="mr-2 h-4 w-4" /> Upload signed copy</>}
                          {action === "download" && <><Download className="mr-2 h-4 w-4" /> Download executed PDF</>}
                          {action === "duplicate_packet" && <><RefreshCcw className="mr-2 h-4 w-4" /> Void & send new copy</>}
                          {action === "continue_draft" && <><RefreshCcw className="mr-2 h-4 w-4" /> Continue draft</>}
                          {action === "void" && <><Ban className="mr-2 h-4 w-4" /> Void envelope</>}
                          {action === "delete_draft" && <><Trash2 className="mr-2 h-4 w-4" /> Delete draft</>}
                        </Button>
                      ))}
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Activity
                      </h3>
                      <div className="space-y-3">
                        {selectedRow.activity.length > 0 ? (
                          selectedRow.activity.map((event) => (
                            <div key={event.id} className="flex gap-3">
                              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="truncate text-sm font-medium">{event.label}</p>
                                  <span className="shrink-0 text-[11px] text-muted-foreground">
                                    {formatDateTime(event.created_at)}
                                  </span>
                                </div>
                                {event.actor_label || event.detail ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {[event.actor_label, event.detail].filter(Boolean).join(" · ")}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground">No activity recorded yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </ScrollArea>
              </>
            )}
          </SheetContent>
        </Sheet>
        ) : (
        <Drawer open={detailOpen} onOpenChange={setDetailOpen}>
          <DrawerContent className="max-h-[92vh]">
            <DrawerHeader className="sr-only">
              <DrawerTitle>Envelope details</DrawerTitle>
            </DrawerHeader>
            {selectedRow && (
              <div className="flex min-h-0 flex-col">
                <div className="shrink-0 px-4 pb-3 pt-1">
                  <div className="flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-semibold leading-tight">
                        {getSourceLabel(selectedRow)}
                      </h2>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {formatDocumentType(selectedRow.document_type)}
                        {selectedRow.project_name ? ` · ${selectedRow.project_name}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <Badge
                      variant="secondary"
                      className={`capitalize border text-[11px] ${envelopeStatusClassName[selectedRow.envelope_status] ?? ""}`}
                    >
                      {formatEnvelopeStatusLabel(selectedRow.envelope_status)}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {selectedRow.signer_summary.signed}/{selectedRow.signer_summary.total} signed
                    </span>
                  </div>
                  <Progress value={getProgressPercent(selectedRow)} className="mt-2 h-1" />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
                  <div className="space-y-5 px-4 py-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                    {/* Source */}
                    <div>
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Source
                      </p>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <div className="flex items-center gap-2">
                          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {selectedRow.source_entity_type
                                ? formatDocumentType(selectedRow.source_entity_type)
                                : "Standalone document"}
                            </p>
                          </div>
                          {selectedRow.source_entity_id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleViewSource(selectedRow)}
                            >
                              Open
                              <ChevronRight className="ml-0.5 h-3 w-3" />
                            </Button>
                          ) : null}
                        </div>
                        {selectedRow.source_entity_type === "change_order" ? (
                          <p className="mt-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                            Execution will approve this change order and update the register.
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {/* Recipients */}
                    <div>
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Recipients
                      </p>
                      <div className="space-y-1.5">
                        {selectedRow.recipient_statuses.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No recipients</p>
                        ) : (
                          selectedRow.recipient_statuses.map((recipient, idx) => {
                            const isSigned = recipient.status === "signed"
                            const isPending = recipient.is_current && selectedRow.envelope_status !== "executed" && selectedRow.envelope_status !== "voided"
                            return (
                              <div
                                key={recipient.id}
                                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                              >
                                <div
                                  className={cn(
                                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
                                    isSigned
                                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                                      : isPending
                                      ? "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {isSigned ? <CheckCircle2 className="h-3.5 w-3.5" /> : idx + 1}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium">{recipient.name}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">
                                    {isSigned
                                      ? "Signed"
                                      : recipient.viewed_at
                                      ? `Viewed ${format(new Date(recipient.viewed_at), "MMM d")}`
                                      : isPending
                                      ? "Current signer"
                                      : "Awaiting"}
                                  </p>
                                  {recipient.identity_mismatch ? (
                                    <p className="mt-0.5 truncate text-[11px] font-medium text-amber-700 dark:text-amber-400">
                                      Signed by {recipient.signed_by_email}
                                    </p>
                                  ) : null}
                                </div>
                                {recipient.can_remind ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => void handleResendReminder(selectedRow)}
                                  >
                                    Remind
                                  </Button>
                                ) : null}
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>

                    {/* Timeline */}
                    <div>
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Activity
                      </p>
                      <div className="space-y-2 rounded-lg border bg-muted/20 px-3 py-2.5 text-xs">
                        {selectedRow.activity.length > 0 ? (
                          selectedRow.activity.map((event) => (
                            <div key={event.id} className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-medium">{event.label}</p>
                                {event.actor_label || event.detail ? (
                                  <p className="truncate text-muted-foreground">
                                    {[event.actor_label, event.detail].filter(Boolean).join(" · ")}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-muted-foreground">{format(new Date(event.created_at), "MMM d")}</span>
                            </div>
                          ))
                        ) : (
                          <p className="text-muted-foreground">No activity recorded yet.</p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    {getAvailableActions(selectedRow).length > 0 ? (
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Actions
                        </p>
                        <div className="space-y-1">
                          {getAvailableActions(selectedRow).map((action) => {
                            const isDestructive = action === "void" || action === "delete_draft"
                            return (
                              <button
                                key={action}
                                type="button"
                                onClick={() => {
                                  if (action === "preview_source") handlePreviewSource(selectedRow)
                                  if (action === "view_source") handleViewSource(selectedRow)
                                  if (action === "resend") void handleResendReminder(selectedRow)
                                  if (action === "sign_myself") void handleSignMyself(selectedRow)
                                  if (action === "mark_offline") handleOfflineTrigger(selectedRow)
                                  if (action === "download") void handleDownload(selectedRow)
                                  if (action === "duplicate_packet") handleDuplicatePacketTrigger(selectedRow)
                                  if (action === "continue_draft") handleContinueDraft(selectedRow)
                                  if (action === "void") handleVoidTrigger(selectedRow)
                                  if (action === "delete_draft") handleDeleteTrigger(selectedRow)
                                }}
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
                                  isDestructive ? "text-destructive" : "text-foreground",
                                )}
                              >
                                {action === "preview_source" && <Eye className="h-[18px] w-[18px] shrink-0" />}
                                {action === "view_source" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                                {action === "resend" && <Mail className="h-[18px] w-[18px] shrink-0" />}
                                {action === "sign_myself" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                                {action === "mark_offline" && <Upload className="h-[18px] w-[18px] shrink-0" />}
                                {action === "download" && <Download className="h-[18px] w-[18px] shrink-0" />}
                                {action === "duplicate_packet" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                                {action === "continue_draft" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                                {action === "void" && <Ban className="h-[18px] w-[18px] shrink-0" />}
                                {action === "delete_draft" && <Trash2 className="h-[18px] w-[18px] shrink-0" />}
                                <span className="flex-1">
                                  {getActionLabel(action, selectedRow)}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </DrawerContent>
        </Drawer>
        )}

        {/* Mobile Project Picker Drawer */}
        <Drawer open={mobileProjectPickerOpen} onOpenChange={setMobileProjectPickerOpen}>
          <DrawerContent className="max-h-[80vh]">
            <DrawerHeader className="border-b px-4 py-3">
              <DrawerTitle className="text-center text-sm font-semibold">Choose project</DrawerTitle>
            </DrawerHeader>
            <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-3 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
              {projectsForNewEnvelope.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No projects available</p>
              ) : (
                projectsForNewEnvelope.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setNewEnvelopeProjectId(project.id)
                      setMobileProjectPickerOpen(false)
                      setTimeout(() => void handleOpenSourcePicker(project.id), 50)
                    }}
                    className="flex items-center justify-between rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted"
                  >
                    <span className="truncate">{project.name}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))
              )}
            </div>
          </DrawerContent>
        </Drawer>

        {/* Mobile Row Actions Drawer */}
        <Drawer
          open={Boolean(mobileActionsRow)}
          onOpenChange={(open) => {
            if (!open) setMobileActionsRow(null)
          }}
        >
          <DrawerContent>
            {mobileActionsRow ? (
              <>
                <DrawerHeader className="border-b px-4 py-3">
                  <DrawerTitle className="truncate text-center text-sm font-semibold">
                    {getSourceLabel(mobileActionsRow)}
                  </DrawerTitle>
                </DrawerHeader>
                <div className="flex flex-col gap-0.5 px-3 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      const row = mobileActionsRow
                      setMobileActionsRow(null)
                      setSelectedRow(row)
                      setDetailOpen(true)
                    }}
                    className="flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted"
                  >
                    <FileText className="h-[18px] w-[18px] shrink-0" />
                    View details
                  </button>
                  {getAvailableActions(mobileActionsRow).map((action) => {
                    const row = mobileActionsRow
                    const isDestructive = action === "void" || action === "delete_draft"
                    return (
                      <button
                        key={action}
                        type="button"
                        onClick={() => {
                          setMobileActionsRow(null)
                          if (action === "preview_source") handlePreviewSource(row)
                          if (action === "view_source") handleViewSource(row)
                          if (action === "resend") void handleResendReminder(row)
                          if (action === "sign_myself") void handleSignMyself(row)
                          if (action === "mark_offline") handleOfflineTrigger(row)
                          if (action === "download") void handleDownload(row)
                          if (action === "duplicate_packet") handleDuplicatePacketTrigger(row)
                          if (action === "continue_draft") handleContinueDraft(row)
                          if (action === "void") handleVoidTrigger(row)
                          if (action === "delete_draft") handleDeleteTrigger(row)
                        }}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
                          isDestructive ? "text-destructive" : "text-foreground",
                        )}
                      >
                        {action === "preview_source" && <Eye className="h-[18px] w-[18px] shrink-0" />}
                        {action === "view_source" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                        {action === "resend" && <Mail className="h-[18px] w-[18px] shrink-0" />}
                        {action === "sign_myself" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                        {action === "mark_offline" && <Upload className="h-[18px] w-[18px] shrink-0" />}
                        {action === "download" && <Download className="h-[18px] w-[18px] shrink-0" />}
                        {action === "duplicate_packet" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                        {action === "continue_draft" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                        {action === "void" && <Ban className="h-[18px] w-[18px] shrink-0" />}
                        {action === "delete_draft" && <Trash2 className="h-[18px] w-[18px] shrink-0" />}
                        <span className="flex-1">
                          {getActionLabel(action, row)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            ) : null}
          </DrawerContent>
        </Drawer>

        <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Bulk send from template</DialogTitle>
              <DialogDescription>
                Create one envelope per recipient using a saved template.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Project</label>
                  <Select
                    value={newEnvelopeProjectId}
                    onValueChange={(value) => void loadTemplatesForBulk(value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projectsForNewEnvelope.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Template</label>
                  <Select value={bulkTemplateId} onValueChange={setBulkTemplateId} disabled={loadingTemplates || templates.length === 0}>
                    <SelectTrigger>
                      <SelectValue placeholder={loadingTemplates ? "Loading..." : "Choose template"} />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Recipients</label>
                <Textarea
                  value={bulkRecipientsText}
                  onChange={(event) => setBulkRecipientsText(event.target.value)}
                  rows={7}
                  placeholder={"Jane Client,jane@example.com,Optional title\nsam@example.com"}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Expires after</label>
                  <Input
                    type="number"
                    min="1"
                    max="180"
                    value={bulkExpiresInDays}
                    onChange={(event) => setBulkExpiresInDays(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Reminder interval</label>
                  <Input
                    type="number"
                    min="1"
                    max="30"
                    value={bulkReminderIntervalDays}
                    onChange={(event) => setBulkReminderIntervalDays(event.target.value)}
                    disabled={!bulkRemindersEnabled}
                  />
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Switch checked={bulkRemindersEnabled} onCheckedChange={setBulkRemindersEnabled} />
                  <span className="text-xs text-muted-foreground">Reminders</span>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleBulkSend()} disabled={pendingActionId === "bulk-send" || !bulkTemplateId}>
                {pendingActionId === "bulk-send" ? "Sending..." : "Send envelopes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={offlineDialogOpen} onOpenChange={setOfflineDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload signed copy</DialogTitle>
              <DialogDescription>
                Mark this envelope complete using a wet-ink or offline signed PDF.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <input
                ref={offlineFileInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(event) => setOfflineFile(event.target.files?.[0] ?? null)}
              />
              <Button variant="outline" className="w-full justify-start" onClick={() => offlineFileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                {offlineFile ? offlineFile.name : "Choose signed PDF"}
              </Button>
              <div className="space-y-2">
                <label className="text-sm font-medium">Signer name</label>
                <Input value={offlineSignerName} onChange={(event) => setOfflineSignerName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Note</label>
                <Input
                  value={offlineNote}
                  onChange={(event) => setOfflineNote(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOfflineDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleConfirmOffline()} disabled={!offlineFile || pendingActionId !== null}>
                Record signed copy
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Void Dialog */}
        <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Void envelope?</DialogTitle>
              <DialogDescription>
                This will invalidate all current signing links. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-2">
              <label className="text-sm font-medium">Reason for voiding (optional)</label>
              <Input 
                value={voidReason} 
                onChange={(e) => setVoidReason(e.target.value)} 
                placeholder="e.g., Error in contract terms, wrong recipient"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setVoidDialogOpen(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleConfirmVoid} disabled={pendingActionId !== null}>
                {pendingActionId ? "Voiding..." : "Void Envelope"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete draft?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this draft? This will remove all prepared fields and recipients.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleConfirmDelete}>
                Delete Draft
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={resendDialogOpen} onOpenChange={setResendDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Void and send a new copy?</AlertDialogTitle>
              <AlertDialogDescription>
                This voids the current envelope and creates a fresh one with new signing links.
                Any signatures already collected on the current envelope will not carry over.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmDuplicatePacket}>
                Void & send new copy
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}

interface MobileEnvelopeListProps {
  rows: SignatureHubRow[]
  scope: "org" | "project"
  pendingActionId: string | null
  onRowOpen: (row: SignatureHubRow) => void
  onRowActions: (row: SignatureHubRow) => void
  onNewEnvelope: () => void
  canCreate: boolean
}

function MobileEnvelopeList({
  rows,
  scope,
  pendingActionId,
  onRowOpen,
  onRowActions,
  onNewEnvelope,
  canCreate,
}: MobileEnvelopeListProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <p className="font-medium">No envelopes found</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Adjust your filters or create a new envelope.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={onNewEnvelope} className="mt-1">
            <Plus className="mr-2 h-4 w-4" />
            New Signature Envelope
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <MobileEnvelopeRow
          key={row.envelope_id}
          row={row}
          scope={scope}
          isPending={pendingActionId === row.envelope_id}
          onOpen={() => onRowOpen(row)}
          onActions={() => onRowActions(row)}
        />
      ))}
    </ul>
  )
}

const envelopeStatusDot: Record<string, string> = {
  draft: "bg-muted-foreground/40",
  sent: "bg-blue-500",
  partially_signed: "bg-amber-500",
  executed: "bg-emerald-500",
  voided: "bg-rose-500",
  expired: "bg-orange-500",
}

function MobileEnvelopeRow({
  row,
  scope,
  isPending,
  onOpen,
  onActions,
}: {
  row: SignatureHubRow
  scope: "org" | "project"
  isPending: boolean
  onOpen: () => void
  onActions: () => void
}) {
  const hasActions = getAvailableActions(row).length > 0
  const subtitleParts = [
    `${row.signer_summary.signed}/${row.signer_summary.total}`,
    scope === "org" && row.project_name ? row.project_name : null,
    row.recipient_names[0] ?? null,
  ].filter(Boolean) as string[]

  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={onOpen}
        disabled={isPending}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60 disabled:opacity-60"
      >
        <span
          aria-hidden
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            envelopeStatusDot[row.envelope_status] ?? "bg-muted-foreground/40",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
              {getSourceLabel(row)}
            </p>
            {row.queue_flags.expiring_soon ? (
              <span className="shrink-0 text-[10px] font-medium text-orange-600 dark:text-orange-400">
                Expiring
              </span>
            ) : row.expires_at ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {format(new Date(row.expires_at), "MMM d")}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {subtitleParts.join(" · ")}
          </p>
        </div>
      </button>
      {hasActions ? (
        <button
          type="button"
          onClick={onActions}
          disabled={isPending}
          aria-label="More actions"
          className="flex w-11 shrink-0 items-center justify-center text-muted-foreground active:bg-muted/60 disabled:opacity-60"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      ) : null}
    </li>
  )
}
