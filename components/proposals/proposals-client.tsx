"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Proposal, Project } from "@/lib/types"
import type { ProposalInput } from "@/lib/validation/proposals"
import { createProposalAction, sendProposalAction, generateProposalLinkAction } from "@/app/(app)/proposals/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Mail, Copy, FileText } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProposalCreateSheet } from "@/components/proposals/proposal-create-sheet"

type StatusKey = "draft" | "sent" | "accepted"

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
  proposals: Array<Proposal & { project_name?: string | null; token?: string | null }>
  projects: Array<{ id: string; name: string }>
  allowNoProject?: boolean
}

export function ProposalsClient({ proposals, projects, allowNoProject = true }: ProposalsClientProps) {
  const [items, setItems] = useState(proposals)
  const [search, setSearch] = useState("")
  const [projectFilter, setProjectFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, startCreating] = useTransition()
  const [sendingId, setSendingId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((p) => {
      const matchesProject =
        projectFilter === "all" ||
        (projectFilter === "none" ? !p.project_id : p.project_id === projectFilter)
      const status = resolveStatus(p.status)
      const matchesStatus = statusFilter === "all" || status === statusFilter
      const haystack = [p.title, p.number, p.project_name ?? ""].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesProject && matchesStatus && matchesSearch
    })
  }, [items, projectFilter, search, statusFilter])

  function resolveStatus(status?: string | null): StatusKey {
    if (status === "sent" || status === "accepted") return status
    return "draft"
  }

  async function handleCreate(input: ProposalInput) {
    startCreating(async () => {
      try {
        const { proposal, viewUrl, token } = await createProposalAction(input)
        setItems((prev) => [
          { ...proposal, token, project_name: projects.find((p) => p.id === proposal.project_id)?.name },
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
      setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...updated } : p)))
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
      setItems((prev) => prev.map((p) => (p.id === proposalId ? { ...p, token } : p)))
      await copyToClipboard(url)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not generate link", { description: error?.message ?? "Please try again." })
    }
  }

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
            onChange={(e) => setSearch(e.target.value)}
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
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
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
              <TableHead className="text-right px-4 py-4">Total</TableHead>
              <TableHead className="px-4 py-4 text-center">Valid until</TableHead>
              <TableHead className="px-4 py-4 text-center">Sent</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
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
                    <div className="font-semibold">{proposal.title}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {proposal.project_name ?? (proposal.project_id ? "—" : "Preconstruction")}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary" className={`border ${statusStyles[statusKey]}`}>
                      {statusLabels[statusKey]}
                    </Badge>
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
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
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
      toast.success("Link copied", { description: text })
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
        toast.success("Link copied", { description: text })
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
      toast.success("Link copied", { description: text })
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
