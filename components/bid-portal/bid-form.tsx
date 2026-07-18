"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import {
  AlertTriangle,
  CalendarIcon,
  CheckCircle2,
  Clock,
  FileText,
  History,
  Loader2,
  Mail,
  Send,
  ShieldCheck,
  Upload,
  User,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import type {
  BidPortalAccess,
  BidPortalAddendum,
  BidPortalScopeItem,
  BidPortalSubmission,
} from "@/lib/services/bid-portal"
import {
  acknowledgeBidAddendumAction,
  declineBidAction,
  submitBidAction,
  saveBidDraftAction,
  uploadBidFileAction,
  withdrawBidAction,
} from "@/app/b/[token]/actions"
import {
  centsToInput,
  disallowedBidStatuses,
  formatCurrency,
  formatCurrencyInput,
  formatFileSize,
  parseCurrencyToCents,
} from "@/components/bid-portal/lib"

interface UploadedFile {
  id: string
  name: string
  size?: number
  isBond?: boolean
}

interface LineState {
  // "priced" = an amount/rate is entered; "excluded" = deliberately not priced.
  // Alternates use "priced" when a price is entered, otherwise "no_bid".
  excluded: boolean
  amountInput: string
  unitRateInput: string
  quantityInput: string
  note: string
}

interface BidFormProps {
  token: string
  access: BidPortalAccess
  scopeItems: BidPortalScopeItem[]
  currentSubmission?: BidPortalSubmission
  submissions: BidPortalSubmission[]
  addenda: BidPortalAddendum[]
  draft: Record<string, unknown> | null
  onSubmissionChange?: (submission: BidPortalSubmission) => void
  onAddendaChange?: (addenda: BidPortalAddendum[]) => void
}

