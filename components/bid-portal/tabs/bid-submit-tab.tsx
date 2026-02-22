"use client"

import { useState, useTransition, useRef, useCallback } from "react"
import { format } from "date-fns"
import {
  Send,
  AlertTriangle,
  CheckCircle2,
  Upload,
  FileText,
  X,
  Loader2,
  History,
  CalendarIcon,
  DollarSign,
  Clock,
  User,
  Mail,
} from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { BidPortalAccess, BidPortalSubmission } from "@/lib/services/bid-portal"
import { submitBidAction } from "@/app/b/[token]/actions"
import { uploadBidFileAction } from "@/app/b/[token]/actions"

interface BidSubmitTabProps {
  token: string
  access: BidPortalAccess
  currentSubmission?: BidPortalSubmission
  submissions: BidPortalSubmission[]
  onSubmissionChange?: (submission: BidPortalSubmission) => void
}

function formatCurrency(cents?: number | null) {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatCurrencyInput(value: string): string {
  // Remove everything except digits and decimal point
  const cleaned = value.replace(/[^\d.]/g, "")

  // Handle empty string
  if (!cleaned) return ""

  // Split into whole and decimal parts
  const parts = cleaned.split(".")
  let whole = parts[0] ?? ""
  const decimal = parts[1]

  // Remove leading zeros (but keep at least one if that's all there is)
  whole = whole.replace(/^0+/, "") || "0"

  // Add thousand separators
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

  // Reconstruct with decimal if present
  if (decimal !== undefined) {
    // Limit decimal to 2 places
    return `${whole}.${decimal.slice(0, 2)}`
  }

  return whole
}

function parseCurrencyToCents(value: string) {
  const sanitized = value.replace(/[^\d.]/g, "")
  if (!sanitized) return null
  const [whole, decimals] = sanitized.split(".")
  const dollars = Number(whole ?? "0")
  const cents = Number((decimals ?? "0").padEnd(2, "0").slice(0, 2))
  if (Number.isNaN(dollars) || Number.isNaN(cents)) return null
  return dollars * 100 + cents
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const disallowedStatuses = ["closed", "awarded", "cancelled"]

export function BidSubmitTab({
  token,
  access,
  currentSubmission: initialSubmission,
  submissions: initialSubmissions,
  onSubmissionChange,
}: BidSubmitTabProps) {
  const [currentSubmission, setCurrentSubmission] = useState(initialSubmission)
  const [submissions, setSubmissions] = useState(initialSubmissions)
  const [isSubmitting, startSubmitting] = useTransition()

  const [total, setTotal] = useState(() =>
    initialSubmission?.total_cents
      ? formatCurrencyInput((initialSubmission.total_cents / 100).toFixed(2))
      : ""
  )
  const [validUntil, setValidUntil] = useState<Date | undefined>(() =>
    initialSubmission?.valid_until ? new Date(initialSubmission.valid_until) : undefined
  )
  const [validUntilOpen, setValidUntilOpen] = useState(false)
  const [leadTime, setLeadTime] = useState(initialSubmission?.lead_time_days?.toString() ?? "")
  const [duration, setDuration] = useState(initialSubmission?.duration_days?.toString() ?? "")
  const [startAvailable, setStartAvailable] = useState<Date | undefined>(() =>
    initialSubmission?.start_available_on ? new Date(initialSubmission.start_available_on) : undefined
  )
  const [startAvailableOpen, setStartAvailableOpen] = useState(false)
  const [exclusions, setExclusions] = useState(initialSubmission?.exclusions ?? "")
  const [clarifications, setClarifications] = useState(initialSubmission?.clarifications ?? "")
  const [notes, setNotes] = useState(initialSubmission?.notes ?? "")
  const [submitterName, setSubmitterName] = useState(
    initialSubmission?.submitted_by_name ??
      access.invite.contact?.full_name ??
      ""
  )
  const [submitterEmail, setSubmitterEmail] = useState(
    initialSubmission?.submitted_by_email ??
      access.invite.contact?.email ??
      access.invite.invite_email ??
      ""
  )

  // File upload state
  const [uploadedFiles, setUploadedFiles] = useState<{ id: string; name: string; size?: number }[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const dueDate = access.bidPackage.due_at ? new Date(access.bidPackage.due_at) : null
  const isPastDue = dueDate ? dueDate.getTime() < Date.now() : false
  const biddingClosed = disallowedStatuses.includes(access.bidPackage.status)
  const inviteInactive = ["declined", "withdrawn"].includes(access.invite.status)
  const canSubmit = !biddingClosed && !inviteInactive

  const submissionLabel = currentSubmission ? "Submit Revised Bid" : "Submit Bid"

  const handleFileSelect = useCallback(
    async (file: File) => {
      const allowedTypes = [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ]
      if (!allowedTypes.includes(file.type)) {
        toast.error("Please upload a PDF, image, Word, or Excel file")
        return
      }

      if (file.size > 25 * 1024 * 1024) {
        toast.error("File size must be less than 25MB")
        return
      }

      setSelectedFile(file)
      setIsUploading(true)
      setUploadProgress(10)

      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => Math.min(prev + 15, 85))
      }, 300)

      try {
        const formData = new FormData()
        formData.append("file", file)

        const result = await uploadBidFileAction({ token, formData })

        clearInterval(progressInterval)

        if (result.success && result.fileId) {
          setUploadProgress(100)
          setUploadedFiles((prev) => [
            ...prev,
            { id: result.fileId!, name: result.fileName ?? file.name, size: file.size },
          ])
          setTimeout(() => {
            setSelectedFile(null)
            setUploadProgress(0)
          }, 500)
        } else {
          toast.error(result.error ?? "Failed to upload file")
          setSelectedFile(null)
          setUploadProgress(0)
        }
      } catch {
        clearInterval(progressInterval)
        toast.error("Failed to upload file")
        setSelectedFile(null)
        setUploadProgress(0)
      } finally {
        setIsUploading(false)
      }
    },
    [token]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const removeFile = useCallback((fileId: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  const handleSubmit = () => {
    const cents = parseCurrencyToCents(total)
    if (!cents || cents <= 0) {
      toast.error("Enter a valid total amount")
      return
    }
    if (!submitterName.trim()) {
      toast.error("Name is required")
      return
    }
    if (!submitterEmail.trim()) {
      toast.error("Email is required")
      return
    }

    startSubmitting(async () => {
      const result = await submitBidAction({
        token,
        input: {
          total_cents: cents,
          currency: "usd",
          valid_until: validUntil ? format(validUntil, "yyyy-MM-dd") : null,
          lead_time_days: leadTime ? Number(leadTime) : null,
          duration_days: duration ? Number(duration) : null,
          start_available_on: startAvailable ? format(startAvailable, "yyyy-MM-dd") : null,
          exclusions: exclusions.trim() || null,
          clarifications: clarifications.trim() || null,
          notes: notes.trim() || null,
          submitted_by_name: submitterName.trim(),
          submitted_by_email: submitterEmail.trim(),
          file_ids: uploadedFiles.map((f) => f.id),
        },
      })

      if (!result.success || !result.submission) {
        toast.error(result.error ?? "Failed to submit bid")
        return
      }

      setCurrentSubmission(result.submission)
      setSubmissions((prev) => [
        { ...result.submission!, is_current: true },
        ...prev.map((item) => ({ ...item, is_current: false })),
      ])
      onSubmissionChange?.(result.submission)
      setUploadedFiles([])
      toast.success("Bid submitted successfully")
    })
  }

  return (
    <div className="space-y-4">
      {/* Closed/Inactive Warning */}
      {!canSubmit && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Bidding Closed</p>
                <p className="text-sm text-muted-foreground">
                  This bid package is no longer accepting submissions.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Past Due Warning */}
      {canSubmit && isPastDue && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Past Due</p>
                <p className="text-sm text-muted-foreground">
                  This bid is past due. Submissions may be reviewed at the builder&apos;s discretion.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Submission Form */}
      {canSubmit && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">
              {currentSubmission ? "Revise Your Bid" : "Submit Your Bid"}
            </CardTitle>
            <CardDescription>
              Fill out the details below to submit your bid for this package.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Pricing Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <DollarSign className="h-4 w-4" />
                Pricing
              </div>
              <div className="space-y-2">
                <Label htmlFor="total">
                  Total Price <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">
                    $
                  </span>
                  <Input
                    id="total"
                    value={total}
                    onChange={(e) => setTotal(formatCurrencyInput(e.target.value))}
                    placeholder="0.00"
                    className="pl-7 text-lg font-semibold h-12"
                    inputMode="decimal"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter your total bid amount in USD
                </p>
              </div>
            </div>

            {/* Schedule Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Clock className="h-4 w-4" />
                Schedule & Timing
              </div>

              {/* Dates */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Bid Valid Until</Label>
                  <Popover open={validUntilOpen} onOpenChange={setValidUntilOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !validUntil && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {validUntil ? format(validUntil, "MMM d, yyyy") : "Select date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={validUntil}
                        onSelect={(date) => {
                          setValidUntil(date)
                          setValidUntilOpen(false)
                        }}
                        disabled={(date) => date < new Date()}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    How long is this quote valid?
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Start Available</Label>
                  <Popover open={startAvailableOpen} onOpenChange={setStartAvailableOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !startAvailable && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {startAvailable ? format(startAvailable, "MMM d, yyyy") : "Select date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={startAvailable}
                        onSelect={(date) => {
                          setStartAvailable(date)
                          setStartAvailableOpen(false)
                        }}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    Earliest date you can begin work
                  </p>
                </div>
              </div>

              {/* Lead Time & Duration */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="leadTime">Lead Time</Label>
                  <div className="relative">
                    <Input
                      id="leadTime"
                      type="number"
                      min="0"
                      value={leadTime}
                      onChange={(e) => setLeadTime(e.target.value)}
                      placeholder="0"
                      className="pr-14"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      days
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Time needed to procure materials
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration">Duration</Label>
                  <div className="relative">
                    <Input
                      id="duration"
                      type="number"
                      min="0"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      placeholder="0"
                      className="pr-14"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      days
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Estimated time to complete work
                  </p>
                </div>
              </div>
            </div>

            {/* Contact Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <User className="h-4 w-4" />
                Contact Information
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="submitterName">
                    Your Name <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="submitterName"
                      value={submitterName}
                      onChange={(e) => setSubmitterName(e.target.value)}
                      placeholder="John Smith"
                      className="pl-9"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="submitterEmail">
                    Your Email <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="submitterEmail"
                      type="email"
                      value={submitterEmail}
                      onChange={(e) => setSubmitterEmail(e.target.value)}
                      placeholder="john@company.com"
                      className="pl-9"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Details Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <FileText className="h-4 w-4" />
                Bid Details
              </div>

              {/* Exclusions */}
              <div className="space-y-2">
                <Label htmlFor="exclusions">Exclusions</Label>
                <Textarea
                  id="exclusions"
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                  placeholder="List any items, materials, or work not included in this bid..."
                  rows={3}
                  className="resize-none"
                />
              </div>

              {/* Clarifications */}
              <div className="space-y-2">
                <Label htmlFor="clarifications">Clarifications</Label>
                <Textarea
                  id="clarifications"
                  value={clarifications}
                  onChange={(e) => setClarifications(e.target.value)}
                  placeholder="Note any assumptions, conditions, or clarifications about your bid..."
                  rows={3}
                  className="resize-none"
                />
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="notes">Additional Notes</Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any other information you'd like to include..."
                  rows={3}
                  className="resize-none"
                />
              </div>
            </div>

            {/* File Upload */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Upload className="h-4 w-4" />
                Attachments
              </div>

              {/* Uploaded Files */}
              {uploadedFiles.length > 0 && (
                <div className="space-y-2">
                  {uploadedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 rounded-lg border p-3 bg-muted/30"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        {file.size && (
                          <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeFile(file.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Uploading File */}
              {selectedFile && isUploading && (
                <div className="flex items-center gap-3 rounded-lg border p-3 bg-muted/30">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <Loader2 className="h-5 w-5 text-primary animate-spin" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Progress value={uploadProgress} className="h-1.5 flex-1" />
                      <span className="text-xs text-muted-foreground tabular-nums">{uploadProgress}%</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Drop Zone */}
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-all cursor-pointer",
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFileSelect(file)
                    e.target.value = ""
                  }}
                  className="hidden"
                />
                <div
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-full transition-colors",
                    isDragging ? "bg-primary/20" : "bg-muted"
                  )}
                >
                  <Upload className={cn("h-6 w-6", isDragging ? "text-primary" : "text-muted-foreground")} />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">
                    {isDragging ? "Drop file here" : "Drag & drop or click to upload"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    PDF, Word, Excel, or images up to 25MB
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Upload your detailed proposal, cost breakdown, or any supporting documents
              </p>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <Button
                className="w-full h-12 text-base font-medium"
                size="lg"
                onClick={handleSubmit}
                disabled={isSubmitting || isUploading}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="h-5 w-5 mr-2" />
                    {submissionLabel}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Submission History */}
      {submissions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Submission History</CardTitle>
            </div>
            <CardDescription>
              {submissions.length} submission{submissions.length !== 1 ? "s" : ""} for this bid package
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {submissions.map((submission, index) => (
              <div
                key={submission.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-4 rounded-lg border px-4 py-4 transition-colors",
                  submission.is_current
                    ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30"
                    : "bg-muted/30 hover:bg-muted/50"
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                      submission.is_current
                        ? "bg-green-100 dark:bg-green-900/50"
                        : "bg-muted"
                    )}
                  >
                    {submission.is_current ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <span className="text-sm font-medium text-muted-foreground">
                        v{submission.version}
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        Version {submission.version}
                      </p>
                      {submission.is_current && (
                        <Badge
                          variant="outline"
                          className="text-xs bg-green-100 text-green-700 border-green-300 dark:bg-green-900/50 dark:text-green-400 dark:border-green-800"
                        >
                          Current
                        </Badge>
                      )}
                      {index === 0 && !submission.is_current && (
                        <Badge variant="secondary" className="text-xs">
                          Latest
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {submission.submitted_at
                        ? format(new Date(submission.submitted_at), "MMM d, yyyy 'at' h:mm a")
                        : "Not submitted"}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-base font-semibold tabular-nums">
                    {formatCurrency(submission.total_cents)}
                  </p>
                  {submission.valid_until && (
                    <p className="text-xs text-muted-foreground">
                      Valid until {format(new Date(submission.valid_until), "MMM d, yyyy")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
