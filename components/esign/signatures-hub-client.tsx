"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import {
  deleteDraftDocumentAction,
  getEnvelopeExecutedDownloadUrlAction,
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, AlertCircle, FileText, User, Users, Calendar } from "@/components/icons"
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

type RowAction = "download" | "resend" | "void" | "delete_draft" | "continue_draft" | "view_source"

function formatDateTime(value?: string | null) {
  if (!value) return "—"
  return format(new Date(value), "MMM d, yyyy h:mm a")
}

function formatStatusLabel(value: string) {
  return value.replaceAll("_", " ")
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
  const rows = initialData.rows
  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all")
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareSource, setPrepareSource] = useState<EnvelopeWizardSourceEntity | null>(null)
  const [prepareDocumentId, setPrepareDocumentId] = useState<string | null>(null)
  const [newEnvelopeProjectId, setNewEnvelopeProjectId] = useState("")

  // Detail & Action State
  const [selectedRow, setSelectedRow] = useState<SignatureHubRow | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [voidDialogOpen, setVoidDialogOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

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
      proposal: "proposals",
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

  const handleStartStandaloneEnvelope = () => {
    if (!newEnvelopeProjectId) {
      toast.error("Project context is required before starting a new envelope.")
      return
    }

    setPrepareSource({
      standalone: true,
      type: "other",
      id: crypto.randomUUID(),
      project_id: newEnvelopeProjectId,
      title: "New envelope",
      document_type: "other",
    })
    setPrepareDocumentId(null)
    setPrepareOpen(true)
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
    ? "Prepare envelope for signature"
    : "Prepare for signature"

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card 
            className={cn("cursor-pointer transition-colors", queueFilter === "all" && "border-primary bg-primary/5")}
            onClick={() => setQueueFilter("all")}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Envelopes</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{initialData.summary.total}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn("cursor-pointer transition-colors", queueFilter === "waiting" && "border-primary bg-primary/5")}
            onClick={() => setQueueFilter("waiting")}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Waiting on Signers</CardTitle>
              <Clock className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{initialData.summary.waiting_on_client}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn("cursor-pointer transition-colors", queueFilter === "expiring" && "border-primary bg-primary/5")}
            onClick={() => setQueueFilter("expiring")}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Expiring Soon</CardTitle>
              <AlertCircle className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{initialData.summary.expiring_soon}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn("cursor-pointer transition-colors", queueFilter === "executed" && "border-primary bg-primary/5")}
            onClick={() => setQueueFilter("executed")}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Executed this Week</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{initialData.summary.executed_this_week}</div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search document, project, recipient, or status"
              className="w-full sm:w-80"
            />
            <Select value={queueFilter} onValueChange={(value) => setQueueFilter(value as QueueFilter)}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Filter queue" />
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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

            <Button onClick={handleStartStandaloneEnvelope} disabled={!newEnvelopeProjectId}>
              New Envelope
            </Button>
          </div>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="divide-x">
                <TableHead className="px-4 py-4">Document</TableHead>
                <TableHead className="px-3 py-4 text-center w-[110px]">Type</TableHead>
                {scope === "org" ? <TableHead className="px-4 py-4">Project</TableHead> : null}
                <TableHead className="px-4 py-4">Signers</TableHead>
                <TableHead className="px-3 py-4 text-center w-[130px]">Status</TableHead>
                <TableHead className="px-4 py-4 w-[140px]">Progress</TableHead>
                <TableHead className="px-3 py-4 w-[120px]">Expires</TableHead>
                <TableHead className="px-3 py-4 text-right w-[100px]">Actions</TableHead>
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
                    className="divide-x hover:bg-muted/50 cursor-pointer group"
                    onClick={() => {
                      setSelectedRow(row)
                      setDetailOpen(true)
                    }}
                  >
                    <TableCell className="px-4 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">{row.document_title}</p>
                        {getVersionLabel(row) ? (
                          <p className="text-xs text-muted-foreground">{getVersionLabel(row)}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-4 text-sm text-muted-foreground capitalize text-center">
                      {formatStatusLabel(row.document_type)}
                    </TableCell>
                    {scope === "org" ? (
                      <TableCell className="px-4 py-4 text-muted-foreground">
                        {row.project_name ?? "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="px-4 py-4">
                      <p className="text-xs text-muted-foreground line-clamp-2">{row.recipient_names.join(", ") || "—"}</p>
                    </TableCell>
                    <TableCell className="px-3 py-4 text-center">
                      <Badge
                        variant="secondary"
                        className={`capitalize border whitespace-nowrap text-[10px] h-5 ${envelopeStatusClassName[row.envelope_status] ?? ""}`}
                      >
                        {formatStatusLabel(row.envelope_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="space-y-1.5">
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
                    <TableCell className="px-3 py-4 text-xs">
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
                    </TableCell>
                    <TableCell className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-2">
                        {hasActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-8 w-8 sm:opacity-0 group-hover:opacity-100 transition-opacity" disabled={isPending} title="More actions">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {availableActions.includes("view_source") ? (
                                <DropdownMenuItem onClick={() => handleViewSource(row)}>
                                  <Link2 className="mr-2 h-4 w-4" />
                                  Open source document
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
                <TableRow className="divide-x">
                  <TableCell colSpan={scope === "org" ? 7 : 6} className="py-10 text-center text-muted-foreground">
                    No envelopes match this filter.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
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
          onEnvelopeSent={() => {
            router.refresh()
          }}
        />

        {/* Detail Drawer */}
        <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
          <SheetContent className="sm:max-w-xl overflow-y-auto">
            {selectedRow && (
              <div className="space-y-6 py-4">
                <SheetHeader>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge
                      variant="secondary"
                      className={`capitalize border whitespace-nowrap text-[10px] h-5 ${envelopeStatusClassName[selectedRow.envelope_status] ?? ""}`}
                    >
                      {formatStatusLabel(selectedRow.envelope_status)}
                    </Badge>
                    <span className="text-xs text-muted-foreground capitalize">{formatStatusLabel(selectedRow.document_type)}</span>
                  </div>
                  <SheetTitle className="text-xl">{selectedRow.document_title}</SheetTitle>
                  <SheetDescription>
                    {selectedRow.project_name ? `Project: ${selectedRow.project_name}` : "Global envelope details"}
                  </SheetDescription>
                </SheetHeader>

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
                        if (action === "continue_draft") handleContinueDraft(selectedRow)
                        if (action === "void") handleVoidTrigger(selectedRow)
                        if (action === "delete_draft") handleDeleteTrigger(selectedRow)
                      }}
                    >
                      {action === "view_source" && <><Link2 className="mr-2 h-4 w-4" /> Open source document</>}
                      {action === "resend" && <><Mail className="mr-2 h-4 w-4" /> Send reminder</>}
                      {action === "download" && <><Download className="mr-2 h-4 w-4" /> Download executed PDF</>}
                      {action === "continue_draft" && <><RefreshCcw className="mr-2 h-4 w-4" /> Continue draft</>}
                      {action === "void" && <><Ban className="mr-2 h-4 w-4" /> Void envelope</>}
                      {action === "delete_draft" && <><Trash2 className="mr-2 h-4 w-4" /> Delete draft</>}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>

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
