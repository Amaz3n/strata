"use client"

import { useMemo, useState, useTransition, useEffect } from "react"
import { useRouter } from "next/navigation"

import type { Project } from "@/lib/types"
import type { CommitmentSummary } from "@/lib/services/commitments"
import { createCompanyCommitmentAction } from "@/app/(app)/companies/[id]/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/files/actions"

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function statusBadge(status?: string) {
  const normalized = (status ?? "draft").toLowerCase()
  if (normalized === "approved") return <Badge variant="secondary">Approved</Badge>
  if (normalized === "complete") return <Badge variant="outline">Complete</Badge>
  if (normalized === "canceled") return <Badge variant="destructive">Canceled</Badge>
  return <Badge variant="outline">Draft</Badge>
}

export function CompanyContractsTab({
  companyId,
  commitments,
  projects,
}: {
  companyId: string
  commitments: CommitmentSummary[]
  projects: Project[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [selectedCommitment, setSelectedCommitment] = useState<CommitmentSummary | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const [form, setForm] = useState({
    project_id: "none",
    title: "",
    total_dollars: "",
    status: "approved",
  })

  const totals = useMemo(() => {
    const committed = commitments.reduce((sum, c) => sum + (c.total_cents ?? 0), 0)
    const billed = commitments.reduce((sum, c) => sum + (c.billed_cents ?? 0), 0)
    return { committed, billed }
  }, [commitments])

  const submit = () => {
    if (form.project_id === "none") {
      toast({ title: "Project required", description: "Select a project for this contract." })
      return
    }
    if (!form.title.trim() || form.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a short contract title." })
      return
    }
    const totalDollars = Number(form.total_dollars)
    if (!Number.isFinite(totalDollars) || totalDollars < 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." })
      return
    }
    const totalCents = Math.round(totalDollars * 100)
    startTransition(async () => {
      try {
        await createCompanyCommitmentAction({
          project_id: form.project_id,
          company_id: companyId,
          title: form.title,
          total_cents: totalCents,
          status: form.status,
        })
        toast({ title: "Contract created" })
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to create contract", description: (error as Error).message })
      }
    })
  }

  useEffect(() => {
    if (!attachmentsOpen || !selectedCommitment) return
    setAttachmentsLoading(true)
    listAttachmentsAction("commitment", selectedCommitment.id)
      .then((links) =>
        setAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          }))
        )
      )
      .catch((error) => console.error("Failed to load commitment attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [attachmentsOpen, selectedCommitment])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!selectedCommitment) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", selectedCommitment.project_id)
      formData.append("category", "financials")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(
        uploaded.id,
        "commitment",
        selectedCommitment.id,
        selectedCommitment.project_id,
        linkRole
      )
    }

    const links = await listAttachmentsAction("commitment", selectedCommitment.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  const handleDetach = async (linkId: string) => {
    if (!selectedCommitment) return
    await detachFileLinkAction(linkId)
    const links = await listAttachmentsAction("commitment", selectedCommitment.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New contract</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>New contract</DialogTitle>
              <DialogDescription>Create a commitment for this vendor to track invoices against.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Project</Label>
                <Select value={form.project_id} onValueChange={(value) => setForm((p) => ({ ...p, project_id: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder="Plumbing rough-in" />
              </div>
              <div className="space-y-2">
                <Label>Contract total</Label>
                <Input
                  value={form.total_dollars}
                  onChange={(e) => setForm((p) => ({ ...p, total_dollars: e.target.value }))}
                  placeholder="10000"
                  inputMode="decimal"
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(value) => setForm((p) => ({ ...p, status: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="canceled">Canceled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={isPending} onClick={submit}>
                  {isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Project</TableHead>
              <TableHead className="px-4 py-3">Title</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="px-4 py-3 text-right">Total</TableHead>
              <TableHead className="px-4 py-3 text-right">Billed</TableHead>
              <TableHead className="px-4 py-3 text-right">Remaining</TableHead>
              <TableHead className="px-4 py-3 text-right">Attachments</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commitments.map((c) => {
              const total = c.total_cents ?? 0
              const billed = c.billed_cents ?? 0
              const remaining = Math.max(0, total - billed)
              return (
                <TableRow
                  key={c.id}
                  className="divide-x align-top hover:bg-muted/40 cursor-pointer"
                  onClick={() => router.push(`/projects/${c.project_id}`)}
                >
                  <TableCell className="text-sm px-4 py-3">{c.project_name ?? "—"}</TableCell>
                  <TableCell className="font-medium px-4 py-3">{c.title}</TableCell>
                  <TableCell className="px-4 py-3">{statusBadge(c.status)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(total)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(billed)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(remaining)}</TableCell>
                  <TableCell className="text-right px-4 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedCommitment(c)
                        setAttachmentsOpen(true)
                      }}
                    >
                      Files
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
            {commitments.length > 0 && (
              <TableRow className="divide-x bg-muted/40 font-medium">
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">Totals</TableCell>
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(totals.committed)}</TableCell>
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(totals.billed)}</TableCell>
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(Math.max(0, totals.committed - totals.billed))}</TableCell>
                <TableCell className="px-4 py-3" />
              </TableRow>
            )}
            {commitments.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                  No contracts yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={attachmentsOpen}
        onOpenChange={(nextOpen) => {
          setAttachmentsOpen(nextOpen)
          if (!nextOpen) {
            setSelectedCommitment(null)
            setAttachments([])
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedCommitment?.title ?? "Commitment files"}</DialogTitle>
            <DialogDescription>
              Attach contracts, invoices, and supporting documentation for this commitment.
            </DialogDescription>
          </DialogHeader>
          {selectedCommitment && (
            <EntityAttachments
              entityType="commitment"
              entityId={selectedCommitment.id}
              projectId={selectedCommitment.project_id}
              attachments={attachments}
              onAttach={handleAttach}
              onDetach={handleDetach}
              readOnly={attachmentsLoading}
              compact
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
