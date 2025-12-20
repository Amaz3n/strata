"use client"

import { useState, useTransition, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import {
  AlertTriangle,
  Check,
  Loader2,
  Upload,
  FileText,
  X,
  File as FileIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import type { SubPortalCommitment } from "@/lib/types"
import {
  submitInvoiceAction,
  uploadInvoiceFileAction,
} from "@/app/s/[token]/submit-invoice/actions"

interface SubInvoiceFormProps {
  token: string
  commitments: SubPortalCommitment[]
  preselectedCommitmentId?: string
  companyName: string
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function parseCurrencyInput(value: string): number {
  // Remove everything except digits and decimal point
  const cleaned = value.replace(/[^0-9.]/g, "")
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? 0 : Math.round(parsed * 100)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SubInvoiceForm({
  token,
  commitments,
  preselectedCommitmentId,
  companyName,
}: SubInvoiceFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [success, setSuccess] = useState(false)

  const [commitmentId, setCommitmentId] = useState(preselectedCommitmentId ?? "")
  const [billNumber, setBillNumber] = useState("")
  const [amountInput, setAmountInput] = useState("")
  const [billDate, setBillDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState("")
  const [description, setDescription] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")

  const [error, setError] = useState<string | null>(null)

  // File upload state
  const [uploadedFile, setUploadedFile] = useState<{
    id: string
    name: string
    size?: number
  } | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedCommitment = commitments.find((c) => c.id === commitmentId)
  const amountCents = parseCurrencyInput(amountInput)
  const isOverBudget = selectedCommitment
    ? amountCents > selectedCommitment.remaining_cents
    : false

  const billedPercent =
    selectedCommitment && selectedCommitment.total_cents > 0
      ? Math.round(
          (selectedCommitment.billed_cents / selectedCommitment.total_cents) * 100
        )
      : 0

  const handleFileSelect = useCallback(
    async (file: File) => {
      // Validate file type
      const allowedTypes = [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/heic",
      ]
      if (!allowedTypes.includes(file.type)) {
        setError("Please upload a PDF or image file")
        return
      }

      // Validate file size (25MB)
      if (file.size > 25 * 1024 * 1024) {
        setError("File size must be less than 25MB")
        return
      }

      setError(null)
      setSelectedFile(file)
      setIsUploading(true)
      setUploadProgress(10)

      // Simulate progress while uploading
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => Math.min(prev + 15, 85))
      }, 300)

      try {
        const formData = new FormData()
        formData.append("file", file)

        const result = await uploadInvoiceFileAction({ token, formData })

        clearInterval(progressInterval)

        if (result.success && result.fileId) {
          setUploadProgress(100)
          setUploadedFile({
            id: result.fileId,
            name: result.fileName ?? file.name,
            size: file.size,
          })
          setTimeout(() => {
            setSelectedFile(null)
            setUploadProgress(0)
          }, 500)
        } else {
          setError(result.error ?? "Failed to upload file")
          setSelectedFile(null)
          setUploadProgress(0)
        }
      } catch (err) {
        clearInterval(progressInterval)
        setError("Failed to upload file")
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
      if (file) {
        handleFileSelect(file)
      }
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

  const removeFile = useCallback(() => {
    setUploadedFile(null)
    setSelectedFile(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!commitmentId) {
      setError("Please select a contract")
      return
    }
    if (!billNumber.trim()) {
      setError("Please enter an invoice number")
      return
    }
    if (amountCents <= 0) {
      setError("Please enter a valid amount")
      return
    }

    startTransition(async () => {
      const result = await submitInvoiceAction({
        token,
        input: {
          commitment_id: commitmentId,
          bill_number: billNumber.trim(),
          total_cents: amountCents,
          bill_date: billDate,
          due_date: dueDate || undefined,
          description: description || undefined,
          period_start: periodStart || undefined,
          period_end: periodEnd || undefined,
          file_id: uploadedFile?.id,
        },
      })

      if (result.success) {
        setSuccess(true)
        // Redirect back to dashboard after short delay
        setTimeout(() => {
          router.push(`/s/${token}`)
          router.refresh()
        }, 2000)
      } else {
        setError(result.error ?? "Failed to submit invoice")
      }
    })
  }

  if (success) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
            <Check className="h-6 w-6 text-green-600" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Invoice Submitted</h3>
          <p className="text-muted-foreground">
            Your invoice has been submitted for review. You&apos;ll be redirected
            shortly.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Contract Selection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Contract</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="commitment">Contract</Label>
            <Select value={commitmentId} onValueChange={setCommitmentId}>
              <SelectTrigger id="commitment">
                <SelectValue placeholder="Select a contract" />
              </SelectTrigger>
              <SelectContent>
                {commitments.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <div className="flex items-center justify-between w-full gap-4">
                      <span className="truncate">{c.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {formatCurrency(c.remaining_cents)} remaining
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedCommitment && (
            <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Contract Total</span>
                <span className="font-medium">
                  {formatCurrency(selectedCommitment.total_cents)}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">
                    Billed ({billedPercent}%)
                  </span>
                  <span>{formatCurrency(selectedCommitment.billed_cents)}</span>
                </div>
                <Progress value={billedPercent} className="h-2" />
              </div>
              <div className="flex justify-between text-sm pt-1 border-t">
                <span className="text-muted-foreground">Available to Bill</span>
                <span className="font-medium text-primary">
                  {formatCurrency(selectedCommitment.remaining_cents)}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoice Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invoice Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="billNumber">Invoice Number *</Label>
              <Input
                id="billNumber"
                value={billNumber}
                onChange={(e) => setBillNumber(e.target.value)}
                placeholder="INV-001"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Amount *</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="amount"
                  type="text"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="0.00"
                  className="pl-7"
                  required
                />
              </div>
              {isOverBudget && (
                <div className="flex items-start gap-2 text-amber-600 text-xs mt-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    This amount exceeds the remaining budget. The invoice will
                    still be submitted for review.
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="billDate">Invoice Date *</Label>
              <Input
                id="billDate"
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input
                id="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description / Notes</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Work completed, materials used, etc."
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      {/* File Upload */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Attach Invoice</CardTitle>
        </CardHeader>
        <CardContent>
          {uploadedFile ? (
            <div className="flex items-center gap-3 rounded-lg border p-3 bg-muted/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{uploadedFile.name}</p>
                {uploadedFile.size && (
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(uploadedFile.size)}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={removeFile}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : selectedFile && isUploading ? (
            <div className="flex items-center gap-3 rounded-lg border p-3 bg-muted/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Progress value={uploadProgress} className="h-1.5 flex-1" />
                  <span className="text-xs text-muted-foreground">
                    {uploadProgress}%
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`
                relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6
                transition-all cursor-pointer
                ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
                }
              `}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileSelect(file)
                }}
                className="hidden"
              />

              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full ${
                  isDragging ? "bg-primary/20" : "bg-muted"
                }`}
              >
                <Upload
                  className={`h-5 w-5 ${
                    isDragging ? "text-primary" : "text-muted-foreground"
                  }`}
                />
              </div>

              <div className="text-center">
                <p className="text-sm font-medium">
                  {isDragging ? "Drop file here" : "Upload your invoice"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  PDF or image, max 25MB
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Work Period (Optional) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Work Period (Optional)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="periodStart">Period Start</Label>
              <Input
                id="periodStart"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="periodEnd">Period End</Label>
              <Input
                id="periodEnd"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary & Submit */}
      <div className="flex flex-col gap-3 pt-2">
        {amountCents > 0 && (
          <div className="rounded-lg border p-4 bg-muted/30">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm text-muted-foreground">Invoice Amount</p>
                <p className="text-2xl font-semibold">
                  {formatCurrency(amountCents)}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="text-muted-foreground">From</p>
                <p className="font-medium">{companyName}</p>
              </div>
            </div>
          </div>
        )}

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={
            isPending || !commitmentId || !billNumber || amountCents <= 0 || isUploading
          }
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Submitting...
            </>
          ) : (
            "Submit Invoice"
          )}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          By submitting, you confirm that this invoice is accurate and ready for
          review.
        </p>
      </div>
    </form>
  )
}
