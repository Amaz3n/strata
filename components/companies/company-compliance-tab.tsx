"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"

import type {
  Company,
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceStatusSummary,
} from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  getCompanyComplianceStatusAction,
  listComplianceDocumentTypesAction,
  reviewComplianceDocumentAction,
  setCompanyRequirementsAction,
} from "@/app/(app)/companies/actions"
import { useToast } from "@/hooks/use-toast"
import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, Settings, XCircle } from "@/components/icons"
import { cn } from "@/lib/utils"

function formatDate(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString()
}

function formatMoney(cents?: number | null) {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

interface RequirementsEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  companyName?: string
  documentTypes: ComplianceDocumentType[]
  currentRequirements: ComplianceRequirement[]
  onSaved: () => void
}

function RequirementsEditor({
  open,
  onOpenChange,
  companyId,
  companyName,
  documentTypes,
  currentRequirements,
  onSaved,
}: RequirementsEditorProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [minCoverage, setMinCoverage] = useState<Record<string, string>>({})
  const [requiresAdditionalInsured, setRequiresAdditionalInsured] = useState<Record<string, boolean>>({})
  const [requiresPrimaryNonContributory, setRequiresPrimaryNonContributory] = useState<Record<string, boolean>>({})
  const [requiresWaiverOfSubrogation, setRequiresWaiverOfSubrogation] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (open) {
      const sel: Record<string, boolean> = {}
      const n: Record<string, string> = {}
      const cov: Record<string, string> = {}
      const ai: Record<string, boolean> = {}
      const pnc: Record<string, boolean> = {}
      const wos: Record<string, boolean> = {}
      for (const req of currentRequirements) {
        sel[req.document_type_id] = true
        if (req.notes) n[req.document_type_id] = req.notes
        if (req.min_coverage_cents)
          cov[req.document_type_id] = (req.min_coverage_cents / 100).toString()
        ai[req.document_type_id] = Boolean(req.requires_additional_insured)
        pnc[req.document_type_id] = Boolean(req.requires_primary_noncontributory)
        wos[req.document_type_id] = Boolean(req.requires_waiver_of_subrogation)
      }
      setSelected(sel)
      setNotes(n)
      setMinCoverage(cov)
      setRequiresAdditionalInsured(ai)
      setRequiresPrimaryNonContributory(pnc)
      setRequiresWaiverOfSubrogation(wos)
    }
  }, [open, currentRequirements])

  const handleSave = () => {
    startTransition(async () => {
      try {
        const requirements = documentTypes
          .filter((dt) => selected[dt.id])
          .map((dt) => ({
            document_type_id: dt.id,
            is_required: true,
            min_coverage_cents: minCoverage[dt.id]
              ? Math.round(Number.parseFloat(minCoverage[dt.id]) * 100)
              : undefined,
            requires_additional_insured: requiresAdditionalInsured[dt.id] ?? false,
            requires_primary_noncontributory: requiresPrimaryNonContributory[dt.id] ?? false,
            requires_waiver_of_subrogation: requiresWaiverOfSubrogation[dt.id] ?? false,
            notes: notes[dt.id] || undefined,
          }))
        await setCompanyRequirementsAction(companyId, requirements)
        toast({ title: "Requirements updated" })
        onSaved()
        onOpenChange(false)
      } catch (error) {
        toast({
          title: "Failed to update requirements",
          description: (error as Error).message,
        })
      }
    })
  }

  const selectedCount = documentTypes.filter((dt) => selected[dt.id]).length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>Compliance requirements</SheetTitle>
          <SheetDescription>
            Choose the documents {companyName || "this company"} must provide
            before working.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y">
            {documentTypes.map((dt) => {
              const isSelected = selected[dt.id] || false
              const isInsurance =
                dt.code.includes("coi") ||
                dt.code.includes("insurance") ||
                dt.code.includes("umbrella")
              return (
                <div
                  key={dt.id}
                  className={cn(
                    "px-4 py-3 transition-colors",
                    isSelected && "bg-muted/30",
                  )}
                >
                  <label className="flex cursor-pointer items-start gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => ({ ...prev, [dt.id]: !!checked }))
                      }
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {dt.name}
                        </span>
                        {dt.has_expiry && (
                          <Badge variant="outline" className="text-[10px]">
                            Expires
                          </Badge>
                        )}
                      </div>
                      {dt.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {dt.description}
                        </p>
                      )}
                    </div>
                  </label>

                  {isSelected && (
                    <div className="ml-7 mt-3 space-y-3 border-l-2 border-border pl-4">
                      {isInsurance && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">
                              Minimum coverage
                            </Label>
                            <div className="relative w-44">
                              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                $
                              </span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                placeholder="1,000,000"
                                className="h-9 pl-7"
                                value={minCoverage[dt.id] || ""}
                                onChange={(e) =>
                                  setMinCoverage((prev) => ({
                                    ...prev,
                                    [dt.id]: e.target.value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">
                              Required endorsements
                            </Label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={requiresAdditionalInsured[dt.id] || false}
                                onCheckedChange={(checked) =>
                                  setRequiresAdditionalInsured((prev) => ({
                                    ...prev,
                                    [dt.id]: checked === true,
                                  }))
                                }
                              />
                              <span>Additional insured</span>
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={
                                  requiresPrimaryNonContributory[dt.id] || false
                                }
                                onCheckedChange={(checked) =>
                                  setRequiresPrimaryNonContributory((prev) => ({
                                    ...prev,
                                    [dt.id]: checked === true,
                                  }))
                                }
                              />
                              <span>Primary &amp; non-contributory</span>
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={
                                  requiresWaiverOfSubrogation[dt.id] || false
                                }
                                onCheckedChange={(checked) =>
                                  setRequiresWaiverOfSubrogation((prev) => ({
                                    ...prev,
                                    [dt.id]: checked === true,
                                  }))
                                }
                              />
                              <span>Waiver of subrogation</span>
                            </label>
                          </div>
                        </>
                      )}
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Notes
                        </Label>
                        <Textarea
                          rows={2}
                          placeholder="e.g. Must list us as additional insured"
                          className="text-sm"
                          value={notes[dt.id] || ""}
                          onChange={(e) =>
                            setNotes((prev) => ({
                              ...prev,
                              [dt.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t">
          <span className="text-xs text-muted-foreground">
            {selectedCount} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

interface ReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: ComplianceDocument | null
  onReviewed: () => void
}

function ReviewDialog({ open, onOpenChange, document, onReviewed }: ReviewDialogProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [decision, setDecision] = useState<"approved" | "rejected">("approved")
  const [notes, setNotes] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")

  useEffect(() => {
    if (open) {
      setDecision("approved")
      setNotes("")
      setRejectionReason("")
    }
  }, [open])

  const handleSubmit = () => {
    if (!document) return
    startTransition(async () => {
      try {
        await reviewComplianceDocumentAction(document.id, {
          decision,
          notes: notes || undefined,
          rejection_reason: decision === "rejected" ? rejectionReason || undefined : undefined,
        })
        toast({
          title: decision === "approved" ? "Document approved" : "Document rejected",
        })
        onReviewed()
        onOpenChange(false)
      } catch (error) {
        toast({
          title: "Review failed",
          description: (error as Error).message,
        })
      }
    })
  }

  if (!document) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review Document</DialogTitle>
          <DialogDescription>
            {document.document_type?.name}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            {document.expiry_date && (
              <div>
                <Label className="text-muted-foreground">Expiry Date</Label>
                <p>{formatDate(document.expiry_date)}</p>
              </div>
            )}
            {document.policy_number && (
              <div>
                <Label className="text-muted-foreground">Policy #</Label>
                <p>{document.policy_number}</p>
              </div>
            )}
            {document.carrier_name && (
              <div>
                <Label className="text-muted-foreground">Carrier</Label>
                <p>{document.carrier_name}</p>
              </div>
            )}
            {document.coverage_amount_cents && (
              <div>
                <Label className="text-muted-foreground">Coverage</Label>
                <p>{formatMoney(document.coverage_amount_cents)}</p>
              </div>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Decision</Label>
            <Select
              value={decision}
              onValueChange={(v) => setDecision(v as "approved" | "rejected")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve</SelectItem>
                <SelectItem value="rejected">Reject</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {decision === "rejected" && (
            <div className="space-y-2">
              <Label>Rejection Reason</Label>
              <Textarea
                placeholder="Explain why this document was rejected..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>Review Notes (optional)</Label>
            <Input
              placeholder="Internal notes about this review"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending}
            variant={decision === "rejected" ? "destructive" : "default"}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {decision === "approved" ? "Approve" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ReqState = "ok" | "pending" | "expired" | "missing"

function ReqStatePill({ state }: { state: ReqState }) {
  const map: Record<ReqState, { label: string; icon: React.ReactNode; className: string }> = {
    ok: {
      label: "On file",
      icon: <CheckCircle2 className="h-3 w-3" />,
      className:
        "border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    },
    pending: {
      label: "Pending review",
      icon: <Clock className="h-3 w-3" />,
      className:
        "border-amber-600/30 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    },
    expired: {
      label: "Expired",
      icon: <AlertCircle className="h-3 w-3" />,
      className:
        "border-orange-600/30 bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
    },
    missing: {
      label: "Missing",
      icon: <XCircle className="h-3 w-3" />,
      className: "border-border bg-muted text-muted-foreground",
    },
  }
  const { label, icon, className } = map[state]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {icon}
      {label}
    </span>
  )
}

export function CompanyComplianceTab({ company }: { company: Company }) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<ComplianceStatusSummary | null>(null)
  const [documentTypes, setDocumentTypes] = useState<ComplianceDocumentType[]>([])
  const [requirementsOpen, setRequirementsOpen] = useState(false)
  const [reviewDocument, setReviewDocument] = useState<ComplianceDocument | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)

  const loadData = useCallback(() => {
    startTransition(async () => {
      try {
        const [statusData, types] = await Promise.all([
          getCompanyComplianceStatusAction(company.id),
          listComplianceDocumentTypesAction(),
        ])
        setStatus(statusData)
        setDocumentTypes(types)
      } catch (error) {
        toast({
          title: "Failed to load compliance data",
          description: (error as Error).message,
        })
      }
    })
  }, [company.id, toast])

  useEffect(() => {
    loadData()
  }, [loadData])

  const openReview = (doc: ComplianceDocument) => {
    setReviewDocument(doc)
    setReviewOpen(true)
  }

  const deficienciesByRequirementId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const deficiency of status?.deficiencies ?? []) {
      const current = map.get(deficiency.requirement_id) ?? []
      current.push(deficiency.message)
      map.set(deficiency.requirement_id, current)
    }
    return map
  }, [status?.deficiencies])

  const requirementRows = useMemo(() => {
    if (!status) return []
    const nowMs = Date.now()
    return status.requirements.map((req) => {
      const docs = status.documents.filter(
        (d) => d.document_type_id === req.document_type_id,
      )
      const approved = docs.find(
        (d) =>
          d.status === "approved" &&
          (!d.expiry_date || new Date(d.expiry_date).getTime() > nowMs),
      )
      const pending = docs.find((d) => d.status === "pending_review")
      const expired = docs.find(
        (d) =>
          d.status === "expired" ||
          (d.status === "approved" &&
            d.expiry_date &&
            new Date(d.expiry_date).getTime() <= nowMs),
      )
      let state: ReqState = "missing"
      if (approved) state = "ok"
      else if (pending) state = "pending"
      else if (expired) state = "expired"
      return { req, state, approved, pending, expired }
    })
  }, [status])

  if (isPending && !status) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading compliance data...
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* Header — title + configure */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            Required documents
          </h2>
          <p className="text-xs text-muted-foreground">
            What this company must provide before working
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRequirementsOpen(true)}
        >
          <Settings className="mr-2 h-4 w-4" />
          Configure
        </Button>
      </div>

      {/* Requirements list */}
      {requirementRows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No requirements set for this company yet.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRequirementsOpen(true)}
          >
            <Settings className="mr-2 h-4 w-4" />
            Configure requirements
          </Button>
        </div>
      ) : (
        <div className="divide-y">
          {requirementRows.map(({ req, state, approved, pending }) => {
            const messages = deficienciesByRequirementId.get(req.id) ?? []
            const subParts: string[] = []
            if (state === "ok" && approved?.expiry_date) {
              subParts.push(`Expires ${formatDate(approved.expiry_date)}`)
            }
            if (req.notes) subParts.push(req.notes)
            return (
              <div key={req.id} className="px-4 py-4 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {req.document_type?.name}
                      </p>
                      {subParts.length > 0 ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {subParts.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <ReqStatePill state={state} />
                    {pending ? (
                      <Button size="sm" onClick={() => openReview(pending)}>
                        Review
                      </Button>
                    ) : null}
                  </div>
                </div>
                {messages.length > 0 ? (
                  <div className="ml-7 mt-2 flex items-start gap-2 border-l-2 border-orange-400 bg-orange-50 px-3 py-2 text-xs text-orange-800 dark:bg-orange-950/30 dark:text-orange-300">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="space-y-0.5">
                      {messages.map((message) => (
                        <p key={`${req.id}-${message}`}>{message}</p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {/* Dialogs */}
      <RequirementsEditor
        open={requirementsOpen}
        onOpenChange={setRequirementsOpen}
        companyId={company.id}
        companyName={company.name}
        documentTypes={documentTypes}
        currentRequirements={status?.requirements ?? []}
        onSaved={loadData}
      />
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        document={reviewDocument}
        onReviewed={loadData}
      />
    </div>
  )
}
