"use client"

import { useCallback, useEffect, useState, useTransition } from "react"

import type {
  Company,
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceStatusSummary,
} from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Textarea } from "@/components/ui/textarea"
import {
  getCompanyComplianceStatusAction,
  listComplianceDocumentTypesAction,
  reviewComplianceDocumentAction,
  setCompanyRequirementsAction,
} from "@/app/(app)/companies/actions"
import { useToast } from "@/hooks/use-toast"
import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, Settings, XCircle } from "@/components/icons"

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

function StatusBadge({ status }: { status: ComplianceDocument["status"] }) {
  switch (status) {
    case "pending_review":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" />
          Pending Review
        </Badge>
      )
    case "approved":
      return (
        <Badge variant="secondary" className="gap-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          <CheckCircle2 className="h-3 w-3" />
          Approved
        </Badge>
      )
    case "rejected":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          Rejected
        </Badge>
      )
    case "expired":
      return (
        <Badge variant="outline" className="gap-1 text-orange-600">
          <AlertCircle className="h-3 w-3" />
          Expired
        </Badge>
      )
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

interface RequirementsEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  documentTypes: ComplianceDocumentType[]
  currentRequirements: ComplianceRequirement[]
  onSaved: () => void
}

function RequirementsEditor({
  open,
  onOpenChange,
  companyId,
  documentTypes,
  currentRequirements,
  onSaved,
}: RequirementsEditorProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [minCoverage, setMinCoverage] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) {
      const sel: Record<string, boolean> = {}
      const n: Record<string, string> = {}
      const cov: Record<string, string> = {}
      for (const req of currentRequirements) {
        sel[req.document_type_id] = true
        if (req.notes) n[req.document_type_id] = req.notes
        if (req.min_coverage_cents)
          cov[req.document_type_id] = (req.min_coverage_cents / 100).toString()
      }
      setSelected(sel)
      setNotes(n)
      setMinCoverage(cov)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Compliance Requirements</DialogTitle>
          <DialogDescription>
            Select which documents this company must provide.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto py-2">
          {documentTypes.map((dt) => (
            <div key={dt.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <Checkbox
                  id={`req-${dt.id}`}
                  checked={selected[dt.id] || false}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => ({ ...prev, [dt.id]: !!checked }))
                  }
                />
                <div className="flex-1">
                  <Label htmlFor={`req-${dt.id}`} className="font-medium cursor-pointer">
                    {dt.name}
                  </Label>
                  {dt.description && (
                    <p className="text-xs text-muted-foreground">{dt.description}</p>
                  )}
                </div>
                {dt.has_expiry && (
                  <Badge variant="outline" className="text-xs">
                    Has expiry
                  </Badge>
                )}
              </div>
              {selected[dt.id] && dt.code.includes("coi") && (
                <div className="pl-7 space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground whitespace-nowrap">
                      Min coverage $
                    </Label>
                    <Input
                      type="number"
                      placeholder="e.g. 1000000"
                      className="h-8 w-32"
                      value={minCoverage[dt.id] || ""}
                      onChange={(e) =>
                        setMinCoverage((prev) => ({ ...prev, [dt.id]: e.target.value }))
                      }
                    />
                  </div>
                </div>
              )}
              {selected[dt.id] && (
                <div className="pl-7">
                  <Input
                    placeholder="Notes (e.g., Must list us as additional insured)"
                    className="h-8 text-sm"
                    value={notes[dt.id] || ""}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [dt.id]: e.target.value }))
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Requirements
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  if (isPending && !status) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading compliance data...
      </div>
    )
  }

  const pendingCount = status?.pending_review.length ?? 0
  const missingCount = status?.missing.length ?? 0
  const expiringCount = status?.expiring_soon.length ?? 0

  return (
    <div className="space-y-6">
      {/* Status Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Badge
            variant={status?.is_compliant ? "secondary" : "destructive"}
            className="text-sm px-3 py-1"
          >
            {status?.is_compliant ? "Compliant" : "Not Compliant"}
          </Badge>
          {pendingCount > 0 && (
            <Badge variant="secondary" className="gap-1">
              <Clock className="h-3 w-3" />
              {pendingCount} pending review
            </Badge>
          )}
          {missingCount > 0 && (
            <Badge variant="outline" className="gap-1 text-orange-600">
              <AlertCircle className="h-3 w-3" />
              {missingCount} missing
            </Badge>
          )}
          {expiringCount > 0 && (
            <Badge variant="outline" className="gap-1 text-yellow-600">
              <Clock className="h-3 w-3" />
              {expiringCount} expiring soon
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setRequirementsOpen(true)}>
          <Settings className="mr-2 h-4 w-4" />
          Configure Requirements
        </Button>
      </div>

      {/* Requirements */}
      {(status?.requirements.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Required Documents</CardTitle>
            <CardDescription>Documents this company must provide</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {status?.requirements.map((req) => {
                const hasApproved = status.documents.some(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "approved" &&
                    (!d.expiry_date || new Date(d.expiry_date) > new Date())
                )
                const hasPending = status.documents.some(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "pending_review"
                )
                return (
                  <div
                    key={req.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="font-medium text-sm">{req.document_type?.name}</p>
                        {req.notes && (
                          <p className="text-xs text-muted-foreground">{req.notes}</p>
                        )}
                      </div>
                    </div>
                    <div>
                      {hasApproved ? (
                        <Badge variant="secondary" className="gap-1 bg-green-100 text-green-800">
                          <CheckCircle2 className="h-3 w-3" />
                          On file
                        </Badge>
                      ) : hasPending ? (
                        <Badge variant="secondary" className="gap-1">
                          <Clock className="h-3 w-3" />
                          Pending review
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-orange-600">
                          <AlertCircle className="h-3 w-3" />
                          Missing
                        </Badge>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Review */}
      {pendingCount > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pending Review</CardTitle>
            <CardDescription>Documents awaiting your approval</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {status?.pending_review.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{doc.document_type?.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Uploaded {formatDate(doc.created_at)}
                        {doc.submitted_via_portal && " via portal"}
                      </p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => openReview(doc)}>
                    Review
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* All Documents */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All Documents</CardTitle>
          <CardDescription>Complete history of compliance documents</CardDescription>
        </CardHeader>
        <CardContent>
          {(status?.documents.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No documents uploaded yet
            </p>
          ) : (
            <div className="space-y-2">
              {status?.documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{doc.document_type?.name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Uploaded {formatDate(doc.created_at)}</span>
                        {doc.expiry_date && <span>· Expires {formatDate(doc.expiry_date)}</span>}
                        {doc.carrier_name && <span>· {doc.carrier_name}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={doc.status} />
                    {doc.status === "pending_review" && (
                      <Button size="sm" variant="outline" onClick={() => openReview(doc)}>
                        Review
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <RequirementsEditor
        open={requirementsOpen}
        onOpenChange={setRequirementsOpen}
        companyId={company.id}
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
