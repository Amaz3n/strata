"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Proposal, Project } from "@/lib/types"
import type { ProposalInput } from "@/lib/validation/proposals"
import { createProposalAction, sendProposalAction, generateProposalLinkAction } from "@/app/proposals/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Mail, Copy } from "@/components/icons"
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
  proposals: Array<Proposal & { project_name?: string | null }>
  projects: Project[]
}

export function ProposalsClient({ proposals, projects }: ProposalsClientProps) {
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
      const matchesProject = projectFilter === "all" || p.project_id === projectFilter
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
              {projects.map((project) => (
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

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((proposal) => {
              const statusKey = resolveStatus(proposal.status)
              return (
                <TableRow key={proposal.id}>
                  <TableCell className="font-medium">{proposal.number ?? "—"}</TableCell>
                  <TableCell>{proposal.title}</TableCell>
                  <TableCell className="text-muted-foreground">{proposal.project_name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusStyles[statusKey]}>
                      {statusLabels[statusKey]}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {formatCurrency(proposal.total_cents)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {proposal.valid_until ? format(new Date(proposal.valid_until), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {proposal.sent_at ? format(new Date(proposal.sent_at), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
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
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No proposals yet.
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
    await navigator.clipboard.writeText(text)
    toast.success("Link copied", { description: text })
  } else {
    toast.success("Copy this link", { description: text })
  }
}
