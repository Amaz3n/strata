"use client"

import { useRef, useState, useTransition } from "react"

import type {
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
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, Upload, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

function formatDate(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString()
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

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string
  documentTypes: ComplianceDocumentType[]
  requirements: ComplianceRequirement[]
  onUploaded: () => void
}

function UploadDialog({
  open,
  onOpenChange,
  token,
  documentTypes,
  requirements,
  onUploaded,
}: UploadDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [selectedTypeId, setSelectedTypeId] = useState<string>("")
  const [expiryDate, setExpiryDate] = useState("")
  const [policyNumber, setPolicyNumber] = useState("")
  const [carrierName, setCarrierName] = useState("")
  const [coverageAmount, setCoverageAmount] = useState("")
  const [additionalInsured, setAdditionalInsured] = useState(false)
  const [primaryNonContributory, setPrimaryNonContributory] = useState(false)
  const [waiverOfSubrogation, setWaiverOfSubrogation] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const selectedType = documentTypes.find((dt) => dt.id === selectedTypeId)
  const isInsurance =
    selectedType?.code.includes("coi") ||
    selectedType?.code.includes("insurance") ||
    selectedType?.code.includes("umbrella")

  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetForm = () => {
    setSelectedTypeId("")
    setExpiryDate("")
    setPolicyNumber("")
    setCarrierName("")
    setCoverageAmount("")
    setAdditionalInsured(false)
    setPrimaryNonContributory(false)
    setWaiverOfSubrogation(false)
    setFile(null)
    setUploadProgress(0)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return

    // Validate file size (25MB)
    if (selectedFile.size > 25 * 1024 * 1024) {
      setError("File size exceeds 25MB limit")
      return
    }

    // Validate file type
    const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"]
    if (!allowedTypes.includes(selectedFile.type)) {
      setError("Invalid file type. Please upload a PDF or image.")
      return
    }

    setFile(selectedFile)
    setError(null)
  }

  const handleUpload = () => {
    if (!file || !selectedTypeId) return

    startTransition(async () => {
      try {
        setUploadProgress(10)
        const formData = new FormData()
        formData.append("file", file)

        // Upload file first
        const uploadRes = await fetch(`/api/portal/s/${token}/compliance/upload`, {
          method: "POST",
          body: formData,
        })

        setUploadProgress(50)

        if (!uploadRes.ok) {
          const err = await uploadRes.json()
          throw new Error(err.error || "Upload failed")
        }

        const { fileId } = await uploadRes.json()

        setUploadProgress(75)

        // Create compliance document record
        const docRes = await fetch(`/api/portal/s/${token}/compliance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_type_id: selectedTypeId,
            file_id: fileId,
            expiry_date: expiryDate || undefined,
            policy_number: policyNumber || undefined,
            carrier_name: carrierName || undefined,
            coverage_amount_cents: coverageAmount
              ? Math.round(Number.parseFloat(coverageAmount) * 100)
              : undefined,
            additional_insured: additionalInsured,
            primary_noncontributory: primaryNonContributory,
            waiver_of_subrogation: waiverOfSubrogation,
          }),
        })

        if (!docRes.ok) {
          const err = await docRes.json()
          throw new Error(err.error || "Failed to save document")
        }

        setUploadProgress(100)
        resetForm()
        onUploaded()
        onOpenChange(false)
      } catch (err) {
        setError((err as Error).message)
        setUploadProgress(0)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetForm()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Compliance Document</DialogTitle>
          <DialogDescription>
            Upload a document to fulfill your compliance requirements.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Document Type</Label>
            <Select value={selectedTypeId} onValueChange={setSelectedTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select document type" />
              </SelectTrigger>
              <SelectContent>
                {documentTypes.map((dt) => {
                  const req = requirements.find((r) => r.document_type_id === dt.id)
                  return (
                    <SelectItem key={dt.id} value={dt.id}>
                      {dt.name}
                      {req && " (Required)"}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {selectedType?.has_expiry && (
            <div className="space-y-2">
              <Label>Expiration Date</Label>
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
          )}

          {isInsurance && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Policy Number</Label>
                  <Input
                    placeholder="Policy #"
                    value={policyNumber}
                    onChange={(e) => setPolicyNumber(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Carrier Name</Label>
                  <Input
                    placeholder="Insurance carrier"
                    value={carrierName}
                    onChange={(e) => setCarrierName(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Coverage Amount ($)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 1000000"
                  value={coverageAmount}
                  onChange={(e) => setCoverageAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">Policy Endorsements</p>
                <label className="flex items-center gap-2">
                  <Checkbox checked={additionalInsured} onCheckedChange={(checked) => setAdditionalInsured(checked === true)} />
                  <span>Includes additional insured endorsement</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={primaryNonContributory} onCheckedChange={(checked) => setPrimaryNonContributory(checked === true)} />
                  <span>Includes primary & non-contributory wording</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={waiverOfSubrogation} onCheckedChange={(checked) => setWaiverOfSubrogation(checked === true)} />
                  <span>Includes waiver of subrogation endorsement</span>
                </label>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>Document File</Label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
                file
                  ? "border-green-500 bg-green-50 dark:bg-green-950"
                  : "border-muted-foreground/25 hover:border-primary"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                onChange={handleFileChange}
                className="hidden"
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-green-600">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="text-sm font-medium">{file.name}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Click to select a file
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PDF, PNG, JPG up to 25MB
                  </p>
                </div>
              )}
            </div>
          </div>

          {uploadProgress > 0 && uploadProgress < 100 && (
            <Progress value={uploadProgress} className="h-2" />
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!file || !selectedTypeId || isPending}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Upload Document
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface SubComplianceTabProps {
  complianceStatus: ComplianceStatusSummary | undefined
  documentTypes: ComplianceDocumentType[]
  token: string
  canUpload: boolean
  onRefresh: () => void
}

export function SubComplianceTab({
  complianceStatus,
  documentTypes,
  token,
  canUpload,
  onRefresh,
}: SubComplianceTabProps) {
  const [uploadOpen, setUploadOpen] = useState(false)

  if (!complianceStatus) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading compliance data...
      </div>
    )
  }

  const missingCount = complianceStatus.missing.length
  const expiredCount = complianceStatus.expired.length
  const deficiencyCount = complianceStatus.deficiencies.length
  const deficienciesByRequirementId = complianceStatus.deficiencies.reduce((acc, deficiency) => {
    const current = acc.get(deficiency.requirement_id) ?? []
    current.push(deficiency.message)
    acc.set(deficiency.requirement_id, current)
    return acc
  }, new Map<string, string[]>())

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <div
        className={cn(
          "rounded-lg p-4",
          complianceStatus.is_compliant
            ? "bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
            : "bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800"
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {complianceStatus.is_compliant ? (
              <CheckCircle2 className="h-6 w-6 text-green-600" />
            ) : (
              <AlertCircle className="h-6 w-6 text-orange-600" />
            )}
            <div>
              <p className="font-medium">
                {complianceStatus.is_compliant
                  ? "All compliance requirements met"
                  : "Action Required"}
              </p>
              {!complianceStatus.is_compliant && (
                <p className="text-sm text-muted-foreground">
                  {missingCount > 0 && `${missingCount} missing`}
                  {missingCount > 0 && (expiredCount > 0 || deficiencyCount > 0) && ", "}
                  {expiredCount > 0 && `${expiredCount} expired`}
                  {(missingCount > 0 || expiredCount > 0) && deficiencyCount > 0 && ", "}
                  {deficiencyCount > 0 && `${deficiencyCount} need updates`}
                </p>
              )}
            </div>
          </div>
          {canUpload && (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Upload
            </Button>
          )}
        </div>
      </div>

      {/* Required Documents */}
      {complianceStatus.requirements.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Required Documents</CardTitle>
            <CardDescription>Documents you need to provide</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {complianceStatus.requirements.map((req) => {
                const approvedDoc = complianceStatus.documents.find(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "approved" &&
                    (!d.expiry_date || new Date(d.expiry_date) > new Date())
                )
                const expiredDoc = complianceStatus.documents.find(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "approved" &&
                    !!d.expiry_date &&
                    new Date(d.expiry_date) <= new Date()
                )
                const pendingDoc = complianceStatus.documents.find(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "pending_review"
                )
                const rejectedDoc = complianceStatus.documents.find(
                  (d) =>
                    d.document_type_id === req.document_type_id &&
                    d.status === "rejected"
                )
                const deficiencyMessages = deficienciesByRequirementId.get(req.id) ?? []

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
                        {deficiencyMessages.map((message) => (
                          <p key={`${req.id}-${message}`} className="text-xs text-orange-700">
                            {message}
                          </p>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {approvedDoc && deficiencyMessages.length === 0 ? (
                        <Badge
                          variant="secondary"
                          className="gap-1 bg-green-100 text-green-800"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          On file
                          {approvedDoc.expiry_date && (
                            <span className="ml-1">
                              (exp {formatDate(approvedDoc.expiry_date)})
                            </span>
                          )}
                        </Badge>
                      ) : approvedDoc && deficiencyMessages.length > 0 ? (
                        <Badge variant="outline" className="gap-1 text-orange-700">
                          <AlertCircle className="h-3 w-3" />
                          Needs update
                        </Badge>
                      ) : pendingDoc ? (
                        <Badge variant="secondary" className="gap-1">
                          <Clock className="h-3 w-3" />
                          Under review
                        </Badge>
                      ) : expiredDoc ? (
                        <Badge variant="outline" className="gap-1 text-orange-600">
                          <AlertCircle className="h-3 w-3" />
                          Expired{expiredDoc.expiry_date ? ` (exp ${formatDate(expiredDoc.expiry_date)})` : ""}
                        </Badge>
                      ) : rejectedDoc ? (
                        <div className="text-right">
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            Rejected
                          </Badge>
                          {rejectedDoc.rejection_reason && (
                            <p className="text-xs text-destructive mt-1">
                              {rejectedDoc.rejection_reason}
                            </p>
                          )}
                        </div>
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

      {/* Document History */}
      {complianceStatus.documents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Uploaded Documents</CardTitle>
            <CardDescription>Your submission history</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {complianceStatus.documents.map((doc) => (
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
                        {doc.expiry_date && ` · Expires ${formatDate(doc.expiry_date)}`}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={doc.status} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {complianceStatus.requirements.length === 0 &&
        complianceStatus.documents.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p>No compliance requirements have been set for your company.</p>
            </CardContent>
          </Card>
        )}

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        token={token}
        documentTypes={documentTypes}
        requirements={complianceStatus.requirements}
        onUploaded={onRefresh}
      />
    </div>
  )
}
