"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react"
import { format } from "date-fns"

import type {
  Company,
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceStatusSummary,
} from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
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
  revokeCompanyRequirementWaiverAction,
  reviewComplianceDocumentAction,
  setCompanyRequirementsAction,
  uploadComplianceDocumentAction,
  waiveCompanyRequirementAction,
} from "@/app/(app)/companies/actions"
import { useToast } from "@/hooks/use-toast"
import { AlertCircle, CalendarDays, CheckCircle2, Clock, FileText, Loader2, Settings, Upload, XCircle } from "@/components/icons"
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

function formatMoneyInput(cents?: number | null) {
  if (cents == null) return ""
  return (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

function parseMoneyToCents(value?: string | null) {
  const normalized = value?.replace(/[$,\s]/g, "") ?? ""
  if (!normalized) return undefined
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.round(parsed * 100)
}

function parseDateValue(value?: string | null) {
  if (!value) return undefined
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10))
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatDateValue(date?: Date) {
  if (!date) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function DatePickerField({
  label,
  value,
  onChange,
  placeholder = "Pick a date",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selectedDate = parseDateValue(value)

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn("w-full justify-start text-left font-normal", !selectedDate && "text-muted-foreground")}
          >
            <CalendarDays className="mr-2 h-4 w-4" />
            {selectedDate ? format(selectedDate, "LLL dd, y") : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              onChange(formatDateValue(date))
              setOpen(false)
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
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
        if (req.source === "org_default") continue
        sel[req.document_type_id] = true
        if (req.notes) n[req.document_type_id] = req.notes
        if (req.min_coverage_cents)
          cov[req.document_type_id] = formatMoneyInput(req.min_coverage_cents)
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

  const inheritedByTypeId = useMemo(() => {
    const map = new Map<string, ComplianceRequirement>()
    for (const req of currentRequirements) {
      if (req.source === "org_default") map.set(req.document_type_id, req)
    }
    return map
  }, [currentRequirements])

  const handleSave = () => {
    startTransition(async () => {
      try {
        const requirements = documentTypes
          .filter((dt) => selected[dt.id])
          .map((dt) => ({
            document_type_id: dt.id,
            is_required: true,
            min_coverage_cents: parseMoneyToCents(minCoverage[dt.id]),
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
  const inheritedCount = inheritedByTypeId.size

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-2xl fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6 text-left">
          <SheetTitle className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            Vendor requirements
          </SheetTitle>
          <SheetDescription>
            Add vendor-specific requirements or override inherited org policy for {companyName || "this company"}.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mb-4 flex items-center justify-between gap-3 border bg-muted/20 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">{selectedCount} vendor-specific</p>
              <p className="text-xs text-muted-foreground">
                {inheritedCount} inherited from org policy. Use Waive on a requirement row to exempt this vendor.
              </p>
            </div>
            <Badge variant={selectedCount > 0 ? "secondary" : "outline"}>
              {documentTypes.length} available
            </Badge>
          </div>

          <div className="flex flex-col gap-3">
            {documentTypes.map((dt) => {
              const isSelected = selected[dt.id] || false
              const inherited = inheritedByTypeId.get(dt.id)
              const isInsurance =
                dt.code.includes("coi") ||
                dt.code.includes("insurance") ||
                dt.code.includes("umbrella")
              return (
                <div
                  key={dt.id}
                  className={cn(
                    "border bg-background transition-colors",
                    isSelected ? "border-primary/40 shadow-sm" : "border-border/80",
                  )}
                >
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center border bg-muted/30">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{dt.name}</p>
                        {inherited ? <Badge variant="outline">Org policy</Badge> : null}
                        {isSelected ? <Badge variant="secondary">{inherited ? "Vendor override" : "Vendor required"}</Badge> : null}
                        {dt.has_expiry ? <Badge variant="outline">Expires</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {inherited && !isSelected
                          ? "Inherited from org-wide compliance policy."
                          : dt.description || "No description provided."}
                      </p>
                    </div>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => ({ ...prev, [dt.id]: !!checked }))
                      }
                      className="mt-1"
                      aria-label={`${inherited ? "Override" : "Require"} ${dt.name}`}
                    />
                  </div>

                  {isSelected && (
                    <div className="border-t bg-muted/10 px-4 py-4">
                      {isInsurance && (
                        <div className="mb-4 flex flex-col gap-4">
                          <div className="max-w-xs">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">
                              Minimum coverage
                            </Label>
                            <InputGroup>
                              <InputGroupAddon>$</InputGroupAddon>
                              <InputGroupInput
                                inputMode="decimal"
                                placeholder="1,000,000"
                                value={minCoverage[dt.id] || ""}
                                onChange={(event) =>
                                  setMinCoverage((prev) => ({
                                    ...prev,
                                    [dt.id]: event.target.value,
                                  }))
                                }
                                onBlur={() =>
                                  setMinCoverage((prev) => ({
                                    ...prev,
                                    [dt.id]: formatMoneyInput(parseMoneyToCents(prev[dt.id])),
                                  }))
                                }
                              />
                            </InputGroup>
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label className="text-xs text-muted-foreground">Required endorsements</Label>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <label className="flex min-h-10 items-center gap-2 border bg-background px-3 py-2 text-sm">
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
                              <label className="flex min-h-10 items-center gap-2 border bg-background px-3 py-2 text-sm">
                                <Checkbox
                                  checked={requiresPrimaryNonContributory[dt.id] || false}
                                  onCheckedChange={(checked) =>
                                    setRequiresPrimaryNonContributory((prev) => ({
                                      ...prev,
                                      [dt.id]: checked === true,
                                    }))
                                  }
                                />
                                <span>Primary &amp; non-contributory</span>
                              </label>
                              <label className="flex min-h-10 items-center gap-2 border bg-background px-3 py-2 text-sm">
                                <Checkbox
                                  checked={requiresWaiverOfSubrogation[dt.id] || false}
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
                          </div>
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Notes for this requirement</Label>
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

        <SheetFooter className="flex-row items-center justify-between border-t bg-background/80 px-6 py-3">
          <span className="text-xs text-muted-foreground">
            {selectedCount} vendor-specific {selectedCount === 1 ? "rule" : "rules"}
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

interface WaiverDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  requirement: ComplianceRequirement | null
  onSaved: () => void
}

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  documentTypes: ComplianceDocumentType[]
  requirements: ComplianceRequirement[]
  onUploaded: () => void
}

function UploadDialog({
  open,
  onOpenChange,
  companyId,
  documentTypes,
  requirements,
  onUploaded,
}: UploadDialogProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [selectedTypeId, setSelectedTypeId] = useState("")
  const [effectiveDate, setEffectiveDate] = useState("")
  const [expiryDate, setExpiryDate] = useState("")
  const [policyNumber, setPolicyNumber] = useState("")
  const [carrierName, setCarrierName] = useState("")
  const [coverageAmount, setCoverageAmount] = useState("")
  const [additionalInsured, setAdditionalInsured] = useState(false)
  const [primaryNonContributory, setPrimaryNonContributory] = useState(false)
  const [waiverOfSubrogation, setWaiverOfSubrogation] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedType = documentTypes.find((dt) => dt.id === selectedTypeId)
  const isInsurance =
    selectedType?.code.includes("coi") ||
    selectedType?.code.includes("insurance") ||
    selectedType?.code.includes("umbrella")

  const resetForm = () => {
    setSelectedTypeId("")
    setEffectiveDate("")
    setExpiryDate("")
    setPolicyNumber("")
    setCarrierName("")
    setCoverageAmount("")
    setAdditionalInsured(false)
    setPrimaryNonContributory(false)
    setWaiverOfSubrogation(false)
    setFile(null)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]
    if (!selectedFile) return

    if (selectedFile.size > 25 * 1024 * 1024) {
      setError("File size exceeds 25MB limit")
      return
    }

    const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic"]
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
        const formData = new FormData()
        formData.append("file", file)

        const uploadRes = await fetch(`/api/companies/${companyId}/compliance/upload`, {
          method: "POST",
          body: formData,
        })

        if (!uploadRes.ok) {
          const payload = await uploadRes.json().catch(() => ({}))
          throw new Error(payload.error || "Upload failed")
        }

        const { fileId } = await uploadRes.json()
        const document = await uploadComplianceDocumentAction({
          companyId,
          fileId,
          input: {
            document_type_id: selectedTypeId,
            effective_date: effectiveDate || undefined,
            expiry_date: expiryDate || undefined,
            policy_number: policyNumber || undefined,
            carrier_name: carrierName || undefined,
            coverage_amount_cents: parseMoneyToCents(coverageAmount),
            additional_insured: additionalInsured,
            primary_noncontributory: primaryNonContributory,
            waiver_of_subrogation: waiverOfSubrogation,
          },
        })

        await reviewComplianceDocumentAction(document.id, {
          decision: "approved",
          notes: "Uploaded and approved by builder.",
        })

        toast({ title: "Document uploaded and approved" })
        resetForm()
        onUploaded()
        onOpenChange(false)
      } catch (uploadError) {
        setError((uploadError as Error).message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetForm()
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload compliance document</DialogTitle>
          <DialogDescription>
            Add a document the vendor sent outside the portal.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Document type</Label>
            <Select value={selectedTypeId} onValueChange={setSelectedTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select document type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {documentTypes.map((dt) => {
                    const req = requirements.find((r) => r.document_type_id === dt.id)
                    return (
                      <SelectItem key={dt.id} value={dt.id}>
                        {dt.name}
                        {req ? " (Required)" : ""}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <DatePickerField
              label="Effective date"
              value={effectiveDate}
              onChange={setEffectiveDate}
              placeholder="Optional"
            />
            {selectedType?.has_expiry ? (
              <DatePickerField
                label="Expiration date"
                value={expiryDate}
                onChange={setExpiryDate}
              />
            ) : null}
          </div>

          {isInsurance ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label>Policy #</Label>
                  <Input value={policyNumber} onChange={(event) => setPolicyNumber(event.target.value)} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Carrier</Label>
                  <Input value={carrierName} onChange={(event) => setCarrierName(event.target.value)} />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Coverage amount</Label>
                <InputGroup>
                  <InputGroupAddon>$</InputGroupAddon>
                  <InputGroupInput
                    inputMode="decimal"
                    placeholder="1,000,000"
                    value={coverageAmount}
                    onChange={(event) => setCoverageAmount(event.target.value)}
                    onBlur={() => setCoverageAmount(formatMoneyInput(parseMoneyToCents(coverageAmount)))}
                  />
                </InputGroup>
              </div>
              <div className="flex flex-col gap-2 border p-3 text-sm">
                <Label className="text-xs text-muted-foreground">Policy endorsements</Label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={additionalInsured} onCheckedChange={(checked) => setAdditionalInsured(checked === true)} />
                  <span>Additional insured</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={primaryNonContributory} onCheckedChange={(checked) => setPrimaryNonContributory(checked === true)} />
                  <span>Primary &amp; non-contributory</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={waiverOfSubrogation} onCheckedChange={(checked) => setWaiverOfSubrogation(checked === true)} />
                  <span>Waiver of subrogation</span>
                </label>
              </div>
            </>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>File</Label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "w-full border border-dashed px-4 py-5 text-center text-sm transition-colors hover:border-primary",
                file ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "text-muted-foreground",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                onChange={handleFileChange}
                className="hidden"
              />
              {file ? file.name : "Choose a PDF or image up to 25MB"}
            </button>
          </div>

          <div className="border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Builder uploads are marked approved immediately.
          </div>

          {error ? (
            <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || !selectedTypeId || isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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

function WaiverDialog({
  open,
  onOpenChange,
  companyId,
  requirement,
  onSaved,
}: WaiverDialogProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState("")
  const [expiresAt, setExpiresAt] = useState("")

  useEffect(() => {
    if (open) {
      setReason(requirement?.waiver?.reason ?? "")
      setExpiresAt(requirement?.waiver?.expires_at ?? "")
    }
  }, [open, requirement])

  const handleSubmit = () => {
    if (!requirement) return
    startTransition(async () => {
      try {
        await waiveCompanyRequirementAction(companyId, {
          document_type_id: requirement.document_type_id,
          reason: reason || undefined,
          expires_at: expiresAt || undefined,
        })
        toast({ title: "Requirement waived" })
        onSaved()
        onOpenChange(false)
      } catch (error) {
        toast({
          title: "Unable to waive requirement",
          description: (error as Error).message,
        })
      }
    })
  }

  if (!requirement) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Waive requirement</DialogTitle>
          <DialogDescription>
            Exempt {requirement.document_type?.name ?? "this document"} for this vendor with an audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Covered under project-specific OCIP"
            />
          </div>
          <DatePickerField
            label="Waiver expiration"
            value={expiresAt}
            onChange={setExpiresAt}
            placeholder="No expiration"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save waiver
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ReqState = "ok" | "pending" | "expired" | "missing" | "waived"

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
    waived: {
      label: "Waived",
      icon: <CheckCircle2 className="h-3 w-3" />,
      className:
        "border-sky-600/30 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400",
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
  const [uploadOpen, setUploadOpen] = useState(false)
  const [reviewDocument, setReviewDocument] = useState<ComplianceDocument | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [waiverRequirement, setWaiverRequirement] = useState<ComplianceRequirement | null>(null)
  const [waiverOpen, setWaiverOpen] = useState(false)

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

  const openWaiver = (requirement: ComplianceRequirement) => {
    setWaiverRequirement(requirement)
    setWaiverOpen(true)
  }

  const revokeWaiver = (requirement: ComplianceRequirement) => {
    const waiverId = requirement.waiver?.id
    if (!waiverId) return
    startTransition(async () => {
      try {
        await revokeCompanyRequirementWaiverAction(waiverId)
        toast({ title: "Waiver removed" })
        loadData()
      } catch (error) {
        toast({
          title: "Unable to remove waiver",
          description: (error as Error).message,
        })
      }
    })
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
      if (req.waiver) state = "waived"
      else if (approved) state = "ok"
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
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRequirementsOpen(true)}
          >
            <Settings className="mr-2 h-4 w-4" />
            Configure
          </Button>
        </div>
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
            if (req.waiver) {
              subParts.push(
                req.waiver.expires_at
                  ? `Waived until ${formatDate(req.waiver.expires_at)}`
                  : "Waived indefinitely"
              )
            }
            if (req.notes) subParts.push(req.notes)
            return (
              <div key={req.id} className="px-4 py-4 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {req.document_type?.name}
                        </p>
                        <Badge variant={req.source === "org_default" ? "outline" : "secondary"}>
                          {req.source === "org_default" ? "Org policy" : "Vendor override"}
                        </Badge>
                      </div>
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
                    {req.waiver ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => revokeWaiver(req)}
                        disabled={isPending}
                      >
                        Remove waiver
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => openWaiver(req)}>
                        Waive
                      </Button>
                    )}
                  </div>
                </div>
                {req.waiver?.reason ? (
                  <div className="ml-7 mt-2 border-l-2 border-sky-400 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
                    {req.waiver.reason}
                  </div>
                ) : null}
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
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        companyId={company.id}
        documentTypes={documentTypes}
        requirements={status?.requirements ?? []}
        onUploaded={loadData}
      />
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        document={reviewDocument}
        onReviewed={loadData}
      />
      <WaiverDialog
        open={waiverOpen}
        onOpenChange={setWaiverOpen}
        companyId={company.id}
        requirement={waiverRequirement}
        onSaved={loadData}
      />
    </div>
  )
}
