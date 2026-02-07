"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Proposal } from "@/lib/types"
import type { ProposalInput } from "@/lib/validation/proposals"
import { createProposalAction, sendProposalAction, generateProposalLinkAction } from "@/app/(app)/proposals/actions"
import {
  getProposalEnvelopeStatusAction,
  sendDocumentSigningReminderAction,
} from "@/app/(app)/documents/actions"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProposalCreateSheet } from "@/components/proposals/proposal-create-sheet"
import {
  Copy,
  FileText,
  Mail,
  MoreHorizontal,
  Plus,
  RefreshCcw,
} from "@/components/icons"

type StatusKey = "draft" | "sent" | "accepted"

type ProposalListItem = Proposal & {
  project_name?: string | null
  token?: string | null
  esign_status?: "not_prepared" | "draft" | "sent" | "signed" | "voided" | "expired" | null
  esign_document_id?: string | null
}

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  accepted: "bg-success/15 text-success border-success/30",
}

interface ProposalsClientProps {
  proposals: ProposalListItem[]
  projects: Array<{ id: string; name: string }>
  allowNoProject?: boolean
}

type ProposalEnvelopeStatus = {
  proposal: { id: string; title: string }
  document: {
    id: string
    title: string
    status: "draft" | "sent" | "signed" | "voided" | "expired"
    executed_file_id?: string | null
    created_at?: string | null
    updated_at?: string | null
  } | null
  signers: Array<{
    id: string
    sequence: number
    signer_role?: string | null
    email?: string | null
    signer_name?: string | null
    status: "draft" | "sent" | "viewed" | "signed" | "voided" | "expired"
    sent_at?: string | null
    viewed_at?: string | null
    signed_at?: string | null
    can_remind: boolean
  }>
  summary: { total: number; signed: number; viewed: number; pending: number }
}

function resolveStatus(status?: string | null): StatusKey {
  if (status === "sent" || status === "accepted") return status
  return "draft"
}

function resolveESignStatus(status?: string | null) {
  switch (status) {
    case "sent":
      return {
        label: "Pending signature",
        className: "bg-amber-500/15 text-amber-700 border-amber-500/30",
      }
    case "signed":
      return {
        label: "Executed",
        className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
      }
    case "draft":
      return {
        label: "Draft envelope",
        className: "bg-muted text-muted-foreground border-muted",
      }
    case "voided":
      return {
        label: "Voided",
        className: "bg-rose-500/15 text-rose-700 border-rose-500/30",
      }
    case "expired":
      return {
        label: "Expired",
        className: "bg-orange-500/15 text-orange-700 border-orange-500/30",
      }
    default:
      return {
        label: "Not prepared",
        className: "bg-muted text-muted-foreground border-muted",
      }
  }
}

