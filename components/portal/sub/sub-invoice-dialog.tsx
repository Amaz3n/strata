"use client"

import { useCallback, useRef, useState, useTransition, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DateField } from "@/components/ui/date-field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ResponsiveDialog } from "@/components/ui/responsive-dialog"
import { Textarea } from "@/components/ui/textarea"
import { formatFileSize } from "@/components/files/types"
import { cn, formatMoneyCentsExact } from "@/lib/utils"
import type { SubPortalCommitment } from "@/lib/types"
import { submitInvoiceAction, uploadInvoiceFileAction } from "@/app/s/[token]/submit-invoice/actions"

const ACCEPTED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
]

const MAX_FILE_BYTES = 25 * 1024 * 1024

function parseCurrencyInput(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "")
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? 0 : Math.round(parsed * 100)
}

export interface SubInvoiceDialogProps {
  token: string
  commitments: SubPortalCommitment[]
  companyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  preselectedCommitmentId?: string
  /** Where to go once the invoice lands. Defaults to the invoices list. */
  onSubmitted?: () => void
}

/**
 * Submitting an invoice is a short, self-contained task, so it happens over the
 * page the sub was already on rather than as a separate destination — a drawer
 * on touch, a dialog on desktop, matching `components/expenses/expense-form.tsx`.
 */
export function SubInvoiceDialog(props: SubInvoiceDialogProps) {
  return (
    <ResponsiveDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Submit an invoice"
      description="Bill against one of your contracts. The builder reviews it before payment."
    >
      <InvoiceFormBody {...props} />
    </ResponsiveDialog>
  )
}

