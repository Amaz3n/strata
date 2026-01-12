"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Contact, CostCode, Estimate, EstimateTemplate } from "@/lib/types"
import type { EstimateInput } from "@/lib/validation/estimates"
import { createEstimateAction, convertEstimateToProposalAction, duplicateEstimateAction, updateEstimateStatusAction } from "@/app/(app)/estimates/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Copy, FileText } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EstimateCreateSheet } from "@/components/estimates/estimate-create-sheet"

type StatusKey = "draft" | "sent" | "approved" | "rejected"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/15 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
}

interface EstimatesClientProps {
  estimates: Array<Estimate & { recipient_name?: string | null }>
  contacts: Contact[]
  templates: EstimateTemplate[]
  costCodes: CostCode[]
  initialRecipientId?: string
}

export function EstimatesClient({ estimates, contacts, templates, costCodes, initialRecipientId }: EstimatesClientProps) {
  const [items, setItems] = useState(estimates)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, startCreating] = useTransition()
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  useEffect(() => {
    if (initialRecipientId) {
      setCreateOpen(true)
    }
  }, [initialRecipientId])

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
    if (status === "sent" || status === "approved" || status === "rejected") return status
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

  async function handleConvert(estimateId: string, recipientId?: string | null) {
    if (!recipientId) {
      toast.error("Add a client contact before converting")
      return
    }
    setConvertingId(estimateId)
    try {
      const result = await convertEstimateToProposalAction(estimateId)
      const viewUrl = result.viewUrl
      await copyToClipboard(viewUrl)
      toast.success("Proposal created", { description: "Link copied to clipboard." })
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to convert", { description: error?.message ?? "Please try again." })
    } finally {
      setConvertingId(null)
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

  async function handleStatus(estimateId: string, status: StatusKey) {
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
        templates={templates}
        costCodes={costCodes}
        defaultRecipientId={initialRecipientId}
        onCreate={handleCreate}
        loading={creating}
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
              {(["draft", "sent", "approved", "rejected"] as StatusKey[]).map((status) => (
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
                    <div className="font-semibold">{estimate.title}</div>
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
                            onClick={() => void handleConvert(estimate.id, estimate.recipient_contact_id)}
                            disabled={convertingId === estimate.id}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {convertingId === estimate.id ? "Converting..." : "Convert to proposal"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void handleDuplicate(estimate.id)}
                            disabled={duplicatingId === estimate.id}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            {duplicatingId === estimate.id ? "Duplicating..." : "Duplicate version"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => window.open(`/estimates/${estimate.id}/export`, "_blank")}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            Export PDF
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleStatus(estimate.id, "sent")}>
                            Mark sent
                          </DropdownMenuItem>
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