function resolveSignerRequestStatus(status?: string | null) {
  switch (status) {
    case "signed":
      return { label: "Signed", className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30" }
    case "viewed":
      return { label: "Viewed", className: "bg-blue-500/15 text-blue-700 border-blue-500/30" }
    case "sent":
      return { label: "Sent", className: "bg-amber-500/15 text-amber-700 border-amber-500/30" }
    case "voided":
      return { label: "Voided", className: "bg-rose-500/15 text-rose-700 border-rose-500/30" }
    case "expired":
      return { label: "Expired", className: "bg-orange-500/15 text-orange-700 border-orange-500/30" }
    default:
      return { label: "Draft", className: "bg-muted text-muted-foreground border-muted" }
  }
}

function canPrepareProposalForSignature(proposal: ProposalListItem) {
  return proposal.status !== "accepted" && proposal.esign_status !== "signed"
}

export function ProposalsClient({ proposals, projects, allowNoProject = true }: ProposalsClientProps) {
  const [items, setItems] = useState<ProposalListItem[]>(proposals)
  const [search, setSearch] = useState("")
  const [projectFilter, setProjectFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, startCreating] = useTransition()
  const [sendingId, setSendingId] = useState<string | null>(null)

  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareProposal, setPrepareProposal] = useState<ProposalListItem | null>(null)

  const [statusSheetOpen, setStatusSheetOpen] = useState(false)
  const [statusSheetLoading, setStatusSheetLoading] = useState(false)
  const [statusSheetProposal, setStatusSheetProposal] = useState<ProposalListItem | null>(null)
  const [statusSheetData, setStatusSheetData] = useState<ProposalEnvelopeStatus | null>(null)
  const [remindingSignerId, setRemindingSignerId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((item) => {
      const matchesProject =
        projectFilter === "all" ||
        (projectFilter === "none" ? !item.project_id : item.project_id === projectFilter)
      const status = resolveStatus(item.status)
      const matchesStatus = statusFilter === "all" || status === statusFilter
      const haystack = [item.title, item.number, item.project_name ?? ""].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesProject && matchesStatus && matchesSearch
    })
  }, [items, projectFilter, search, statusFilter])

  async function handleCreate(input: ProposalInput) {
    startCreating(async () => {
      try {
        const { proposal, viewUrl, token } = await createProposalAction(input)
        setItems((prev) => [
          { ...proposal, token, project_name: projects.find((project) => project.id === proposal.project_id)?.name },
          ...prev,
        ])
        setCreateOpen(false)
        if (navigator?.clipboard) {
          await navigator.clipboard.writeText(viewUrl)
          toast.success("Proposal created", { description: "Link copied to clipboard." })
        } else {
          toast.success("Proposal created", { description: viewUrl })
        }
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to create proposal", { description: error?.message ?? "Please try again." })
      }
    })
  }

  async function handleSend(id: string) {
    setSendingId(id)
    try {
      const updated = await sendProposalAction(id)
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updated } : item)))
      toast.success("Proposal marked as sent")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to send", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingId(null)
    }
  }

  async function handleCopyLink(proposalId: string, existingToken?: string | null) {
    try {
      if (existingToken) {
        const url = `${window.location.origin}/proposal/${existingToken}`
        await copyToClipboard(url)
        return
      }
      const { url, token } = await generateProposalLinkAction(proposalId)
      setItems((prev) => prev.map((item) => (item.id === proposalId ? { ...item, token } : item)))
      await copyToClipboard(url)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not generate link", { description: error?.message ?? "Please try again." })
    }
  }

  const handleOpenPrepare = (proposal: ProposalListItem) => {
    if (!canPrepareProposalForSignature(proposal)) {
      toast.error("This proposal already has an executed signature and cannot be re-prepared.")
      return
    }
    if (!proposal.project_id) {
      toast.error("Assign this proposal to a project first.")
      return
    }

    setPrepareProposal(proposal)
    setPrepareOpen(true)
  }

  const loadProposalEnvelopeStatus = async (proposalId: string) => {
    const data = await getProposalEnvelopeStatusAction(proposalId)
    setStatusSheetData(data as ProposalEnvelopeStatus)
    return data as ProposalEnvelopeStatus
  }

  const handleOpenStatusSheet = async (proposal: ProposalListItem) => {
    setStatusSheetProposal(proposal)
    setStatusSheetOpen(true)
    setStatusSheetLoading(true)
    try {
      await loadProposalEnvelopeStatus(proposal.id)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to load signature status", { description: error?.message ?? "Please try again." })
      setStatusSheetData(null)
    } finally {
      setStatusSheetLoading(false)
    }
  }

  const handleSendReminder = async (signingRequestId: string) => {
    if (!statusSheetProposal) return
    setRemindingSignerId(signingRequestId)
    try {
      await sendDocumentSigningReminderAction(signingRequestId)
      toast.success("Reminder sent")
      await loadProposalEnvelopeStatus(statusSheetProposal.id)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to send reminder", { description: error?.message ?? "Please try again." })
    } finally {
      setRemindingSignerId(null)
    }
  }

  const handleEnvelopeSent = ({ documentId }: { documentId: string }) => {
    if (!prepareProposal) return

    setItems((prev) =>
      prev.map((item) =>
        item.id === prepareProposal.id
          ? { ...item, esign_status: "sent", esign_document_id: documentId }
          : item,
      ),
    )

    if (statusSheetProposal?.id === prepareProposal.id) {
      void loadProposalEnvelopeStatus(prepareProposal.id)
    }
  }

  const wizardSourceEntity: EnvelopeWizardSourceEntity | null = prepareProposal
    ? {
        type: "proposal",
        id: prepareProposal.id,
        project_id: prepareProposal.project_id ?? null,
        title: prepareProposal.title,
        document_type: "proposal",
      }
    : null

  return (
    <div className="space-y-4">
      <ProposalCreateSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects}
        allowNoProject={allowNoProject}
        onCreate={handleCreate}
        loading={creating}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search proposals..."
            className="w-full sm:w-72"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {allowNoProject && <SelectItem value="none">No project yet</SelectItem>}
              {(projects ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | StatusKey)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(["draft", "sent", "accepted"] as StatusKey[]).map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New proposal
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Number</TableHead>
              <TableHead className="px-4 py-4">Title</TableHead>
              <TableHead className="px-4 py-4">Project</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Signature</TableHead>
              <TableHead className="text-right px-4 py-4">Total</TableHead>
              <TableHead className="px-4 py-4 text-center">Valid until</TableHead>
              <TableHead className="px-4 py-4 text-center">Sent</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">&#8206;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((proposal) => {
              const statusKey = resolveStatus(proposal.status)
              return (
                <TableRow key={proposal.id} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <div className="font-semibold">{proposal.number ?? "—"}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4">
                    <button
                      type="button"
                      className="font-semibold text-left hover:underline"
                      onClick={() => void handleOpenStatusSheet(proposal)}
                    >
                      {proposal.title}
                    </button>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {proposal.project_name ?? (proposal.project_id ? "—" : "Preconstruction")}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary" className={`border ${statusStyles[statusKey]}`}>
                      {statusLabels[statusKey]}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {(() => {
                      const esign = resolveESignStatus(proposal.esign_status)
                      return (
                        <Badge variant="secondary" className={`border ${esign.className}`}>
                          {esign.label}
                        </Badge>
                      )
                    })()}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right">
                    <div className="font-semibold">{formatCurrency(proposal.total_cents)}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {proposal.valid_until ? format(new Date(proposal.valid_until), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {proposal.sent_at ? format(new Date(proposal.sent_at), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="text-center w-12 px-4 py-4">
                    <div className="flex justify-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Proposal actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void handleOpenStatusSheet(proposal)}>
                            Signature status
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleOpenPrepare(proposal)}
                            disabled={!canPrepareProposalForSignature(proposal)}
                          >
                            {canPrepareProposalForSignature(proposal)
                              ? "Prepare for signature"
                              : "Signature already executed"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleCopyLink(proposal.id, proposal.token)}>
                            <Copy className="mr-2 h-4 w-4" />
                            Copy link
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleSend(proposal.id)} disabled={sendingId === proposal.id}>
                            <Mail className="mr-2 h-4 w-4" />
                            {sendingId === proposal.id ? "Sending..." : "Mark sent"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No proposals yet</p>
                      <p className="text-sm">Create your first proposal to get started.</p>
                    </div>
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create proposal
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet
        open={statusSheetOpen}
        onOpenChange={(nextOpen) => {
          setStatusSheetOpen(nextOpen)
          if (!nextOpen) {
            setStatusSheetLoading(false)
            setStatusSheetData(null)
            setStatusSheetProposal(null)
            setRemindingSignerId(null)
          }
        }}
      >
        <SheetContent side="right" mobileFullscreen className="sm:max-w-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)]">
          <SheetHeader className="space-y-2">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Signature status
            </SheetTitle>
            <SheetDescription>
              {statusSheetProposal?.title ?? "Proposal"}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {statusSheetLoading ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading status...</div>
            ) : !statusSheetData?.document ? (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No signature envelope has been prepared for this proposal yet.
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Envelope</p>
                    {(() => {
                      const status = resolveESignStatus(statusSheetData.document?.status)
                      return (
                        <Badge variant="secondary" className={`mt-2 border ${status.className}`}>
                          {status.label}
                        </Badge>
                      )
                    })()}
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Total signers</p>
                    <p className="mt-1 text-xl font-semibold">{statusSheetData.summary.total}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Signed</p>
                    <p className="mt-1 text-xl font-semibold">{statusSheetData.summary.signed}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Pending</p>
                    <p className="mt-1 text-xl font-semibold">{statusSheetData.summary.pending}</p>
                  </div>
                </div>

                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="divide-x">
                        <TableHead className="px-4 py-3 text-center">Order</TableHead>
                        <TableHead className="px-4 py-3">Signer</TableHead>
                        <TableHead className="px-4 py-3 text-center">Status</TableHead>
                        <TableHead className="px-4 py-3">Activity</TableHead>
                        <TableHead className="px-4 py-3 text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statusSheetData.signers.map((signer) => {
                        const signerStatus = resolveSignerRequestStatus(signer.status)
                        return (
                          <TableRow key={signer.id} className="divide-x">
                            <TableCell className="px-4 py-3 text-center">{signer.sequence}</TableCell>
                            <TableCell className="px-4 py-3">
                              <p className="font-medium">{signer.signer_name || signer.email || signer.signer_role || "Signer"}</p>
                              <p className="text-xs text-muted-foreground">{signer.email || signer.signer_role || "—"}</p>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-center">
                              <Badge variant="secondary" className={`border ${signerStatus.className}`}>
                                {signerStatus.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                              {signer.signed_at
                                ? `Signed ${formatDateTime(signer.signed_at)}`
                                : signer.viewed_at
                                  ? `Opened ${formatDateTime(signer.viewed_at)}`
                                  : signer.sent_at
                                    ? `Sent ${formatDateTime(signer.sent_at)}`
                                    : "Not sent yet"}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-right">
                              {signer.can_remind ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleSendReminder(signer.id)}
                                  disabled={remindingSignerId === signer.id}
                                >
                                  <RefreshCcw className="mr-2 h-3 w-3" />
                                  {remindingSignerId === signer.id ? "Sending..." : "Reminder"}
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <EnvelopeWizard
        open={prepareOpen}
        onOpenChange={(nextOpen) => {
          setPrepareOpen(nextOpen)
          if (!nextOpen) {
            setPrepareProposal(null)
          }
        }}
        sourceEntity={wizardSourceEntity}
        sourceLabel="Proposal"
        sheetTitle="Prepare proposal for signature"
        onEnvelopeSent={handleEnvelopeSent}
      />
    </div>
  )
}

function formatCurrency(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDateTime(value?: string | null) {
  if (!value) return "—"
  return format(new Date(value), "MMM d, yyyy h:mm a")
}

async function copyToClipboard(text: string) {
  if (navigator?.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Link copied", { description: text })
    } catch (error) {
      console.warn("Clipboard API failed, using fallback method:", error)
      const textArea = document.createElement("textarea")
      textArea.value = text
      textArea.style.position = "fixed"
      textArea.style.left = "-9999px"
      textArea.style.top = "-9999px"
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()

      try {
        document.execCommand("copy")
        toast.success("Link copied", { description: text })
      } catch (fallbackError) {
        console.error("Fallback copy also failed:", fallbackError)
        toast.error("Could not copy link", {
          description: "Please copy the link manually from the address bar.",
        })
      } finally {
        document.body.removeChild(textArea)
      }
    }
    return
  }

  const textArea = document.createElement("textarea")
  textArea.value = text
  textArea.style.position = "fixed"
  textArea.style.left = "-9999px"
  textArea.style.top = "-9999px"
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()

  try {
    document.execCommand("copy")
    toast.success("Link copied", { description: text })
  } catch (error) {
    console.error("Legacy copy failed:", error)
    toast.error("Could not copy link", {
      description: "Please copy the link manually from the address bar.",
    })
  } finally {
    document.body.removeChild(textArea)
  }
}
