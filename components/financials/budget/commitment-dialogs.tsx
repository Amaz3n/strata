"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus, Trash2 } from "lucide-react"

import type { Company, CostCode } from "@/lib/types"
import type { CommitmentSummary, CommitmentLine } from "@/lib/services/commitments"
import type { CommitmentChangeOrderSummary } from "@/lib/services/commitment-change-orders"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"

import { listBudgetCompaniesAction } from "@/app/(app)/projects/[id]/financials/budget/actions"
import {
  approveCommitmentChangeOrderAction,
  createCommitmentChangeOrderAction,
  createCommitmentLineAction,
  createProjectCommitmentAction,
  deleteCommitmentLineAction,
  listCommitmentChangeOrdersAction,
  listCommitmentLinesAction,
  listCostCodesAction,
  updateCommitmentLineAction,
  updateProjectCommitmentAction,
  voidCommitmentChangeOrderAction,
} from "@/app/(app)/projects/[id]/commitments/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CostCodeSelectItems } from "@/components/cost-codes/cost-code-select-items"

import {
  CommitmentStatusBadge,
  dollarsToCents,
  formatCurrency,
  type CommitmentCreateDraft,
} from "./shared"

export function CommitmentCreateDialog({
  open,
  onOpenChange,
  projectId,
  costCodes,
  costCodesEnabled,
  draft,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  costCodes: CostCode[]
  costCodesEnabled: boolean
  draft: CommitmentCreateDraft | null
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Vendors load when the dialog opens — the org directory can be large, so it
  // never ships with the page payload.
  const [companies, setCompanies] = useState<Company[]>([])
  const [companiesLoading, setCompaniesLoading] = useState(false)

  const [companyId, setCompanyId] = useState<string>("")
  const [costCodeId, setCostCodeId] = useState("")
  const [title, setTitle] = useState("")
  const [scope, setScope] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [status, setStatus] = useState("draft")
  const [contractNumber, setContractNumber] = useState("")
  const [retainagePercent, setRetainagePercent] = useState("")
  const [terms, setTerms] = useState("")

  useEffect(() => {
    if (!open) return
    // No default company or cost code: mis-coded commitments are worse than one
    // extra click, so both stay unselected until the user chooses.
    setCompanyId("")
    setCostCodeId(costCodesEnabled ? draft?.costCodeId ?? "" : "")
    setTitle("")
    setScope(draft?.defaultScope ?? "")
    setAmountDollars(draft?.defaultAmountDollars ?? "")
    setStatus("draft")
    setContractNumber("")
    setRetainagePercent("")
    setTerms("")

    let cancelled = false
    setCompaniesLoading(true)
    listBudgetCompaniesAction()
      .then((rows) => {
        if (!cancelled) setCompanies([...rows].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")))
      })
      .catch((error) => {
        if (!cancelled) toast({ title: "Couldn't load companies", description: (error as Error).message })
      })
      .finally(() => {
        if (!cancelled) setCompaniesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, costCodesEnabled, draft, toast])

  const submit = () => {
    if (!companyId) {
      toast({ title: "Company required" })
      return
    }
    if (costCodesEnabled && !costCodeId) {
      toast({ title: "Cost code required" })
      return
    }
    if (title.trim().length < 2) {
      toast({ title: "Title required" })
      return
    }
    const n = Number(amountDollars)
    if (!Number.isFinite(n) || n <= 0) {
      toast({ title: "Invalid amount" })
      return
    }
    if (!scope.trim()) {
      toast({ title: "Scope required" })
      return
    }
    const retainage = retainagePercent.trim() ? Number(retainagePercent) : null
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage" })
      return
    }

    startTransition(async () => {
      try {
        const commitment = unwrapAction(await createProjectCommitmentAction(projectId, {
          project_id: projectId,
          company_id: companyId,
          title: title.trim(),
          total_cents: Math.round(n * 100),
          status,
          contract_number: contractNumber.trim() || null,
          retainage_percent: retainage,
          scope: scope.trim(),
          terms: terms.trim() || null,
        }))
        unwrapAction(await createCommitmentLineAction(commitment.id, {
          cost_code_id: costCodesEnabled ? costCodeId : null,
          budget_line_id: costCodesEnabled ? null : draft?.budgetLineId ?? null,
          description: scope.trim(),
          quantity: 1,
          unit: "LS",
          unit_cost_cents: Math.round(n * 100),
        }))
        toast({ title: "Commitment created" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to create commitment",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New commitment</DialogTitle>
          <DialogDescription>
            Create a subcontract or PO and allocate it to this project budget.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder={companiesLoading ? "Loading companies…" : "Select company"} />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {costCodesEnabled ? (
              <div className="space-y-1.5">
                <Label>Cost code</Label>
                <Select value={costCodeId} onValueChange={setCostCodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    <CostCodeSelectItems costCodes={costCodes} />
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Plumbing subcontract"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Commitment #</Label>
              <Input
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                placeholder="e.g., SUB-004"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Retainage (%)</Label>
              <Input
                value={retainagePercent}
                onChange={(e) => setRetainagePercent(e.target.value)}
                inputMode="decimal"
                placeholder="10"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Allocated scope</Label>
            <Textarea
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="e.g., Rough plumbing labor and trim"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Terms</Label>
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Billing terms, insurance, lien waivers, schedule"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Initial commitment amount ($)</Label>
              <Input
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
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
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={submit}>
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CommitmentEditDialog({
  commitment,
  onClose,
  projectId,
}: {
  commitment: CommitmentSummary | null
  onClose: () => void
  projectId: string
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState("")
  const [totalDollars, setTotalDollars] = useState("")
  const [status, setStatus] = useState("draft")
  const [contractNumber, setContractNumber] = useState("")
  const [retainagePercent, setRetainagePercent] = useState("")
  const [scope, setScope] = useState("")
  const [terms, setTerms] = useState("")

  useEffect(() => {
    if (commitment) {
      setTitle(commitment.title ?? "")
      setTotalDollars(((commitment.total_cents ?? 0) / 100).toFixed(2))
      setStatus(String(commitment.status ?? "draft"))
      setContractNumber(commitment.contract_number ?? "")
      setRetainagePercent(commitment.retainage_percent != null ? String(commitment.retainage_percent) : "")
      setScope(commitment.scope ?? "")
      setTerms(commitment.terms ?? "")
    }
  }, [commitment])

  const submit = () => {
    if (!commitment) return
    if (title.trim().length < 2) {
      toast({ title: "Title required" })
      return
    }
    const n = Number(totalDollars)
    if (!Number.isFinite(n) || n < 0) {
      toast({ title: "Invalid total" })
      return
    }
    const retainage = retainagePercent.trim() ? Number(retainagePercent) : null
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage" })
      return
    }

    startTransition(async () => {
      try {
        unwrapAction(await updateProjectCommitmentAction(projectId, commitment.id, {
          title: title.trim(),
          status,
          total_cents: Math.round(n * 100),
          contract_number: contractNumber.trim() || null,
          retainage_percent: retainage,
          scope: scope.trim() || null,
          terms: terms.trim() || null,
        }))
        toast({ title: "Commitment updated" })
        onClose()
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to update commitment",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit commitment</DialogTitle>
          <DialogDescription>Update amount, status, scope, and commercial terms.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Commitment #</Label>
              <Input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Retainage (%)</Label>
              <Input
                value={retainagePercent}
                onChange={(e) => setRetainagePercent(e.target.value)}
                inputMode="decimal"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Total ($)</Label>
              <Input
                value={totalDollars}
                onChange={(e) => setTotalDollars(e.target.value)}
                inputMode="decimal"
              />
              <p className="text-xs text-muted-foreground">
                Once allocation lines exist, this total follows the line total.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
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
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label>Terms</Label>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={submit}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CommitmentLinesDialog({
  commitment,
  projectId,
  onClose,
  costCodesEnabled,
  defaultBudgetLineId,
}: {
  commitment: CommitmentSummary | null
  projectId: string
  onClose: () => void
  costCodesEnabled: boolean
  defaultBudgetLineId?: string | null
}) {
  const { toast } = useToast()
  const [lines, setLines] = useState<CommitmentLine[]>([])
  const [changeOrders, setChangeOrders] = useState<CommitmentChangeOrderSummary[]>([])
  const [codes, setCodes] = useState<CostCode[]>([])
  const [loading, setLoading] = useState(false)
  const [changeOrdersLoading, setChangeOrdersLoading] = useState(false)
  const [editingLine, setEditingLine] = useState<CommitmentLine | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingChangeOrder, setCreatingChangeOrder] = useState(false)
  const [signatureChangeOrder, setSignatureChangeOrder] = useState<CommitmentChangeOrderSummary | null>(null)

  useEffect(() => {
    if (!commitment) {
      setLines([])
      setChangeOrders([])
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([listCommitmentLinesAction(commitment.id), costCodesEnabled ? listCostCodesAction() : Promise.resolve([])])
      .then(([l, c]) => {
        if (cancelled) return
        setLines(l)
        setCodes(c)
      })
      .catch((error) => {
        if (!cancelled) {
          toast({ title: "Unable to load lines", description: (error as Error).message })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commitment, costCodesEnabled, toast])

  const reload = async () => {
    if (!commitment) return
    const l = await listCommitmentLinesAction(commitment.id)
    setLines(l)
  }

  const reloadChangeOrders = async () => {
    if (!commitment) return
    setChangeOrdersLoading(true)
    try {
      setChangeOrders(await listCommitmentChangeOrdersAction(commitment.id))
    } finally {
      setChangeOrdersLoading(false)
    }
  }

  useEffect(() => {
    if (!commitment) return
    void reloadChangeOrders().catch((error) => {
      toast({ title: "Unable to load commitment change orders", description: (error as Error).message })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitment?.id])

  const totalCents = lines.reduce((s, l) => s + (l.total_cents ?? 0), 0)
  const approvedChangeOrdersCents = changeOrders
    .filter((changeOrder) => changeOrder.status === "approved")
    .reduce((sum, changeOrder) => sum + changeOrder.total_cents, 0)

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{commitment?.title ?? "Commitment lines"}</DialogTitle>
          <DialogDescription>
            Line items with quantities and unit costs.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground tabular-nums">
              {lines.length} {lines.length === 1 ? "line" : "lines"} · Total{" "}
              {formatCurrency(totalCents)}
            </p>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Add line
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>
          ) : lines.length === 0 ? (
            <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
              No line items yet.
            </div>
          ) : (
            <div className="overflow-hidden border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    {costCodesEnabled ? <TableHead className="px-3">Cost code</TableHead> : null}
                    <TableHead className="px-3">Description</TableHead>
                    <TableHead className="px-3 text-right">Qty</TableHead>
                    <TableHead className="px-3">Unit</TableHead>
                    <TableHead className="px-3 text-right">Unit cost</TableHead>
                    <TableHead className="px-3 text-right">Total</TableHead>
                    <TableHead className="w-20 px-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.id}>
                      {costCodesEnabled ? (
                        <TableCell className="px-3 font-mono text-xs">
                          {line.cost_code_code ?? "—"}
                        </TableCell>
                      ) : null}
                      <TableCell className="px-3">{line.description}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">
                        {line.quantity}
                      </TableCell>
                      <TableCell className="px-3">{line.unit}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">
                        {formatCurrency(line.unit_cost_cents)}
                      </TableCell>
                      <TableCell className="px-3 text-right font-medium tabular-nums">
                        {formatCurrency(line.total_cents)}
                      </TableCell>
                      <TableCell className="px-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setEditingLine(line)}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/30 font-medium">
                    <TableCell colSpan={costCodesEnabled ? 5 : 4} className="px-3 text-right text-xs uppercase tracking-wide text-muted-foreground">
                      Total
                    </TableCell>
                    <TableCell className="px-3 text-right tabular-nums">
                      {formatCurrency(totalCents)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">Commitment change orders</h4>
                <p className="text-xs text-muted-foreground">
                  Approved CCOs revise the commitment total without overwriting the original contract.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreatingChangeOrder(true)}
                disabled={lines.length === 0}
              >
                <Plus className="h-4 w-4" />
                New CCO
              </Button>
            </div>
            <div className="border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Original {formatCurrency(commitment?.total_cents ?? totalCents)}</span>
                <span>Approved CCOs {formatCurrency(approvedChangeOrdersCents)}</span>
                <span className="font-medium text-foreground">
                  Revised {formatCurrency((commitment?.total_cents ?? totalCents) + approvedChangeOrdersCents)}
                </span>
              </div>
            </div>
            {changeOrdersLoading ? (
              <div className="border border-dashed py-6 text-center text-sm text-muted-foreground">
                Loading CCOs...
              </div>
            ) : changeOrders.length === 0 ? (
              <div className="border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No commitment change orders yet.
              </div>
            ) : (
              <div className="overflow-hidden border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="px-3">Title</TableHead>
                      <TableHead className="px-3">Status</TableHead>
                      <TableHead className="px-3 text-right">Amount</TableHead>
                      <TableHead className="w-44 px-3 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changeOrders.map((changeOrder) => (
                      <TableRow key={changeOrder.id}>
                        <TableCell className="px-3">
                          <span className="block text-sm font-medium">{changeOrder.title}</span>
                          {changeOrder.source_change_order_title ? (
                            <span className="block text-xs text-muted-foreground">
                              From {changeOrder.source_change_order_title}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="px-3">
                          <CommitmentStatusBadge status={changeOrder.status} />
                        </TableCell>
                        <TableCell className="px-3 text-right font-medium tabular-nums">
                          {changeOrder.total_cents > 0 ? "+" : ""}
                          {formatCurrency(changeOrder.total_cents)}
                        </TableCell>
                        <TableCell className="px-3 text-right">
                          <div className="flex justify-end gap-1">
                            {changeOrder.status !== "approved" && changeOrder.status !== "voided" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={async () => {
                                  try {
                                    unwrapAction(await approveCommitmentChangeOrderAction(projectId, changeOrder.id))
                                    await reloadChangeOrders()
                                    toast({ title: "CCO approved" })
                                  } catch (error) {
                                    toast({ title: "Unable to approve CCO", description: (error as Error).message })
                                  }
                                }}
                              >
                                Approve
                              </Button>
                            ) : null}
                            {changeOrder.status !== "voided" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSignatureChangeOrder(changeOrder)}
                              >
                                Sign
                              </Button>
                            ) : null}
                            {changeOrder.status !== "voided" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-destructive"
                                onClick={async () => {
                                  try {
                                    unwrapAction(await voidCommitmentChangeOrderAction(projectId, changeOrder.id))
                                    await reloadChangeOrders()
                                    toast({ title: "CCO voided" })
                                  } catch (error) {
                                    toast({ title: "Unable to void CCO", description: (error as Error).message })
                                  }
                                }}
                              >
                                Void
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <CommitmentLineDialog
          open={creating || editingLine !== null}
          onOpenChange={(o) => {
            if (!o) {
              setCreating(false)
              setEditingLine(null)
            }
          }}
          commitmentId={commitment?.id ?? ""}
          line={editingLine}
          costCodes={codes}
          costCodesEnabled={costCodesEnabled}
          defaultBudgetLineId={defaultBudgetLineId}
          onSaved={async () => {
            setCreating(false)
            setEditingLine(null)
            await reload()
          }}
        />
        <CommitmentChangeOrderCreateDialog
          open={creatingChangeOrder}
          onOpenChange={setCreatingChangeOrder}
          projectId={projectId}
          commitment={commitment}
          lines={lines}
          onSaved={async () => {
            setCreatingChangeOrder(false)
            await reloadChangeOrders()
          }}
        />
        <EnvelopeWizard
          open={signatureChangeOrder !== null}
          onOpenChange={(open) => {
            if (!open) setSignatureChangeOrder(null)
          }}
          sourceEntity={
            signatureChangeOrder
              ? ({
                  type: "subcontract_change_order",
                  id: signatureChangeOrder.id,
                  project_id: signatureChangeOrder.project_id,
                  title: signatureChangeOrder.title,
                  document_type: "contract",
                } satisfies EnvelopeWizardSourceEntity)
              : null
          }
          sourceLabel="Commitment change order"
          sheetTitle="Send commitment change order for signature"
          sheetDescription="Upload the subcontract change order and send it for execution."
          onEnvelopeSent={async () => {
            setSignatureChangeOrder(null)
            await reloadChangeOrders()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function CommitmentLineDialog({
  open,
  onOpenChange,
  commitmentId,
  line,
  costCodes,
  costCodesEnabled,
  defaultBudgetLineId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commitmentId: string
  line: CommitmentLine | null
  costCodes: CostCode[]
  costCodesEnabled: boolean
  defaultBudgetLineId?: string | null
  onSaved: () => void
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [costCodeId, setCostCodeId] = useState("")
  const [description, setDescription] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [unit, setUnit] = useState("")
  const [unitCost, setUnitCost] = useState("0.00")

  useEffect(() => {
    if (open) {
      setCostCodeId(line?.cost_code_id ?? "")
      setDescription(line?.description ?? "")
      setQuantity(line?.quantity?.toString() ?? "1")
      setUnit(line?.unit ?? "")
      setUnitCost(((line?.unit_cost_cents ?? 0) / 100).toFixed(2))
    }
  }, [open, line])

  const total = (Number(quantity) || 0) * (Number(unitCost) || 0)

  const submit = () => {
    if (costCodesEnabled && !costCodeId) {
      toast({ title: "Cost code required" })
      return
    }
    if (!description.trim()) {
      toast({ title: "Description required" })
      return
    }
    if (!unit.trim()) {
      toast({ title: "Unit required" })
      return
    }
    const qty = Number(quantity)
    const cost = Math.round(Number(unitCost) * 100)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast({ title: "Invalid quantity" })
      return
    }
    if (!Number.isFinite(cost) || cost < 0) {
      toast({ title: "Invalid unit cost" })
      return
    }

    startTransition(async () => {
      try {
        const payload = {
          cost_code_id: costCodesEnabled ? costCodeId : null,
          budget_line_id: costCodesEnabled ? null : line?.budget_line_id ?? defaultBudgetLineId ?? null,
          description: description.trim(),
          quantity: qty,
          unit: unit.trim(),
          unit_cost_cents: cost,
        }
        if (line) {
          unwrapAction(await updateCommitmentLineAction(line.id, payload))
        } else {
          unwrapAction(await createCommitmentLineAction(commitmentId, payload))
        }
        onSaved()
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to save line",
          description: (error as Error).message,
        })
      }
    })
  }

  const remove = () => {
    if (!line) return
    startTransition(async () => {
      try {
        unwrapAction(await deleteCommitmentLineAction(line.id))
        onSaved()
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to remove line",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{line ? "Edit line" : "Add line"}</DialogTitle>
          <DialogDescription>
            {line ? "Update the line details." : "Add a new line to this commitment."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {costCodesEnabled ? (
            <div className="col-span-2 space-y-1.5">
              <Label>Cost code</Label>
              <Select value={costCodeId} onValueChange={setCostCodeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select cost code" />
                </SelectTrigger>
                <SelectContent>
                  <CostCodeSelectItems costCodes={costCodes} />
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="col-span-2 space-y-1.5">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Line item description"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Quantity</Label>
            <Input
              type="number"
              step="0.01"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="SF, LF, EA..."
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit cost ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Total</Label>
            <div className="flex h-9 items-center border bg-muted px-3 text-sm tabular-nums">
              ${total.toFixed(2)}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between pt-2">
          <div>
            {line && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={remove}
                disabled={isPending}
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={isPending}>
              {isPending ? "Saving..." : line ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CommitmentChangeOrderCreateDialog({
  open,
  onOpenChange,
  projectId,
  commitment,
  lines,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  commitment: CommitmentSummary | null
  lines: CommitmentLine[]
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [lineId, setLineId] = useState("")
  const [amount, setAmount] = useState("0.00")

  useEffect(() => {
    if (!open) return
    const firstLine = lines[0]
    setLineId(firstLine?.id ?? "")
    setTitle(firstLine ? `${firstLine.description} change` : "Commitment change order")
    setDescription("")
    setAmount("0.00")
  }, [open, lines])

  const selectedLine = lines.find((line) => line.id === lineId) ?? lines[0] ?? null
  const amountCents = dollarsToCents(amount)

  const submit = () => {
    if (!commitment || !selectedLine) return
    if (!title.trim()) {
      toast({ title: "Title required" })
      return
    }
    if (amountCents == null || amountCents === 0) {
      toast({ title: "Enter a non-zero change amount" })
      return
    }

    startTransition(async () => {
      try {
        unwrapAction(await createCommitmentChangeOrderAction(projectId, {
          commitment_id: commitment.id,
          title: title.trim(),
          description: description.trim() || null,
          lines: [
            {
              commitment_line_id: selectedLine.id,
              cost_code_id: selectedLine.cost_code_id ?? null,
              budget_line_id: selectedLine.budget_line_id ?? null,
              description: description.trim() || title.trim(),
              quantity: 1,
              unit: "ls",
              unit_cost_cents: amountCents,
              sort_order: 0,
            },
          ],
        }))
        toast({ title: "CCO created" })
        onSaved()
      } catch (error) {
        toast({ title: "Unable to create CCO", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New commitment change order</DialogTitle>
          <DialogDescription>
            Create a draft subcontract revision tied to one commitment line.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Line</Label>
            <Select value={lineId} onValueChange={setLineId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a commitment line" />
              </SelectTrigger>
              <SelectContent>
                {lines.map((line) => (
                  <SelectItem key={line.id} value={line.id}>
                    {line.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Change amount</Label>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use a negative amount for deductive changes.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !selectedLine}>
            Create CCO
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CommitmentFilesDialog({
  commitment,
  projectId,
  onClose,
}: {
  commitment: CommitmentSummary | null
  projectId: string
  onClose: () => void
}) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    if (!commitment) return
    const links = await listAttachmentsAction("commitment", commitment.id)
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

  useEffect(() => {
    if (!commitment) {
      setAttachments([])
      return
    }
    setLoading(true)
    refresh().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitment])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!commitment) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "financials")
      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(await attachFileAction(uploaded.id, "commitment", commitment.id, projectId, linkRole))
    }
    await refresh()
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    await refresh()
  }

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{commitment?.title ?? "Commitment files"}</DialogTitle>
          <DialogDescription>Subcontract documents and supporting files.</DialogDescription>
        </DialogHeader>
        {commitment && (
          <EntityAttachments
            entityType="commitment"
            entityId={commitment.id}
            projectId={projectId}
            attachments={attachments}
            onAttach={handleAttach}
            onDetach={handleDetach}
            readOnly={loading}
            compact
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
