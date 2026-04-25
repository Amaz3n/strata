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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, AlertCircle, FileText, User, Users, Calendar, Plus, Search, Filter } from "@/components/icons"
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
      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
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

            <Button onClick={handleStartStandaloneEnvelope} disabled={!newEnvelopeProjectId} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New Envelope
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
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
                        <span className="text-sm font-semibold block truncate">{row.document_title}</span>
                        {getVersionLabel(row) ? (
                          <span className="text-xs text-muted-foreground block">{getVersionLabel(row)}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 text-center">
                      <span className="text-sm text-muted-foreground capitalize block truncate">
                        {formatStatusLabel(row.document_type)}
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
                        {formatStatusLabel(row.envelope_status)}
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
                          <Button variant="default" size="sm" onClick={handleStartStandaloneEnvelope} disabled={!newEnvelopeProjectId}>
                            <Plus className="mr-2 h-4 w-4" />
                            New Envelope
                          </Button>
                        </div>
                      ) : null}
                    </div>
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
                      {selectedRow.document_title}
                    </SheetTitle>
                    <Badge
                      variant="secondary"
                      className={`capitalize border ${envelopeStatusClassName[selectedRow.envelope_status] ?? ""}`}
                    >
                      {formatStatusLabel(selectedRow.envelope_status)}
                    </Badge>
                  </div>
                  <SheetDescription className="text-left mt-2">
                    <div className="flex items-center gap-2">
                      <span className="capitalize">{formatStatusLabel(selectedRow.document_type)}</span>
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
                </ScrollArea>
              </>
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