const ALLOWED_UPLOAD_TYPES = [
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

const GROUP_ORDER: { type: BidPortalScopeItem["item_type"]; label: string }[] = [
  { type: "base", label: "Base bid" },
  { type: "unit_price", label: "Unit prices" },
  { type: "allowance", label: "Allowances" },
  { type: "alternate", label: "Alternates" },
]

function emptyLine(scopeItem: BidPortalScopeItem): LineState {
  return {
    excluded: false,
    amountInput: "",
    unitRateInput: "",
    quantityInput: scopeItem.quantity != null ? String(scopeItem.quantity) : "",
    note: "",
  }
}

function lineAmountCents(scopeItem: BidPortalScopeItem, line: LineState): number | null {
  if (scopeItem.item_type === "unit_price") {
    const rate = parseCurrencyToCents(line.unitRateInput)
    const qty = Number(line.quantityInput)
    if (rate == null || !line.quantityInput || Number.isNaN(qty)) return null
    return Math.round(rate * qty)
  }
  return parseCurrencyToCents(line.amountInput)
}

function relativeSavedLabel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff) || diff < 0) return "just now"
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function BidForm({
  token,
  access,
  scopeItems,
  currentSubmission: initialSubmission,
  submissions: initialSubmissions,
  addenda,
  draft,
  onSubmissionChange,
  onAddendaChange,
}: BidFormProps) {
  const isTender = scopeItems.length > 0
  const draftPayload = draft as Record<string, any> | null

  const [currentSubmission, setCurrentSubmission] = useState(initialSubmission)
  const [submissions, setSubmissions] = useState(initialSubmissions)
  const [isSubmitting, startSubmitting] = useTransition()
  const [isDeclining, startDeclining] = useTransition()
  const [isWithdrawing, startWithdrawing] = useTransition()
  const [declined, setDeclined] = useState(access.invite.status === "declined")
  const [withdrawn, setWithdrawn] = useState(access.invite.status === "withdrawn")
  const [declineReason, setDeclineReason] = useState("")
  const [withdrawReason, setWithdrawReason] = useState("")
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  // ---- Quote-mode lump sum ----
  const [total, setTotal] = useState<string>(
    () => draftPayload?.total ?? centsToInput(initialSubmission?.total_cents)
  )

  // ---- Common fields ----
  const [validUntil, setValidUntil] = useState<Date | undefined>(() => {
    const raw = draftPayload?.validUntil ?? initialSubmission?.valid_until
    return raw ? new Date(raw) : undefined
  })
  const [validUntilOpen, setValidUntilOpen] = useState(false)
  const [leadTime, setLeadTime] = useState<string>(
    () => draftPayload?.leadTime ?? initialSubmission?.lead_time_days?.toString() ?? ""
  )
  const [duration, setDuration] = useState<string>(
    () => draftPayload?.duration ?? initialSubmission?.duration_days?.toString() ?? ""
  )
  const [startAvailable, setStartAvailable] = useState<Date | undefined>(() => {
    const raw = draftPayload?.startAvailable ?? initialSubmission?.start_available_on
    return raw ? new Date(raw) : undefined
  })
  const [startAvailableOpen, setStartAvailableOpen] = useState(false)
  const [exclusions, setExclusions] = useState<string>(
    () => draftPayload?.exclusions ?? initialSubmission?.exclusions ?? ""
  )
  const [clarifications, setClarifications] = useState<string>(
    () => draftPayload?.clarifications ?? initialSubmission?.clarifications ?? ""
  )
  const [notes, setNotes] = useState<string>(
    () => draftPayload?.notes ?? initialSubmission?.notes ?? ""
  )
  const [submitterName, setSubmitterName] = useState<string>(
    () =>
      draftPayload?.submitterName ??
      initialSubmission?.submitted_by_name ??
      access.invite.contact?.full_name ??
      ""
  )
  const [submitterEmail, setSubmitterEmail] = useState<string>(
    () =>
      draftPayload?.submitterEmail ??
      initialSubmission?.submitted_by_email ??
      access.invite.contact?.email ??
      access.invite.invite_email ??
      ""
  )

  // ---- Per-line tender state ----
  const [lines, setLines] = useState<Record<string, LineState>>(() => {
    const initial: Record<string, LineState> = {}
    const savedLines = (draftPayload?.lines ?? null) as Record<string, LineState> | null
    for (const item of scopeItems) {
      initial[item.id] = savedLines?.[item.id] ?? emptyLine(item)
    }
    return initial
  })

  const updateLine = useCallback((id: string, patch: Partial<LineState>) => {
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  // ---- Attachments ----
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadingBond, setUploadingBond] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bondInputRef = useRef<HTMLInputElement>(null)

  const dueDate = access.bidPackage.due_at ? new Date(access.bidPackage.due_at) : null
  const isPastDue = dueDate ? dueDate.getTime() < Date.now() : false
  const biddingClosed = disallowedBidStatuses.includes(access.bidPackage.status)
  const inviteInactive = declined || withdrawn || ["declined", "withdrawn"].includes(access.invite.status)
  const unacknowledgedAddenda = useMemo(
    () => addenda.filter((a) => !a.acknowledged_at),
    [addenda]
  )
  const hasUnacknowledgedAddenda = unacknowledgedAddenda.length > 0
  const bondRequired = access.bidPackage.bond_required
  const hasBond = uploadedFiles.some((f) => f.isBond)
  const canSubmit = !biddingClosed && !inviteInactive

  // ---- Computed tender totals ----
  const { baseTotalCents, alternatesTotalCents } = useMemo(() => {
    if (!isTender) return { baseTotalCents: 0, alternatesTotalCents: 0 }
    let base = 0
    let alt = 0
    for (const item of scopeItems) {
      const line = lines[item.id]
      if (!line || line.excluded) continue
      const amount = lineAmountCents(item, line)
      if (amount == null || amount < 0) continue
      if (item.item_type === "alternate") alt += amount
      else base += amount
    }
    return { baseTotalCents: base, alternatesTotalCents: alt }
  }, [isTender, lines, scopeItems])

  // ---- Autosave draft (debounced) ----
  const submittedRef = useRef(false)
  const hydratedRef = useRef(false)
  const [savedAt, setSavedAt] = useState<string | null>(
    () => (typeof draftPayload?._savedAt === "string" ? draftPayload._savedAt : null)
  )
  const [draftRestored] = useState(() => Boolean(draftPayload))

  const draftState = useMemo(
    () => ({
      total,
      validUntil: validUntil ? format(validUntil, "yyyy-MM-dd") : null,
      leadTime,
      duration,
      startAvailable: startAvailable ? format(startAvailable, "yyyy-MM-dd") : null,
      exclusions,
      clarifications,
      notes,
      submitterName,
      submitterEmail,
      lines,
    }),
    [
      total,
      validUntil,
      leadTime,
      duration,
      startAvailable,
      exclusions,
      clarifications,
      notes,
      submitterName,
      submitterEmail,
      lines,
    ]
  )

  useEffect(() => {
    if (!hydratedRef.current) {
      // Skip the initial render — nothing to save until the sub edits.
      hydratedRef.current = true
      return
    }
    if (submittedRef.current || !canSubmit) return
    const handle = setTimeout(() => {
      const savedTs = new Date().toISOString()
      void saveBidDraftAction({
        token,
        input: { payload: { ...draftState, _savedAt: savedTs } },
      }).then((result) => {
        if (result.success) setSavedAt(savedTs)
      })
    }, 1500)
    return () => clearTimeout(handle)
  }, [draftState, token, canSubmit])

  // ---- Addenda acknowledge (inline) ----
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)
  const handleAcknowledge = useCallback(
    (addendumId: string) => {
      setAcknowledgingId(addendumId)
      void acknowledgeBidAddendumAction({ token, addendumId }).then((result) => {
        setAcknowledgingId(null)
        if (!result.success) {
          toast.error(result.error ?? "Failed to acknowledge addendum")
          return
        }
        const updated = addenda.map((item) =>
          item.id === addendumId
            ? { ...item, acknowledged_at: result.acknowledged_at ?? new Date().toISOString() }
            : item
        )
        onAddendaChange?.(updated)
      })
    },
    [addenda, onAddendaChange, token]
  )

  // ---- File upload ----
  const uploadFile = useCallback(
    async (file: File, asBond: boolean) => {
      if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
        toast.error("Please upload a PDF, image, Word, or Excel file")
        return
      }
      if (file.size > 25 * 1024 * 1024) {
        toast.error("File size must be less than 25MB")
        return
      }

      if (asBond) setUploadingBond(true)
      else setIsUploading(true)

      try {
        const formData = new FormData()
        formData.append("file", file)
        const result = await uploadBidFileAction({ token, formData })
        if (result.success && result.fileId) {
          setUploadedFiles((prev) => [
            ...prev,
            { id: result.fileId!, name: result.fileName ?? file.name, size: file.size, isBond: asBond },
          ])
        } else {
          toast.error(result.error ?? "Failed to upload file")
        }
      } catch {
        toast.error("Failed to upload file")
      } finally {
        if (asBond) setUploadingBond(false)
        else setIsUploading(false)
      }
    },
    [token]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) void uploadFile(file, false)
    },
    [uploadFile]
  )

  const removeFile = useCallback((fileId: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  // ---- Submit ----
  const handleSubmit = () => {
    if (hasUnacknowledgedAddenda) {
      toast.error("Acknowledge outstanding addenda before submitting")
      return
    }
    if (bondRequired && !hasBond) {
      toast.error("A bid bond is required. Upload it before submitting.")
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

    let totalCents: number
    let items: Array<Record<string, unknown>> | undefined

    if (isTender) {
      // Validate every required (base + allowance) line has a response.
      const built: Array<Record<string, unknown>> = []
      for (const item of scopeItems) {
        const line = lines[item.id]
        if (!line) continue
        const required = item.item_type === "base" || item.item_type === "allowance"

        if (line.excluded) {
          if (item.item_type !== "alternate") {
            built.push({ bid_scope_item_id: item.id, response: "excluded", notes: line.note.trim() || null })
          }
          continue
        }

        const amount = lineAmountCents(item, line)
        const hasEntry =
          item.item_type === "unit_price"
            ? Boolean(line.unitRateInput.trim()) && Boolean(line.quantityInput.trim())
            : Boolean(line.amountInput.trim())

        if (required && !hasEntry) {
          toast.error(`Enter a price for "${item.description}" or mark it excluded`)
          return
        }
        if (!hasEntry) {
          // Optional line (alternate / unit price) left blank → no bid.
          built.push({ bid_scope_item_id: item.id, response: "no_bid", notes: line.note.trim() || null })
          continue
        }
        if (amount == null || amount < 0) {
          toast.error(`Enter a valid price for "${item.description}"`)
          return
        }
        built.push({
          bid_scope_item_id: item.id,
          response: "priced",
          amount_cents: item.item_type === "unit_price" ? null : amount,
          unit_rate_cents:
            item.item_type === "unit_price" ? parseCurrencyToCents(line.unitRateInput) : null,
          quantity: item.item_type === "unit_price" ? Number(line.quantityInput) : null,
          notes: line.note.trim() || null,
        })
      }
      totalCents = baseTotalCents
      items = built
      if (totalCents <= 0) {
        toast.error("Price at least one base or allowance line before submitting")
        return
      }
    } else {
      const cents = parseCurrencyToCents(total)
      if (!cents || cents <= 0) {
        toast.error("Enter a valid total amount")
        return
      }
      totalCents = cents
    }

    startSubmitting(async () => {
      const result = await submitBidAction({
        token,
        input: {
          total_cents: totalCents,
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
          ...(items ? { items } : {}),
        },
      })

      if (!result.success || !result.submission) {
        toast.error(result.error ?? "Failed to submit bid")
        return
      }

      submittedRef.current = true
      setSavedAt(null)
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

  const handleDecline = () => {
    startDeclining(async () => {
      const result = await declineBidAction({ token, reason: declineReason.trim() || null })
      if (!result.success) {
        toast.error(result.error ?? "Failed to decline bid")
        return
      }
      setDeclined(true)
      toast.success("No-bid response sent")
    })
  }

  const handleWithdraw = () => {
    startWithdrawing(async () => {
      const result = await withdrawBidAction({ token, reason: withdrawReason.trim() || null })
      if (!result.success) {
        toast.error(result.error ?? "Failed to withdraw bid")
        return
      }
      setWithdrawn(true)
      setWithdrawOpen(false)
      toast.success("Bid withdrawn")
    })
  }

  const submissionLabel = currentSubmission ? "Submit Revised Bid" : "Submit Bid"
  const submitEmailForReceipt = submitterEmail.trim() || access.invite.invite_email || ""

  return (
    <div className="space-y-4">
      {/* Withdrawn state */}
      {withdrawn ? (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div>
                <p className="text-sm font-medium">You withdrew your bid</p>
                <p className="text-sm text-muted-foreground">
                  Your invitation is no longer active. To bid again, contact the builder for a fresh
                  invitation.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Success confirmation */}
      {currentSubmission && !withdrawn ? (
        <Card className="border-success/40 bg-success/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Bid submitted</p>
                <p className="text-sm text-muted-foreground">
                  Version {currentSubmission.version} · {formatCurrency(currentSubmission.total_cents)}
                  {currentSubmission.submitted_at
                    ? ` · ${format(new Date(currentSubmission.submitted_at), "MMM d, yyyy 'at' h:mm a")}`
                    : ""}
                </p>
                {submitEmailForReceipt ? (
                  <p className="text-xs text-muted-foreground">
                    A receipt was emailed to {submitEmailForReceipt}.
                  </p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Blocking states */}
      {!canSubmit && !withdrawn ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium">
                  {inviteInactive ? "No bid recorded" : "Bidding closed"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {inviteInactive
                    ? "Your no-bid response has been sent to the builder."
                    : "This bid package is no longer accepting submissions."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Past-due notice */}
      {canSubmit && isPastDue ? (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div>
                <p className="text-sm font-medium">Past due</p>
                <p className="text-sm text-muted-foreground">
                  This bid is past due. Submissions may be reviewed at the builder&apos;s discretion.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Addenda gating */}
      {canSubmit && hasUnacknowledgedAddenda ? (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Acknowledge addenda to continue</CardTitle>
            <CardDescription>
              You must acknowledge every addendum before your bid can be submitted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {unacknowledgedAddenda.map((addendum) => (
              <label
                key={addendum.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/60 p-3"
              >
                <Checkbox
                  checked={false}
                  disabled={acknowledgingId === addendum.id}
                  onCheckedChange={() => handleAcknowledge(addendum.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    Addendum {addendum.number}
                    {addendum.title ? ` — ${addendum.title}` : ""}
                  </p>
                  {addendum.message ? (
                    <p className="text-muted-foreground line-clamp-2">{addendum.message}</p>
                  ) : null}
                </div>
              </label>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Form */}
      {canSubmit && !withdrawn ? (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {currentSubmission ? "Revise your bid" : "Submit your bid"}
                </CardTitle>
                <CardDescription>
                  {isTender
                    ? "Price the schedule of items below. The total is calculated for you."
                    : "Enter your lump-sum price and the details below."}
                </CardDescription>
              </div>
              {draftRestored && savedAt ? (
                <p className="shrink-0 text-xs text-muted-foreground">
                  Draft restored · saved {relativeSavedLabel(savedAt)}
                </p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {isTender ? (
              <TenderSchedule
                scopeItems={scopeItems}
                lines={lines}
                updateLine={updateLine}
                baseTotalCents={baseTotalCents}
                alternatesTotalCents={alternatesTotalCents}
              />
            ) : (
              <div className="space-y-2">
                <Label htmlFor="total">
                  Total price <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-medium text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="total"
                    value={total}
                    onChange={(e) => setTotal(formatCurrencyInput(e.target.value))}
                    placeholder="0.00"
                    className="h-12 pl-7 text-lg font-semibold tabular-nums"
                    inputMode="decimal"
                  />
                </div>
                <p className="text-xs text-muted-foreground">Enter your total bid amount in USD.</p>
              </div>
            )}

            {/* Schedule & timing */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Clock className="h-4 w-4" />
                Schedule &amp; timing
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <DateField
                  label="Bid valid until"
                  value={validUntil}
                  open={validUntilOpen}
                  onOpenChange={setValidUntilOpen}
                  onSelect={setValidUntil}
                  hint="How long is this quote valid?"
                />
                <DateField
                  label="Start available"
                  value={startAvailable}
                  open={startAvailableOpen}
                  onOpenChange={setStartAvailableOpen}
                  onSelect={setStartAvailable}
                  disablePast
                  hint="Earliest date you can begin work"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="leadTime">Lead time</Label>
                  <div className="relative">
                    <Input
                      id="leadTime"
                      type="number"
                      min="0"
                      value={leadTime}
                      onChange={(e) => setLeadTime(e.target.value)}
                      placeholder="0"
                      className="pr-14 tabular-nums"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      days
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">Time needed to procure materials</p>
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
                      className="pr-14 tabular-nums"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      days
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">Estimated time to complete work</p>
                </div>
              </div>
            </div>

            {/* Contact */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <User className="h-4 w-4" />
                Contact information
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="submitterName">
                    Your name <span className="text-destructive">*</span>
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
                    Your email <span className="text-destructive">*</span>
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

            {/* Details */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <FileText className="h-4 w-4" />
                Bid details
              </div>
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
              <div className="space-y-2">
                <Label htmlFor="notes">Additional notes</Label>
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

            {/* Bid bond (required) */}
            {bondRequired ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  Bid bond <span className="text-destructive">*</span>
                </div>
                {hasBond ? (
                  uploadedFiles
                    .filter((f) => f.isBond)
                    .map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 rounded-md border border-success/30 bg-success/5 p-3"
                      >
                        <ShieldCheck className="h-5 w-5 shrink-0 text-success" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{file.name}</p>
                          {file.size ? (
                            <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                          ) : null}
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
                    ))
                ) : (
                  <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
                    <p className="text-sm text-muted-foreground">
                      This package requires a bid bond. Upload it to enable submission.
                    </p>
                    <input
                      ref={bondInputRef}
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void uploadFile(file, true)
                        e.target.value = ""
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={uploadingBond}
                      onClick={() => bondInputRef.current?.click()}
                    >
                      {uploadingBond ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-4 w-4" />
                      )}
                      Upload bid bond
                    </Button>
                  </div>
                )}
              </div>
            ) : null}

            {/* Attachments */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Upload className="h-4 w-4" />
                Attachments
              </div>

              {uploadedFiles.filter((f) => !f.isBond).length > 0 ? (
                <div className="space-y-2">
                  {uploadedFiles
                    .filter((f) => !f.isBond)
                    .map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 rounded-md border bg-muted/30 p-3"
                      >
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
                          <FileText className="h-5 w-5 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{file.name}</p>
                          {file.size ? (
                            <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                          ) : null}
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
              ) : null}

              {isUploading ? (
                <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Uploading…</p>
                </div>
              ) : null}

              <div
                onDrop={handleDrop}
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragging(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setIsDragging(false)
                }}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed p-8 transition-colors",
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/30"
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void uploadFile(file, false)
                    e.target.value = ""
                  }}
                />
                <div
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-full transition-colors",
                    isDragging ? "bg-primary/20" : "bg-muted"
                  )}
                >
                  <Upload
                    className={cn("h-6 w-6", isDragging ? "text-primary" : "text-muted-foreground")}
                  />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">
                    {isDragging ? "Drop file here" : "Drag & drop or click to upload"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    PDF, Word, Excel, or images up to 25MB
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Upload your detailed proposal, cost breakdown, or any supporting documents.
              </p>
            </div>

            {/* Submit */}
            <div className="space-y-3 pt-2">
              <Button
                className="h-12 w-full text-base font-medium"
                size="lg"
                onClick={handleSubmit}
                disabled={
                  isSubmitting ||
                  isUploading ||
                  uploadingBond ||
                  hasUnacknowledgedAddenda ||
                  (bondRequired && !hasBond)
                }
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-5 w-5" />
                    {submissionLabel}
                  </>
                )}
              </Button>

              {bondRequired && !hasBond ? (
                <p className="text-center text-xs text-warning">
                  A bid bond is required before you can submit.
                </p>
              ) : null}

              {!currentSubmission && !declined ? (
                <div className="rounded-md border p-3">
                  <div className="space-y-2">
                    <Label htmlFor="declineReason">Decline to bid</Label>
                    <Textarea
                      id="declineReason"
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      rows={2}
                      placeholder="Optional reason"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={handleDecline}
                      disabled={isDeclining}
                    >
                      {isDeclining ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Send no-bid
                    </Button>
                  </div>
                </div>
              ) : null}

              {currentSubmission ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive"
                  onClick={() => setWithdrawOpen(true)}
                >
                  Withdraw bid
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Submission history */}
      {submissions.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Submission history</CardTitle>
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
                  "rounded-md border px-4 py-4 transition-colors",
                  submission.is_current
                    ? "border-success/40 bg-success/5"
                    : "bg-muted/30 hover:bg-muted/50"
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        submission.is_current ? "bg-success/15" : "bg-muted"
                      )}
                    >
                      {submission.is_current ? (
                        <CheckCircle2 className="h-5 w-5 text-success" />
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground">
                          v{submission.version}
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">Version {submission.version}</p>
                        {submission.is_current ? (
                          <Badge
                            variant="outline"
                            className="border-success/30 bg-success/10 text-xs text-success"
                          >
                            Current
                          </Badge>
                        ) : null}
                        {index === 0 && !submission.is_current ? (
                          <Badge variant="secondary" className="text-xs">
                            Latest
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
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
                    {submission.valid_until ? (
                      <p className="text-xs text-muted-foreground">
                        Valid until {format(new Date(submission.valid_until), "MMM d, yyyy")}
                      </p>
                    ) : null}
                  </div>
                </div>
                {submission.items && submission.items.length > 0 ? (
                  <div className="mt-3 space-y-1 border-t pt-3">
                    {submission.items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate text-muted-foreground">{item.description}</span>
                        <span className="shrink-0 tabular-nums">
                          {item.response === "priced"
                            ? formatCurrency(item.amount_cents)
                            : item.response === "excluded"
                              ? "Excluded"
                              : "No bid"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw your bid?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your bid from consideration and deactivates your invitation. You will not
              be able to submit again unless the builder sends a new invitation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="withdrawReason">Reason (optional)</Label>
            <Textarea
              id="withdrawReason"
              value={withdrawReason}
              onChange={(e) => setWithdrawReason(e.target.value)}
              rows={2}
              placeholder="Let the builder know why"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isWithdrawing}>Keep bid</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleWithdraw()
              }}
              disabled={isWithdrawing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isWithdrawing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Withdraw bid
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface DateFieldProps {
  label: string
  value: Date | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (date: Date | undefined) => void
  disablePast?: boolean
  hint?: string
}

function DateField({ label, value, open, onOpenChange, onSelect, disablePast, hint }: DateFieldProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !value && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {value ? format(value, "MMM d, yyyy") : "Select date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(date) => {
              onSelect(date)
              onOpenChange(false)
            }}
            disabled={disablePast ? (date) => date < new Date() : undefined}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

interface TenderScheduleProps {
  scopeItems: BidPortalScopeItem[]
  lines: Record<string, LineState>
  updateLine: (id: string, patch: Partial<LineState>) => void
  baseTotalCents: number
  alternatesTotalCents: number
}

function TenderSchedule({
  scopeItems,
  lines,
  updateLine,
  baseTotalCents,
  alternatesTotalCents,
}: TenderScheduleProps) {
  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      ...group,
      items: scopeItems.filter((item) => item.item_type === group.type),
    })).filter((group) => group.items.length > 0)
  }, [scopeItems])

  return (
    <div className="space-y-6">
      {grouped.map((group) => (
        <div key={group.type} className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            {group.type !== "base" ? (
              <span className="text-[11px] text-muted-foreground">
                {group.type === "alternate" ? "Optional" : ""}
              </span>
            ) : null}
          </div>
          <div className="divide-y rounded-md border">
            {group.items.map((item) => (
              <ScheduleRow
                key={item.id}
                item={item}
                line={lines[item.id]}
                onChange={(patch) => updateLine(item.id, patch)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Totals */}
      <div className="sticky bottom-0 space-y-1 rounded-md border bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Base bid total</span>
          <span className="text-lg font-semibold tabular-nums">{formatCurrency(baseTotalCents)}</span>
        </div>
        {alternatesTotalCents > 0 ? (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Alternates (if accepted)</span>
            <span className="tabular-nums">+{formatCurrency(alternatesTotalCents)}</span>
          </div>
        ) : null}
        <p className="pt-1 text-xs text-muted-foreground">
          Total is calculated from your priced base and allowance lines.
        </p>
      </div>
    </div>
  )
}

interface ScheduleRowProps {
  item: BidPortalScopeItem
  line: LineState
  onChange: (patch: Partial<LineState>) => void
}

function ScheduleRow({ item, line, onChange }: ScheduleRowProps) {
  const isAlternate = item.item_type === "alternate"
  const isUnitPrice = item.item_type === "unit_price"
  const computed = lineAmountCents(item, line)

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">{item.description}</p>
          {item.details ? <p className="text-xs text-muted-foreground">{item.details}</p> : null}
          {item.quantity != null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {item.quantity}
              {item.unit ? ` ${item.unit}` : ""}
            </p>
          ) : null}
        </div>

        {!isAlternate ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={line.excluded}
              onCheckedChange={(checked) => onChange({ excluded: checked === true })}
            />
            Exclude
          </label>
        ) : null}
      </div>

      {!line.excluded ? (
        <div className="space-y-2">
          {isUnitPrice ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  value={line.unitRateInput}
                  onChange={(e) => onChange({ unitRateInput: formatCurrencyInput(e.target.value) })}
                  placeholder="Unit rate"
                  className="pl-6 tabular-nums"
                  inputMode="decimal"
                />
              </div>
              <div className="relative">
                <Input
                  value={line.quantityInput}
                  onChange={(e) => onChange({ quantityInput: e.target.value })}
                  placeholder="Qty"
                  className="tabular-nums"
                  inputMode="decimal"
                />
                {item.unit ? (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    {item.unit}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center justify-end rounded-md border bg-muted/30 px-3 text-sm tabular-nums">
                {formatCurrency(computed)}
              </div>
            </div>
          ) : (
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                value={line.amountInput}
                onChange={(e) => onChange({ amountInput: formatCurrencyInput(e.target.value) })}
                placeholder={isAlternate ? "Price (optional)" : "Price"}
                className="pl-6 tabular-nums"
                inputMode="decimal"
              />
            </div>
          )}
          <Input
            value={line.note}
            onChange={(e) => onChange({ note: e.target.value })}
            placeholder="Line note (optional)"
            className="h-8 text-xs"
          />
        </div>
      ) : null}
    </div>
  )
}
