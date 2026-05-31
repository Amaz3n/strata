"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Contact, CostCode, Estimate } from "@/lib/types"
import type { EstimateInput } from "@/lib/validation/estimates"
import {
  createEstimateAction,
  duplicateEstimateAction,
  updateEstimateStatusAction,
  sendEstimateAction,
  getEstimateBuilderSigningLinkAction,
  getEstimateShareLinkAction,
  reviseEstimateAction,
} from "@/app/(app)/estimates/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Copy, FileText, Send, CheckCircle2 } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EstimateCreateSheet } from "@/components/estimates/estimate-create-sheet"
import { EstimateActivitySheet } from "@/components/estimates/estimate-activity-sheet"

type StatusKey =
  | "draft"
  | "sent"
  | "approved"
  | "client_signed"
  | "executed"
  | "converted_to_project"
  | "rejected"
  | "changes_requested"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved (manual)",
  client_signed: "Client signed",
  executed: "Executed",
  converted_to_project: "Project created",
  rejected: "Rejected",
  changes_requested: "Changes requested",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/15 text-success border-success/30",
  client_signed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  executed: "bg-success/20 text-success border-success/40",
  converted_to_project: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  changes_requested: "bg-amber-500/15 text-amber-600 border-amber-500/30",
}

interface EstimatesClientProps {
  estimates: Array<Estimate & { recipient_name?: string | null }>
  contacts: Contact[]
  costCodes: CostCode[]
  defaultTerms?: string
  initialRecipientId?: string
  initialProjectId?: string
  initialProspectId?: string
}

