"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import {
  deleteDraftDocumentAction,
  getEnvelopeExecutedDownloadUrlAction,
  listSignatureStartTargetsAction,
  resendEnvelopeAction,
  sendDocumentSigningReminderAction,
  voidEnvelopeAction,
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, FileText, Users, Calendar, Plus, Search, Filter, ChevronRight } from "@/components/icons"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

type QueueFilter = "all" | "waiting" | "executed" | "expiring" | "drafts" | "voided"
type SignatureHubRow = {
  envelope_id: string
  document_id: string
  document_title: string
  document_type: string
  document_status: string
  document_metadata: Record<string, any>
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
  last_event_at: string | null
  can_remind: boolean
  can_void: boolean
  can_resend: boolean
  can_download: boolean
  can_delete_draft: boolean
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

type RowAction = "download" | "resend" | "duplicate_packet" | "void" | "delete_draft" | "continue_draft" | "view_source"

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
    case "change_order":
      return "Change Order"
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
    case "proposal":
      return `Proposal · ${row.document_title}`
    case "selection":
      return `Selection · ${row.document_title}`
    case "subcontract":
      return `Subcontract · ${row.document_title}`
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
    case "proposal":
      return "Open proposal signature"
    case "selection":
      return "Open selection"
    case "subcontract":
      return "Open commitment"
    default:
      return "Open source"
  }
}

