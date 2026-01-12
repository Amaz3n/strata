"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import type { Company } from "@/lib/types"
import type { CommitmentSummary, CommitmentLine } from "@/lib/services/commitments"
import { createProjectCommitmentAction, updateProjectCommitmentAction, listCommitmentLinesAction, createCommitmentLineAction, updateCommitmentLineAction, deleteCommitmentLineAction, listCostCodesAction } from "@/app/(app)/projects/[id]/commitments/actions"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { EntityAttachments, type AttachedFile } from "@/components/files"
import { useToast } from "@/hooks/use-toast"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/files/actions"
import type { CostCode } from "@/lib/types"

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

function CommitmentLineForm({
  commitmentId,
  line,
  costCodes,
  onSuccess,
  onCancel,
}: {
  commitmentId: string
  line?: CommitmentLine | null
  costCodes: CostCode[]
  onSuccess: () => void
  onCancel: () => void
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const [form, setForm] = useState(() => ({
    cost_code_id: line?.cost_code_id ?? "",
    description: line?.description ?? "",
    quantity: line?.quantity.toString() ?? "1",
    unit: line?.unit ?? "",
    unit_cost_dollars: ((line?.unit_cost_cents ?? 0) / 100).toFixed(2),
  }))

  const handleSubmit = () => {
    if (!form.cost_code_id) {
      toast({ title: "Cost code required", description: "Select a cost code." })
      return
    }
    if (!form.description.trim()) {
      toast({ title: "Description required", description: "Enter a description." })
      return
    }
    if (!form.unit.trim()) {
      toast({ title: "Unit required", description: "Enter a unit (e.g., SF, LF, EA)." })
      return
    }

    const quantity = Number(form.quantity)
    const unitCostCents = Math.round(Number(form.unit_cost_dollars) * 100)

    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast({ title: "Invalid quantity", description: "Enter a positive number." })
      return
    }
    if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
      toast({ title: "Invalid unit cost", description: "Enter a valid amount." })
      return
    }

    startTransition(async () => {
      try {
        if (line) {
          await updateCommitmentLineAction(line.id, {
            cost_code_id: form.cost_code_id,
            description: form.description.trim(),
            quantity,
            unit: form.unit.trim(),
            unit_cost_cents: unitCostCents,
          })
          toast({ title: "Updated", description: "Line item updated successfully." })
        } else {
          await createCommitmentLineAction(commitmentId, {
            cost_code_id: form.cost_code_id,
            description: form.description.trim(),
            quantity,
            unit: form.unit.trim(),
            unit_cost_cents: unitCostCents,
          })
          toast({ title: "Created", description: "Line item added successfully." })
        }
        onSuccess()
      } catch (error: any) {
        toast({
          title: "Error",
          description: error?.message ?? "Failed to save line item.",
          variant: "destructive"
        })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Cost Code</Label>
          <Select value={form.cost_code_id} onValueChange={(value) => setForm(prev => ({ ...prev, cost_code_id: value }))}>
            <SelectTrigger>
              <SelectValue placeholder="Select cost code" />
            </SelectTrigger>
            <SelectContent>
              {costCodes.map((code) => (
                <SelectItem key={code.id} value={code.id}>
                  {code.code} - {code.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Description</Label>
          <Input
            value={form.description}
            onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
            placeholder="Line item description"
          />
        </div>

        <div className="space-y-2">
          <Label>Quantity</Label>
          <Input
            type="number"
            step="0.01"
            value={form.quantity}
            onChange={(e) => setForm(prev => ({ ...prev, quantity: e.target.value }))}
            placeholder="1.00"
          />
        </div>

        <div className="space-y-2">
          <Label>Unit</Label>
          <Input
            value={form.unit}
            onChange={(e) => setForm(prev => ({ ...prev, unit: e.target.value }))}
            placeholder="SF, LF, EA, etc."
          />
        </div>

        <div className="space-y-2">
          <Label>Unit Cost ($)</Label>
          <Input
            type="number"
            step="0.01"
            value={form.unit_cost_dollars}
            onChange={(e) => setForm(prev => ({ ...prev, unit_cost_dollars: e.target.value }))}
            placeholder="0.00"
          />
        </div>

        <div className="space-y-2">
          <Label>Total</Label>
          <div className="flex items-center h-10 px-3 border rounded-md bg-muted">
            ${(Number(form.quantity) * Number(form.unit_cost_dollars)).toFixed(2)}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Saving..." : line ? "Update" : "Add"} Line
        </Button>
      </div>
    </div>
  )
}

type CommitmentFormState = {
  company_id: string
  title: string
  total_dollars: string
  status: string
}

export function ProjectCommitmentsClient({
  projectId,
  commitments,
  companies,
}: {
  projectId: string
  commitments: CommitmentSummary[]
  companies: Company[]
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])

  const [selectedCommitment, setSelectedCommitment] = useState<CommitmentSummary | null>(null)
  const [commitmentLines, setCommitmentLines] = useState<CommitmentLine[]>([])
  const [costCodes, setCostCodes] = useState<CostCode[]>([])
  const [linesLoading, setLinesLoading] = useState(false)
  const [createLineOpen, setCreateLineOpen] = useState(false)
  const [editLineOpen, setEditLineOpen] = useState(false)
  const [selectedLine, setSelectedLine] = useState<CommitmentLine | null>(null)

  const companyOptions = useMemo(() => {
    return [...(companies ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
  }, [companies])

  const [createForm, setCreateForm] = useState<CommitmentFormState>(() => ({
    company_id: companyOptions[0]?.id ?? "none",
    title: "",
    total_dollars: "",
    status: "approved",
  }))

  useEffect(() => {
    if (createForm.company_id === "none" && companyOptions[0]?.id) {
      setCreateForm((prev) => ({ ...prev, company_id: companyOptions[0].id }))
    }
  }, [companyOptions, createForm.company_id])

  const [editForm, setEditForm] = useState<CommitmentFormState>(() => ({
    company_id: "none",
    title: "",
    total_dollars: "",
    status: "draft",
  }))

  const totals = useMemo(() => {
    const committed = commitments.reduce((sum, c) => sum + (c.total_cents ?? 0), 0)
    const billed = commitments.reduce((sum, c) => sum + (c.billed_cents ?? 0), 0)
    return { committed, billed }
  }, [commitments])

  const loadCommitmentLines = async (commitmentId: string) => {
    setLinesLoading(true)
    try {
      const [lines, codes] = await Promise.all([
        listCommitmentLinesAction(commitmentId),
        costCodes.length === 0 ? listCostCodesAction() : Promise.resolve(costCodes)
      ])
      setCommitmentLines(lines)
      if (costCodes.length === 0) {
        setCostCodes(codes)
      }
    } catch (error) {
      console.error("Failed to load commitment lines:", error)
      toast({ title: "Error", description: "Failed to load commitment lines." })
    } finally {
      setLinesLoading(false)
    }
  }

  const submitCreate = () => {
    if (!createForm.company_id || createForm.company_id === "none") {
      toast({ title: "Company required", description: "Select a company for this commitment." })
      return
    }
    if (!createForm.title.trim() || createForm.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a short title." })
      return
    }
    const totalDollars = Number(createForm.total_dollars)
    if (!Number.isFinite(totalDollars) || totalDollars < 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." })
      return
    }
    const totalCents = Math.round(totalDollars * 100)

    startTransition(async () => {
      try {
        await createProjectCommitmentAction(projectId, {
          project_id: projectId,
          company_id: createForm.company_id,
          title: createForm.title,
          total_cents: totalCents,
          status: createForm.status,
        })
        toast({ title: "Commitment created" })
        setCreateOpen(false)
      } catch (error) {
        toast({ title: "Unable to create commitment", description: (error as Error).message })
      }
    })
  }

  const openEdit = (commitment: CommitmentSummary) => {
    setSelectedCommitment(commitment)
    setEditForm({
      company_id: commitment.company_id ?? "none",
      title: commitment.title ?? "",
      total_dollars: String(((commitment.total_cents ?? 0) / 100).toFixed(2)),
      status: String(commitment.status ?? "draft"),
    })
    setEditOpen(true)
  }

  const submitEdit = () => {
    if (!selectedCommitment) return
    if (!editForm.title.trim() || editForm.title.trim().length < 2) {
      toast({ title: "Title required", description: "Enter a short title." })
      return
    }
    const totalDollars = Number(editForm.total_dollars)
    if (!Number.isFinite(totalDollars) || totalDollars < 0) {
      toast({ title: "Invalid total", description: "Enter a valid amount." })
      return
    }
    const totalCents = Math.round(totalDollars * 100)

    startTransition(async () => {
      try {
        await updateProjectCommitmentAction(projectId, selectedCommitment.id, {
          title: editForm.title,
          status: editForm.status,
          total_cents: totalCents,
        })
        toast({ title: "Commitment updated" })
        setEditOpen(false)
        setSelectedCommitment(null)
      } catch (error) {
        toast({ title: "Unable to update commitment", description: (error as Error).message })
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
          })),
        ),
      )
      .catch((error) => console.error("Failed to load commitment attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [attachmentsOpen, selectedCommitment])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!selectedCommitment) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "financials")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "commitment", selectedCommitment.id, projectId, linkRole)
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
      })),
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
      })),
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">Commitments</p>
          <p className="text-xs text-muted-foreground">
            Track subcontracts/POs and what’s billed against them.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button disabled={companyOptions.length === 0}>New commitment</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create commitment</DialogTitle>
              <DialogDescription>Set a company, title, and total.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Company</Label>
                <Select value={createForm.company_id} onValueChange={(value) => setCreateForm((prev) => ({ ...prev, company_id: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companyOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={createForm.title} onChange={(e) => setCreateForm((prev) => ({ ...prev, title: e.target.value }))} placeholder="e.g., Plumbing subcontract" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Total ($)</Label>
                  <Input value={createForm.total_dollars} onChange={(e) => setCreateForm((prev) => ({ ...prev, total_dollars: e.target.value }))} inputMode="decimal" placeholder="0.00" />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={createForm.status} onValueChange={(value) => setCreateForm((prev) => ({ ...prev, status: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="complete">Complete</SelectItem>
                      <SelectItem value="canceled">Canceled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={isPending} onClick={submitCreate}>
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
              <TableHead className="px-4 py-3">Company</TableHead>
              <TableHead className="px-4 py-3">Title</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="px-4 py-3 text-right">Total</TableHead>
              <TableHead className="px-4 py-3 text-right">Billed</TableHead>
              <TableHead className="px-4 py-3 text-right">Remaining</TableHead>
              <TableHead className="w-40 px-4 py-3 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commitments.map((c) => {
              const total = c.total_cents ?? 0
              const billed = c.billed_cents ?? 0
              const remaining = Math.max(0, total - billed)
              return (
                <TableRow key={c.id} className="divide-x align-top hover:bg-muted/40">
                  <TableCell className="text-sm px-4 py-3">{c.company_name ?? "—"}</TableCell>
                  <TableCell className="font-medium px-4 py-3">{c.title}</TableCell>
                  <TableCell className="px-4 py-3">{statusBadge(c.status)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(total)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(billed)}</TableCell>
                  <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(remaining)}</TableCell>
                  <TableCell className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedCommitment(c)
                          setAttachmentsOpen(true)
                        }}
                      >
                        Files
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedCommitment(c)
                          loadCommitmentLines(c.id)
                        }}
                      >
                        Lines
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => openEdit(c)}>
                        Edit
                      </Button>
                    </div>
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
                  No commitments yet.
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
            <DialogDescription>Attach subcontract/PO docs and supporting files.</DialogDescription>
          </DialogHeader>
          {selectedCommitment && (
            <EntityAttachments
              entityType="commitment"
              entityId={selectedCommitment.id}
              projectId={projectId}
              attachments={attachments}
              onAttach={handleAttach}
              onDetach={handleDetach}
              readOnly={attachmentsLoading}
              compact
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Commitment Lines Dialog */}
      <Dialog
        open={selectedCommitment !== null && !attachmentsOpen && !editOpen && !createOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSelectedCommitment(null)
            setCommitmentLines([])
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{selectedCommitment?.title ?? "Commitment lines"}</DialogTitle>
            <DialogDescription>Manage line items with cost codes and quantities.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto">
            {linesLoading ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">Loading lines...</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-medium">Line Items</h3>
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelectedLine(null)
                      setCreateLineOpen(true)
                    }}
                  >
                    Add Line
                  </Button>
                </div>

                {commitmentLines.length === 0 ? (
                  <div className="text-center py-8 border-2 border-dashed rounded-lg">
                    <p className="text-muted-foreground">No line items yet.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        setSelectedLine(null)
                        setCreateLineOpen(true)
                      }}
                    >
                      Add First Line
                    </Button>
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Cost Code</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Unit</TableHead>
                          <TableHead className="text-right">Unit Cost</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead className="w-20"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {commitmentLines.map((line) => (
                          <TableRow key={line.id}>
                            <TableCell className="font-mono text-sm">
                              {line.cost_code_code ?? "—"}
                            </TableCell>
                            <TableCell>{line.description}</TableCell>
                            <TableCell className="text-right">{line.quantity}</TableCell>
                            <TableCell className="text-right">{line.unit}</TableCell>
                            <TableCell className="text-right">
                              ${(line.unit_cost_cents / 100).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              ${(line.total_cents / 100).toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setSelectedLine(line)
                                  setEditLineOpen(true)
                                }}
                              >
                                Edit
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/50 font-medium">
                          <TableCell colSpan={5} className="text-right">
                            Total:
                          </TableCell>
                          <TableCell className="text-right">
                            ${(commitmentLines.reduce((sum, line) => sum + line.total_cents, 0) / 100).toFixed(2)}
                          </TableCell>
                          <TableCell></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Line Dialog */}
      <Dialog open={createLineOpen || editLineOpen} onOpenChange={(open) => {
        if (!open) {
          setCreateLineOpen(false)
          setEditLineOpen(false)
          setSelectedLine(null)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editLineOpen ? "Edit" : "Add"} Line Item</DialogTitle>
            <DialogDescription>
              {editLineOpen ? "Update the line item details." : "Add a new line item to this commitment."}
            </DialogDescription>
          </DialogHeader>

          <CommitmentLineForm
            commitmentId={selectedCommitment?.id ?? ""}
            line={selectedLine}
            costCodes={costCodes}
            onSuccess={() => {
              setCreateLineOpen(false)
              setEditLineOpen(false)
              setSelectedLine(null)
              if (selectedCommitment) {
                loadCommitmentLines(selectedCommitment.id)
              }
            }}
            onCancel={() => {
              setCreateLineOpen(false)
              setEditLineOpen(false)
              setSelectedLine(null)
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(nextOpen) => {
          setEditOpen(nextOpen)
          if (!nextOpen) setSelectedCommitment(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit commitment</DialogTitle>
            <DialogDescription>Update title, total, and status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={editForm.title} onChange={(e) => setEditForm((prev) => ({ ...prev, title: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Total ($)</Label>
                <Input value={editForm.total_dollars} onChange={(e) => setEditForm((prev) => ({ ...prev, total_dollars: e.target.value }))} inputMode="decimal" />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editForm.status} onValueChange={(value) => setEditForm((prev) => ({ ...prev, status: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="canceled">Canceled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button disabled={isPending} onClick={submitEdit}>
                {isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