export function EstimatesClient({
  estimates,
  contacts,
  costCodes,
  defaultTerms,
  initialRecipientId,
  initialProjectId,
  initialProspectId,
}: EstimatesClientProps) {
  const [items, setItems] = useState(estimates)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, startCreating] = useTransition()
  const [countersigningId, setCountersigningId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [revisingId, setRevisingId] = useState<string | null>(null)
  const [activityEstimate, setActivityEstimate] = useState<(Estimate & { recipient_name?: string | null }) | null>(null)

  useEffect(() => {
    if (initialRecipientId || initialProjectId || initialProspectId) {
      setCreateOpen(true)
    }
  }, [initialRecipientId, initialProjectId, initialProspectId])

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((estimate) => {
      const status = resolveStatus(estimate.status)
      const matchesStatus = statusFilter === "all" || status === statusFilter
      const haystack = [estimate.title, estimate.recipient_name ?? ""].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesStatus && matchesSearch
    })
  }, [items, search, statusFilter])

  function resolveStatus(status?: string | null): StatusKey {
    if (
      status === "sent" ||
      status === "approved" ||
      status === "client_signed" ||
      status === "executed" ||
      status === "converted_to_project" ||
      status === "rejected" ||
      status === "changes_requested"
    )
      return status
    return "draft"
  }

  async function handleCreate(input: EstimateInput) {
    startCreating(async () => {
      try {
        const estimate = await createEstimateAction(input)
        const recipient = contacts.find((contact) => contact.id === estimate.recipient_contact_id)
        setItems((prev) => [{ ...estimate, recipient_name: recipient?.full_name ?? null }, ...prev])
        setCreateOpen(false)
        toast.success("Estimate created")
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to create estimate", { description: error?.message ?? "Please try again." })
      }
    })
  }

  async function handleCountersign(estimate: Estimate & { recipient_name?: string | null }) {
    setCountersigningId(estimate.id)
    try {
      const result = await getEstimateBuilderSigningLinkAction(estimate.id)
      if (!result.url) {
        throw new Error("Signing link was not returned.")
      }
      const signingUrl = new URL(result.url, window.location.origin)
      if (!signingUrl.pathname.startsWith("/d/")) {
        throw new Error("Signing link did not point to a document signing request.")
      }
      window.location.assign(signingUrl.toString())
      toast.success("Builder signing opened", {
        description: result.signerEmail ? `Signing request assigned to ${result.signerEmail}.` : "Complete the signature to execute the estimate.",
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Couldn't open builder signing", { description: error?.message ?? "Please try again." })
    } finally {
      setCountersigningId(null)
    }
  }

  async function handleSend(estimateId: string) {
    setSendingId(estimateId)
    try {
      const result = await sendEstimateAction(estimateId)
      setItems((prev) => prev.map((item) => (item.id === estimateId ? { ...item, status: "sent" } : item)))
      await copyToClipboard(result.url)
      toast.success(result.emailSent ? "Estimate sent to client" : "Estimate marked sent", {
        description: result.emailSent ? "Review link copied to clipboard." : "Email skipped — review link copied.",
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Couldn't send estimate", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingId(null)
    }
  }

  async function handleCopyLink(estimateId: string) {
    try {
      const result = await getEstimateShareLinkAction(estimateId)
      await copyToClipboard(result.url)
      toast.success("Review link copied")
    } catch (error: any) {
      console.error(error)
      toast.error("Couldn't create link", { description: error?.message ?? "Please try again." })
    }
  }

  async function handleRevise(estimateId: string) {
    setRevisingId(estimateId)
    try {
      const revised = await reviseEstimateAction(estimateId)
      const recipient = contacts.find((contact) => contact.id === revised.recipient_contact_id)
      setItems((prev) => [
        { ...revised, recipient_name: recipient?.full_name ?? null },
        ...prev.map((item) => (item.id === estimateId ? { ...item, is_current_version: false } : item)),
      ])
      toast.success("New version created", { description: "Edit the draft, then send it to your client." })
    } catch (error: any) {
      console.error(error)
      toast.error("Couldn't revise", { description: error?.message ?? "Please try again." })
    } finally {
      setRevisingId(null)
    }
  }

  async function handleDuplicate(estimateId: string) {
    setDuplicatingId(estimateId)
    try {
      const duplicated = await duplicateEstimateAction(estimateId)
      setItems((prev) => [duplicated, ...prev])
      toast.success("New estimate version created")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to duplicate", { description: error?.message ?? "Please try again." })
    } finally {
      setDuplicatingId(null)
    }
  }

  async function handleStatus(estimateId: string, status: "draft" | "sent" | "approved" | "rejected") {
    try {
      const updated = await updateEstimateStatusAction(estimateId, status)
      setItems((prev) => prev.map((item) => (item.id === estimateId ? { ...item, status: updated.status } : item)))
      toast.success(`Marked as ${status}`)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to update status", { description: error?.message ?? "Please try again." })
    }
  }

  return (
    <div className="space-y-4">
      <EstimateCreateSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        contacts={contacts}
        costCodes={costCodes}
        defaultTerms={defaultTerms}
        defaultRecipientId={initialRecipientId}
        defaultProjectId={initialProjectId}
        defaultProspectId={initialProspectId}
        onCreate={handleCreate}
        loading={creating}
      />

      <EstimateActivitySheet
        estimate={activityEstimate}
        open={!!activityEstimate}
        onOpenChange={(open) => {
          if (!open) setActivityEstimate(null)
        }}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search estimates..."
            className="w-full sm:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(["draft", "sent", "changes_requested", "client_signed", "executed", "approved", "rejected"] as StatusKey[]).map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New estimate
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Title</TableHead>
              <TableHead className="px-4 py-4">Client</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="text-right px-4 py-4">Total</TableHead>
              <TableHead className="px-4 py-4 text-center">Valid until</TableHead>
              <TableHead className="px-4 py-4 text-center">Created</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((estimate) => {
              const statusKey = resolveStatus(estimate.status)
              return (
                <TableRow key={estimate.id} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <button
                      type="button"
                      className="text-left font-semibold hover:underline"
                      onClick={() => setActivityEstimate(estimate)}
                    >
                      {estimate.title}
                    </button>
                    {estimate.is_current_version === false ? (
                      <div className="text-xs text-muted-foreground">superseded · v{estimate.version}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">{estimate.recipient_name ?? "—"}</TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary" className={`border ${statusStyles[statusKey]}`}>
                      {statusLabels[statusKey]}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right">
                    <div className="font-semibold">{formatCurrency(estimate.total_cents)}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {estimate.valid_until ? format(new Date(estimate.valid_until), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {estimate.created_at ? format(new Date(estimate.created_at), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="text-center w-12 px-4 py-4">
                    <div className="flex justify-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Estimate actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => void handleSend(estimate.id)}
                            disabled={sendingId === estimate.id}
                          >
                            <Send className="mr-2 h-4 w-4" />
                            {sendingId === estimate.id ? "Sending..." : "Send to client"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleCopyLink(estimate.id)}>
                            <Copy className="mr-2 h-4 w-4" />
                            Copy review link
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => window.open(`/estimates/${estimate.id}/export`, "_blank")}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            Export PDF
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => void handleCountersign(estimate)}
                            disabled={countersigningId === estimate.id || statusKey !== "client_signed"}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            {countersigningId === estimate.id ? "Opening..." : "Open builder signing"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void handleRevise(estimate.id)}
                            disabled={revisingId === estimate.id}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {revisingId === estimate.id ? "Creating..." : "Revise (new version)"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void handleDuplicate(estimate.id)}
                            disabled={duplicatingId === estimate.id}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            {duplicatingId === estimate.id ? "Duplicating..." : "Duplicate"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void handleStatus(estimate.id, "approved")}>
                            Mark approved
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleStatus(estimate.id, "rejected")}>
                            Mark rejected
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
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No estimates yet</p>
                      <p className="text-sm">Create your first estimate to get started.</p>
                    </div>
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create estimate
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function formatCurrency(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

async function copyToClipboard(text: string) {
  if (navigator?.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
    } catch (error) {
      // Fallback for browsers that don't support clipboard API or when permission is denied
      console.warn("Clipboard API failed, using fallback method:", error)

      // Create a temporary textarea element to copy from
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
        console.log("Fallback copy successful")
      } catch (fallbackError) {
        console.error("Fallback copy also failed:", fallbackError)
        toast.error("Could not copy link", {
          description: "Please copy the link manually from the address bar."
        })
      } finally {
        document.body.removeChild(textArea)
      }
    }
  } else {
    // Fallback for older browsers
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
      console.log("Legacy copy successful")
    } catch (error) {
      console.error("Legacy copy failed:", error)
      toast.error("Could not copy link", {
        description: "Please copy the link manually from the address bar."
      })
    } finally {
      document.body.removeChild(textArea)
    }
  }
}