function getRecipientSubtitle(row: SignatureHubRow) {
  if (row.recipient_names.length === 0) return "To: —"
  return `To: ${row.recipient_names.join(", ")}`
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

function getAvailableActions(row: SignatureHubRow): RowAction[] {
  const actions: RowAction[] = []
  if (row.document_status === "draft") actions.push("continue_draft")
  if (row.can_download) actions.push("download")
  if (row.can_remind) actions.push("resend")
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

  // Mobile UI state
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false)
  const [mobileProjectPickerOpen, setMobileProjectPickerOpen] = useState(false)
  const [mobileActionsRow, setMobileActionsRow] = useState<SignatureHubRow | null>(null)

  useEffect(() => {
    if (projectsForNewEnvelope.length === 0) {
      setNewEnvelopeProjectId("")
      return
    }

    if (!newEnvelopeProjectId || !projectsForNewEnvelope.some((project) => project.id === newEnvelopeProjectId)) {
      setNewEnvelopeProjectId(projectsForNewEnvelope[0].id)
    }
  }, [newEnvelopeProjectId, projectsForNewEnvelope])

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
    } finally {
      setPendingActionId(null)
    }
  }

  const handleResendReminder = async (row: SignatureHubRow) => {
    if (!row.next_pending_request_id) return
    await withPendingAction(row.envelope_id, async () => {
      await sendDocumentSigningReminderAction(row.next_pending_request_id as string)
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
      await voidEnvelopeAction({ 
        envelopeId: selectedRow.envelope_id, 
        reason: voidReason || "Voided from signatures hub" 
      })
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

  const handleDuplicatePacket = async (row: SignatureHubRow) => {
    await withPendingAction(row.envelope_id, async () => {
      await resendEnvelopeAction({ envelopeId: row.envelope_id })
      toast.success("Signature packet resent")
    })
  }

  const handleDeleteTrigger = (row: SignatureHubRow) => {
    setSelectedRow(row)
    setDeleteDialogOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (!selectedRow) return
    await withPendingAction(selectedRow.envelope_id, async () => {
      await deleteDraftDocumentAction({ documentId: selectedRow.document_id })
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
      proposal: "signatures",
      change_order: "change-orders",
      subcontract: "commitments",
      lien_waiver: "financials",
    }

    if (entityRoutes[row.source_entity_type as string]) {
      router.push(`/projects/${projectId}/${entityRoutes[row.source_entity_type as string]}`)
    } else {
      router.push(`/projects/${projectId}/documents`)
    }
  }

  const handleOpenSourcePicker = async () => {
    if (!newEnvelopeProjectId) {
      toast.error("Project context is required before starting a signature packet.")
      return
    }

    setPrepareSource(null)
    setPrepareDocumentId(null)
    setPrepareOpen(true)
    setLoadingSourceTargets(true)
    try {
      const targets = await listSignatureStartTargetsAction({ projectId: newEnvelopeProjectId })
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
    ? "Prepare signature packet"
    : "Prepare linked signature packet"

  const handleMobileNewEnvelope = () => {
    if (scope === "org" && projectsForNewEnvelope.length > 1) {
      setMobileProjectPickerOpen(true)
      return
    }
    void handleOpenSourcePicker()
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
                disabled={!newEnvelopeProjectId}
                aria-label="New signature packet"
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
            {scope === "org" ? (
              <Select value={newEnvelopeProjectId} onValueChange={setNewEnvelopeProjectId} disabled={projectsForNewEnvelope.length === 0}>
                <SelectTrigger className="w-full sm:w-60">
                  <SelectValue placeholder="Project for new envelope" />
                </SelectTrigger>
                <SelectContent>
                  {projectsForNewEnvelope.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <Button onClick={() => void handleOpenSourcePicker()} disabled={!newEnvelopeProjectId} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New Signature Packet
            </Button>
          </div>
        </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
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
              canCreate={Boolean(newEnvelopeProjectId)}
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
                          <span>{getProgressPercent(row)}%</span>
                        </div>
                        <Progress value={getProgressPercent(row)} className="h-1.5" />
                        {getPendingLabel(row) ? (
                          <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium truncate">{getPendingLabel(row)}</p>
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
                                <DropdownMenuItem onClick={() => void handleDuplicatePacket(row)}>
                                  <RefreshCcw className="mr-2 h-4 w-4" />
                                  Duplicate and resend packet
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
                          <Button variant="default" size="sm" onClick={() => void handleOpenSourcePicker()} disabled={!newEnvelopeProjectId}>
                            <Plus className="mr-2 h-4 w-4" />
                            New Signature Packet
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
                          {selectedRow.source_entity_id ? (
                            <Button variant="outline" size="sm" onClick={() => handleViewSource(selectedRow)}>
                              {getOpenSourceActionLabel(selectedRow)}
                            </Button>
                          ) : null}
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
                        {selectedRow.recipient_names.map((name, idx) => {
                          const isSigned = idx < selectedRow.signer_summary.signed;
                          const isPending = idx === selectedRow.signer_summary.signed && selectedRow.envelope_status !== "executed" && selectedRow.envelope_status !== "voided";
                          
                          return (
                            <div key={idx} className="flex items-center justify-between border rounded-lg p-3 bg-muted/30">
                              <div className="flex items-center gap-3">
                                <div className={cn(
                                  "h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium",
                                  isSigned ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400" : 
                                  isPending ? "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400" :
                                  "bg-muted text-muted-foreground"
                                )}>
                                  {isSigned ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                                </div>
                                <div>
                                  <p className="text-sm font-medium">{name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {isSigned ? "Completed signing" : isPending ? "Current signer" : "Awaiting previous signers"}
                                  </p>
                                </div>
                              </div>
                              {isPending && selectedRow.can_remind && (
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
                            if (action === "view_source") handleViewSource(selectedRow)
                            if (action === "resend") handleResendReminder(selectedRow)
                            if (action === "download") handleDownload(selectedRow)
                            if (action === "duplicate_packet") handleDuplicatePacket(selectedRow)
                            if (action === "continue_draft") handleContinueDraft(selectedRow)
                            if (action === "void") handleVoidTrigger(selectedRow)
                            if (action === "delete_draft") handleDeleteTrigger(selectedRow)
                          }}
                        >
                          {action === "view_source" && <><Link2 className="mr-2 h-4 w-4" /> {getOpenSourceActionLabel(selectedRow)}</>}
                          {action === "resend" && <><Mail className="mr-2 h-4 w-4" /> Send reminder</>}
                          {action === "download" && <><Download className="mr-2 h-4 w-4" /> Download executed PDF</>}
                          {action === "duplicate_packet" && <><RefreshCcw className="mr-2 h-4 w-4" /> Duplicate and resend packet</>}
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
                      <div className="space-y-2 text-xs text-muted-foreground">
                        <div className="flex items-center justify-between gap-3">
                          <span>Created</span>
                          <span>{formatDateTime(selectedRow.created_at)}</span>
                        </div>
                        {selectedRow.sent_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span>Sent</span>
                            <span>{formatDateTime(selectedRow.sent_at)}</span>
                          </div>
                        ) : null}
                        {selectedRow.executed_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span>Executed</span>
                            <span>{formatDateTime(selectedRow.executed_at)}</span>
                          </div>
                        ) : null}
                        {selectedRow.last_event_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span>Last activity</span>
                            <span>{formatDateTime(selectedRow.last_event_at)}</span>
                          </div>
                        ) : null}
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
                        {selectedRow.recipient_names.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No recipients</p>
                        ) : (
                          selectedRow.recipient_names.map((name, idx) => {
                            const isSigned = idx < selectedRow.signer_summary.signed
                            const isPending =
                              idx === selectedRow.signer_summary.signed &&
                              selectedRow.envelope_status !== "executed" &&
                              selectedRow.envelope_status !== "voided"
                            return (
                              <div
                                key={`${name}-${idx}`}
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
                                  <p className="truncate text-sm font-medium">{name}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">
                                    {isSigned ? "Signed" : isPending ? "Current signer" : "Awaiting"}
                                  </p>
                                </div>
                                {isPending && selectedRow.can_remind ? (
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
                      <div className="space-y-1.5 rounded-lg border bg-muted/20 px-3 py-2.5 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">Created</span>
                          <span className="font-medium">{formatDateTime(selectedRow.created_at)}</span>
                        </div>
                        {selectedRow.sent_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Sent</span>
                            <span className="font-medium">{formatDateTime(selectedRow.sent_at)}</span>
                          </div>
                        ) : null}
                        {selectedRow.expires_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Expires</span>
                            <span
                              className={cn(
                                "font-medium",
                                selectedRow.queue_flags.expiring_soon && "text-orange-600 dark:text-orange-400",
                              )}
                            >
                              {formatDateTime(selectedRow.expires_at)}
                            </span>
                          </div>
                        ) : null}
                        {selectedRow.executed_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Executed</span>
                            <span className="font-medium">{formatDateTime(selectedRow.executed_at)}</span>
                          </div>
                        ) : null}
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
                                  if (action === "view_source") handleViewSource(selectedRow)
                                  if (action === "resend") void handleResendReminder(selectedRow)
                                  if (action === "download") void handleDownload(selectedRow)
                                  if (action === "duplicate_packet") void handleDuplicatePacket(selectedRow)
                                  if (action === "continue_draft") handleContinueDraft(selectedRow)
                                  if (action === "void") handleVoidTrigger(selectedRow)
                                  if (action === "delete_draft") handleDeleteTrigger(selectedRow)
                                }}
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
                                  isDestructive ? "text-destructive" : "text-foreground",
                                )}
                              >
                                {action === "view_source" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                                {action === "resend" && <Mail className="h-[18px] w-[18px] shrink-0" />}
                                {action === "download" && <Download className="h-[18px] w-[18px] shrink-0" />}
                                {action === "duplicate_packet" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                                {action === "continue_draft" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                                {action === "void" && <Ban className="h-[18px] w-[18px] shrink-0" />}
                                {action === "delete_draft" && <Trash2 className="h-[18px] w-[18px] shrink-0" />}
                                <span className="flex-1">
                                  {action === "view_source" && getOpenSourceActionLabel(selectedRow)}
                                  {action === "resend" && "Send reminder"}
                                  {action === "download" && "Download executed PDF"}
                                  {action === "duplicate_packet" && "Duplicate and resend"}
                                  {action === "continue_draft" && "Continue draft"}
                                  {action === "void" && "Void envelope"}
                                  {action === "delete_draft" && "Delete draft"}
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

        {/* Mobile Filter Drawer */}
        <Drawer open={mobileFilterOpen} onOpenChange={setMobileFilterOpen}>
          <DrawerContent>
            <DrawerHeader className="border-b px-4 py-3">
              <DrawerTitle className="text-center text-sm font-semibold">Filter envelopes</DrawerTitle>
            </DrawerHeader>
            <div className="flex flex-col gap-0.5 px-3 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
              {(Object.keys(queueFilterLabels) as QueueFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setQueueFilter(key)
                    setMobileFilterOpen(false)
                  }}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
                    queueFilter === key && "bg-muted",
                  )}
                >
                  <span>{queueFilterLabels[key]}</span>
                  {queueFilter === key ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
                </button>
              ))}
            </div>
          </DrawerContent>
        </Drawer>

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
                      setTimeout(() => void handleOpenSourcePicker(), 50)
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
                          if (action === "view_source") handleViewSource(row)
                          if (action === "resend") void handleResendReminder(row)
                          if (action === "download") void handleDownload(row)
                          if (action === "duplicate_packet") void handleDuplicatePacket(row)
                          if (action === "continue_draft") handleContinueDraft(row)
                          if (action === "void") handleVoidTrigger(row)
                          if (action === "delete_draft") handleDeleteTrigger(row)
                        }}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
                          isDestructive ? "text-destructive" : "text-foreground",
                        )}
                      >
                        {action === "view_source" && <Link2 className="h-[18px] w-[18px] shrink-0" />}
                        {action === "resend" && <Mail className="h-[18px] w-[18px] shrink-0" />}
                        {action === "download" && <Download className="h-[18px] w-[18px] shrink-0" />}
                        {action === "duplicate_packet" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                        {action === "continue_draft" && <RefreshCcw className="h-[18px] w-[18px] shrink-0" />}
                        {action === "void" && <Ban className="h-[18px] w-[18px] shrink-0" />}
                        {action === "delete_draft" && <Trash2 className="h-[18px] w-[18px] shrink-0" />}
                        <span className="flex-1">
                          {action === "view_source" && getOpenSourceActionLabel(row)}
                          {action === "resend" && "Send reminder"}
                          {action === "download" && "Download executed PDF"}
                          {action === "duplicate_packet" && "Duplicate and resend"}
                          {action === "continue_draft" && "Continue draft"}
                          {action === "void" && "Void envelope"}
                          {action === "delete_draft" && "Delete draft"}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            ) : null}
          </DrawerContent>
        </Drawer>

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
            New Signature Packet
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
