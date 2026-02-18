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
} from "@/app/(app)/documents/actions"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2 } from "@/components/icons"

type QueueFilter = "all" | "waiting" | "executed" | "expiring"
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

type RowAction = "download" | "resend" | "void" | "delete_draft" | "continue_draft"

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
        (queueFilter === "executed" && row.queue_flags.executed_this_week) ||
        (queueFilter === "expiring" && row.queue_flags.expiring_soon)

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

  const handleVoid = async (row: SignatureHubRow) => {
    const confirmed = window.confirm("Void this envelope and invalidate any pending signing links?")
    if (!confirmed) return
    await withPendingAction(row.envelope_id, async () => {
      await voidEnvelopeAction({ envelopeId: row.envelope_id, reason: "Voided from signatures hub" })
      toast.success("Envelope voided")
    })
  }

  const handleDownload = async (row: SignatureHubRow) => {
    await withPendingAction(row.envelope_id, async () => {
      const result = await getEnvelopeExecutedDownloadUrlAction({ envelopeId: row.envelope_id })
      window.open(result.url, "_blank", "noopener,noreferrer")
    })
  }

  const handleDeleteDraft = async (row: SignatureHubRow) => {
    const confirmed = window.confirm("Delete this draft document? This cannot be undone.")
    if (!confirmed) return
    await withPendingAction(row.envelope_id, async () => {
      await deleteDraftDocumentAction({ documentId: row.document_id })
      toast.success("Draft deleted")
    })
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
      <div className="space-y-4">
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
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="waiting">Waiting on client</SelectItem>
                <SelectItem value="executed">Executed this week</SelectItem>
                <SelectItem value="expiring">Expiring soon</SelectItem>
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
                <TableHead className="px-3 py-4 text-center w-[150px]">Status</TableHead>
                <TableHead className="px-4 py-4">Progress</TableHead>
                <TableHead className="px-3 py-4 w-[190px]">Last change</TableHead>
                <TableHead className="px-3 py-4 text-right w-[170px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => {
                const isPending = pendingActionId === row.envelope_id
                const availableActions = getAvailableActions(row)
                const hasActions = availableActions.length > 0

                return (
                  <TableRow key={row.envelope_id} className="divide-x">
                    <TableCell className="px-4 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">{row.document_title}</p>
                        {getVersionLabel(row) ? (
                          <p className="text-xs text-muted-foreground">{getVersionLabel(row)}</p>
                        ) : null}
                        <p className="text-xs text-muted-foreground">{getRecipientSubtitle(row)}</p>
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
                    <TableCell className="px-3 py-4 text-center">
                      <Badge
                        variant="secondary"
                        className={`capitalize border whitespace-nowrap text-xs ${envelopeStatusClassName[row.envelope_status] ?? ""}`}
                      >
                        {formatStatusLabel(row.envelope_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="space-y-2">
                        <Progress value={getProgressPercent(row)} className="h-2" />
                        <p className="text-xs text-muted-foreground">
                          {row.signer_summary.signed}/{row.signer_summary.total} signed
                        </p>
                        {getPendingLabel(row) ? (
                          <p className="text-xs text-muted-foreground">{getPendingLabel(row)}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-4 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(row.last_event_at)}
                    </TableCell>
                    <TableCell className="px-3 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {hasActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-8 w-8" disabled={isPending} title="More actions">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
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
                                <DropdownMenuItem onClick={() => void handleVoid(row)}>
                                  <Ban className="mr-2 h-4 w-4" />
                                  Void envelope
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("delete_draft") ? (
                                <DropdownMenuItem onClick={() => void handleDeleteDraft(row)}>
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
      </div>
    </TooltipProvider>
  )
}