function InvoiceFormBody({
  token,
  commitments,
  companyName,
  preselectedCommitmentId,
  onOpenChange,
  onSubmitted,
}: SubInvoiceDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [success, setSuccess] = useState(false)

  const [commitmentId, setCommitmentId] = useState(
    preselectedCommitmentId ?? (commitments.length === 1 ? commitments[0].id : ""),
  )
  const [billNumber, setBillNumber] = useState("")
  const [amountInput, setAmountInput] = useState("")
  const [billDate, setBillDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState("")
  const [description, setDescription] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [uploadedFile, setUploadedFile] = useState<{ id: string; name: string; size: number } | null>(
    null,
  )
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedCommitment = commitments.find((c) => c.id === commitmentId)
  const amountCents = parseCurrencyInput(amountInput)
  const remainingCents = selectedCommitment?.remaining_cents ?? 0
  const remainingAfter = remainingCents - amountCents
  const isOverBudget = !!selectedCommitment && amountCents > remainingCents

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError("That file type is not supported. Upload a PDF or an image.")
        return
      }
      if (file.size > MAX_FILE_BYTES) {
        setError("That file is larger than 25MB. Try a smaller scan or a PDF.")
        return
      }

      setError(null)
      setUploadingName(file.name)
      setUploadProgress(10)

      const ticker = setInterval(() => {
        setUploadProgress((prev) => Math.min(prev + 15, 85))
      }, 300)

      try {
        const formData = new FormData()
        formData.append("file", file)
        const result = await uploadInvoiceFileAction({ token, formData })
        clearInterval(ticker)

        if (result.success && result.fileId) {
          setUploadProgress(100)
          setUploadedFile({ id: result.fileId, name: result.fileName ?? file.name, size: file.size })
        } else {
          setError(result.error ?? "That upload did not go through. Try again.")
        }
      } catch {
        clearInterval(ticker)
        setError("That upload did not go through. Try again.")
      } finally {
        setUploadingName(null)
        setUploadProgress(0)
      }
    },
    [token],
  )

  const removeFile = useCallback(() => {
    setUploadedFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (!commitmentId) return setError("Choose the contract you are billing against.")
    if (!billNumber.trim()) return setError("Enter your invoice number.")
    if (amountCents <= 0) return setError("Enter the amount you are invoicing.")

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
        setTimeout(() => {
          onOpenChange(false)
          if (onSubmitted) onSubmitted()
          else router.push(`/s/${token}/bills`)
          router.refresh()
        }, 1400)
      } else {
        setError(result.error ?? "The invoice could not be submitted. Try again.")
      }
    })
  }

  if (success) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-success/15">
          <Check className="size-6 text-success" />
        </div>
        <p className="text-base font-semibold">Invoice {billNumber} submitted</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
          {formatMoneyCentsExact(amountCents)} sent for review.
        </p>
      </div>
    )
  }

  const canSubmit =
    !isPending && !uploadingName && !!commitmentId && !!billNumber.trim() && amountCents > 0

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {error ? (
          <p
            role="alert"
            className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {commitments.length > 1 ? (
          <div className="space-y-1.5">
            <Label>Contract</Label>
            <div className="divide-y divide-border border border-border">
              {commitments.map((commitment) => {
                const isSelected = commitment.id === commitmentId
                return (
                  <label
                    key={commitment.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors",
                      isSelected ? "bg-primary/8" : "hover:bg-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="commitment"
                      value={commitment.id}
                      checked={isSelected}
                      onChange={() => setCommitmentId(commitment.id)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{commitment.title}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {formatMoneyCentsExact(commitment.remaining_cents)} left to bill
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        ) : selectedCommitment ? (
          <p className="text-sm text-muted-foreground">
            Billing against <span className="font-medium text-foreground">{selectedCommitment.title}</span>
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="invoice-amount">Amount</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">
                $
              </span>
              <Input
                id="invoice-amount"
                inputMode="decimal"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.00"
                className="h-12 pl-8 text-lg font-semibold tabular-nums"
                autoFocus
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invoice-number">Your invoice number</Label>
            <Input
              id="invoice-number"
              value={billNumber}
              onChange={(event) => setBillNumber(event.target.value)}
              placeholder="INV-001"
              className="h-12"
              required
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <DateField id="invoice-date" label="Invoice date" value={billDate} onChange={setBillDate} />
          <DateField
            id="invoice-due"
            label="Due date"
            value={dueDate}
            onChange={setDueDate}
            placeholder="Optional"
            clearable
          />
        </div>

        <div className="space-y-2">
          <Label>Invoice document</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFileSelect(file)
            }}
          />

          {uploadedFile ? (
            <Attachment state="done" className="w-full">
              <AttachmentMedia variant="icon">
                <FileText className="size-4" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{uploadedFile.name}</AttachmentTitle>
                <AttachmentDescription>{formatFileSize(uploadedFile.size)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions className="pr-1.5">
                <AttachmentAction onClick={removeFile} aria-label={`Remove ${uploadedFile.name}`}>
                  <X className="size-4" />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ) : uploadingName ? (
            <Attachment state="uploading" className="w-full">
              <AttachmentMedia variant="icon">
                <Loader2 className="size-4 animate-spin text-primary" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{uploadingName}</AttachmentTitle>
                <Progress value={uploadProgress} className="mt-1.5 h-1.5" />
              </AttachmentContent>
            </Attachment>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                setIsDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setIsDragging(false)
                const file = event.dataTransfer.files[0]
                if (file) void handleFileSelect(file)
              }}
              className={cn(
                "flex w-full items-center justify-center gap-2 border border-dashed bg-card px-3 py-5 text-sm text-muted-foreground transition-colors hover:bg-muted/50",
                isDragging && "border-primary bg-primary/5 text-foreground",
              )}
            >
              <Upload className="size-4" />
              Drag your invoice here, or choose a file
            </button>
          )}
        </div>

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown
              className={cn("size-4 transition-transform duration-150", detailsOpen && "rotate-180")}
            />
            Work period and notes
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField
                id="period-start"
                label="Period start"
                value={periodStart}
                onChange={setPeriodStart}
                placeholder="Optional"
                clearable
              />
              <DateField
                id="period-end"
                label="Period end"
                value={periodEnd}
                onChange={setPeriodEnd}
                placeholder="Optional"
                clearable
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invoice-description">What did you complete?</Label>
              <Textarea
                id="invoice-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Rough-in complete on units 4 through 9, including material delivered to site."
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Reviewers approve faster when they can match the amount to work they have seen.
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* The consequence of the amount, pinned where the eye already is before submitting. */}
      <div className="shrink-0 space-y-3 border-t border-border px-6 py-4">
        {isOverBudget ? (
          <p className="flex items-start gap-2 border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {formatMoneyCentsExact(Math.abs(remainingAfter))} over what is left on this contract.
              You can still submit — the builder will review the overage.
            </span>
          </p>
        ) : selectedCommitment ? (
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {amountCents > 0 ? "Left on this contract after" : "Left on this contract"}
            </span>
            <span className="font-medium tabular-nums">
              {formatMoneyCentsExact(amountCents > 0 ? remainingAfter : remainingCents)}
            </span>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Invoicing as {companyName}</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoneyCentsExact(amountCents)}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Submit
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

/**
 * Opens the form in place, so a sub never leaves the page they were reading to
 * bill against a contract they can still see.
 *
 * When compliance is blocking, the control stays focusable and clickable rather
 * than going `disabled` — a dead button gives no reason, and the reason is the
 * whole point.
 */
export function SubmitInvoiceButton({
  label = "Submit invoice",
  variant = "default",
  size = "sm",
  icon,
  complianceBlocked = false,
  ...props
}: Omit<SubInvoiceDialogProps, "open" | "onOpenChange"> & {
  label?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  icon?: ReactNode
  complianceBlocked?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [blockedOpen, setBlockedOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant={complianceBlocked ? "outline" : variant}
        size={size}
        aria-disabled={complianceBlocked || undefined}
        className={cn(complianceBlocked && "text-muted-foreground")}
        onClick={() => (complianceBlocked ? setBlockedOpen(true) : setOpen(true))}
      >
        {icon}
        {label}
      </Button>

      {complianceBlocked ? (
        <ComplianceBlockedDialog
          token={props.token}
          open={blockedOpen}
          onOpenChange={setBlockedOpen}
        />
      ) : (
        <SubInvoiceDialog {...props} open={open} onOpenChange={setOpen} />
      )}
    </>
  )
}

/** Explains why invoicing is closed and sends the reader where they can fix it. */
export function ComplianceBlockedDialog({
  token,
  open,
  onOpenChange,
}: {
  token: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Finish your compliance documents first"
      description="This builder holds payment until every required document is current, so invoices cannot be submitted yet."
    >
      <div className="space-y-4 px-6 py-5">
        <p className="flex items-start gap-2.5 border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Bring your insurance and paperwork up to date and this opens straight back up. It usually
            takes a few minutes once you have the certificate from your broker.
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Not now
        </Button>
        <Button asChild>
          <Link href={`/s/${token}/compliance`}>Go to compliance</Link>
        </Button>
      </div>
    </ResponsiveDialog>
  )
}
