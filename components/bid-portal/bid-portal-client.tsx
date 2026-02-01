"use client"

import { useMemo, useState, useTransition, type ReactNode } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import {
  Calendar,
  CheckCircle2,
  Download,
  FileText,
  Mail,
  Phone,
  Send,
  ShieldCheck,
  Sparkles,
  Timer,
  User,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  type BidPortalAccess,
  type BidPortalData,
  type BidPortalSubmission,
} from "@/lib/services/bid-portal"
import { acknowledgeBidAddendumAction, submitBidAction } from "@/app/b/[token]/actions"
import { BidPortalPinGate } from "@/components/bid-portal/bid-portal-pin-gate"

interface BidPortalClientProps {
  token: string
  access: BidPortalAccess
  data: BidPortalData
  pinRequired?: boolean
}

const statusStyles: Record<string, string> = {
  draft: "border-white/15 text-white/70",
  sent: "border-cyan-300/40 text-cyan-200 bg-cyan-400/10",
  open: "border-emerald-300/40 text-emerald-200 bg-emerald-400/10",
  closed: "border-white/20 text-white/60 bg-white/5",
  awarded: "border-amber-300/40 text-amber-200 bg-amber-400/10",
  cancelled: "border-rose-300/40 text-rose-200 bg-rose-400/10",
}

const disallowedStatuses = ["closed", "awarded", "cancelled"]

function formatFileSize(bytes?: number) {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCurrency(cents?: number | null) {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
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

function Panel({
  title,
  icon,
  children,
  className,
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm shadow-[0_0_0_1px_rgba(255,255,255,0.02)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-6 py-4 border-b border-white/10">
        {icon}
        <h2 className="text-sm uppercase tracking-[0.3em] text-white/60">{title}</h2>
      </div>
      <div className="px-6 py-5 space-y-4">{children}</div>
    </section>
  )
}

export function BidPortalClient({ token, access, data, pinRequired = false }: BidPortalClientProps) {
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const [submissionHistory, setSubmissionHistory] = useState(data.submissions)
  const [currentSubmission, setCurrentSubmission] = useState<BidPortalSubmission | undefined>(data.currentSubmission)
  const [isSubmitting, startSubmitting] = useTransition()
  const [isAcknowledging, startAcknowledging] = useTransition()
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)
  const [addenda, setAddenda] = useState(data.addenda)

  const [total, setTotal] = useState(() =>
    data.currentSubmission?.total_cents ? (data.currentSubmission.total_cents / 100).toFixed(2) : ""
  )
  const [validUntil, setValidUntil] = useState(data.currentSubmission?.valid_until ?? "")
  const [leadTime, setLeadTime] = useState(data.currentSubmission?.lead_time_days?.toString() ?? "")
  const [duration, setDuration] = useState(data.currentSubmission?.duration_days?.toString() ?? "")
  const [startAvailable, setStartAvailable] = useState(data.currentSubmission?.start_available_on ?? "")
  const [exclusions, setExclusions] = useState(data.currentSubmission?.exclusions ?? "")
  const [clarifications, setClarifications] = useState(data.currentSubmission?.clarifications ?? "")
  const [notes, setNotes] = useState(data.currentSubmission?.notes ?? "")
  const [submitterName, setSubmitterName] = useState(
    data.currentSubmission?.submitted_by_name ??
      access.invite.contact?.full_name ??
      ""
  )
  const [submitterEmail, setSubmitterEmail] = useState(
    data.currentSubmission?.submitted_by_email ??
      access.invite.contact?.email ??
      access.invite.invite_email ??
      ""
  )

  const dueDate = access.bidPackage.due_at ? new Date(access.bidPackage.due_at) : null
  const isPastDue = dueDate ? dueDate.getTime() < Date.now() : false
  const biddingClosed = disallowedStatuses.includes(access.bidPackage.status)
  const inviteInactive = ["declined", "withdrawn"].includes(access.invite.status)

  const submissionLabel = currentSubmission ? "Submit revised bid" : "Submit bid"

  const packageStatusLabel = useMemo(() => {
    const label = access.bidPackage.status.replaceAll("_", " ")
    return label.charAt(0).toUpperCase() + label.slice(1)
  }, [access.bidPackage.status])

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
          valid_until: validUntil || null,
          lead_time_days: leadTime ? Number(leadTime) : null,
          duration_days: duration ? Number(duration) : null,
          start_available_on: startAvailable || null,
          exclusions: exclusions.trim() || null,
          clarifications: clarifications.trim() || null,
          notes: notes.trim() || null,
          submitted_by_name: submitterName.trim(),
          submitted_by_email: submitterEmail.trim(),
        },
      })

      if (!result.success || !result.submission) {
        toast.error(result.error ?? "Failed to submit bid")
        return
      }

      setCurrentSubmission(result.submission)
      setSubmissionHistory((prev) => [
        { ...result.submission, is_current: true },
        ...prev.map((item) => ({ ...item, is_current: false })),
      ])
      toast.success("Bid submitted successfully")
    })
  }

  const handleAcknowledge = (addendumId: string) => {
    setAcknowledgingId(addendumId)
    startAcknowledging(async () => {
      const result = await acknowledgeBidAddendumAction({ token, addendumId })
      if (!result.success) {
        toast.error(result.error ?? "Failed to acknowledge addendum")
        setAcknowledgingId(null)
        return
      }
      setAddenda((prev) =>
        prev.map((addendum) =>
          addendum.id === addendumId
            ? { ...addendum, acknowledged_at: result.acknowledged_at ?? new Date().toISOString() }
            : addendum,
        ),
      )
      toast.success("Addendum acknowledged")
      setAcknowledgingId(null)
    })
  }

  if (!pinVerified) {
    return (
      <BidPortalPinGate
        token={token}
        orgName={access.org.name}
        projectName={access.project.name}
        packageTitle={access.bidPackage.title}
        onSuccess={() => setPinVerified(true)}
      />
    )
  }

  return (
    <div className="min-h-screen bg-[#0b0d11] text-white">
      <header className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,#1f2937_0%,transparent_55%),radial-gradient(circle_at_right,#064e3b_0%,transparent_50%)] opacity-80" />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-6 py-10">
          <div className="flex items-center gap-3 text-xs uppercase tracking-[0.4em] text-white/60">
            <Sparkles className="h-4 w-4 text-emerald-300/70" />
            {access.org.name}
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl md:text-4xl font-semibold font-serif">{access.bidPackage.title}</h1>
            <p className="text-sm text-white/70">Project • {access.project.name}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Badge
              variant="outline"
              className={cn("rounded-full px-3 py-1 text-xs", statusStyles[access.bidPackage.status] ?? "")}
            >
              {packageStatusLabel}
            </Badge>
            {access.bidPackage.trade && (
              <span className="rounded-full border border-white/15 px-3 py-1 text-white/70">
                Trade: {access.bidPackage.trade}
              </span>
            )}
            {dueDate && (
              <span className={cn(
                "rounded-full border border-white/15 px-3 py-1 text-white/70 flex items-center gap-2",
                isPastDue ? "border-rose-400/40 text-rose-200" : ""
              )}>
                <Calendar className="h-3.5 w-3.5" />
                Due {format(dueDate, "MMM d, h:mm a")}
              </span>
            )}
            {!dueDate && (
              <span className="rounded-full border border-white/15 px-3 py-1 text-white/60">No due date</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-10 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="space-y-6">
          <Panel title="Scope" icon={<ShieldCheck className="h-4 w-4 text-emerald-200" />}>
            <p className="text-sm leading-relaxed text-white/80 whitespace-pre-wrap">
              {access.bidPackage.scope || "Scope details will be shared here."}
            </p>
          </Panel>

          <Panel title="Instructions" icon={<Timer className="h-4 w-4 text-amber-200" />}>
            <p className="text-sm leading-relaxed text-white/75 whitespace-pre-wrap">
              {access.bidPackage.instructions || "Follow standard bid instructions. Reach out for clarifications."}
            </p>
          </Panel>

          <Panel title="Package Files" icon={<FileText className="h-4 w-4 text-cyan-200" />}>
            {data.packageFiles.length === 0 ? (
              <p className="text-sm text-white/60">No files attached yet.</p>
            ) : (
              <div className="space-y-3">
                {data.packageFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{file.file_name}</p>
                      <p className="text-xs text-white/50">
                        {formatFileSize(file.size_bytes)} • {format(new Date(file.created_at), "MMM d, yyyy")}
                      </p>
                    </div>
                    {file.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-white/70 hover:text-white hover:bg-white/10"
                        asChild
                      >
                        <a href={file.url} target="_blank" rel="noopener noreferrer">
                          <Download className="mr-2 h-4 w-4" />
                          Download
                        </a>
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Addenda" icon={<CheckCircle2 className="h-4 w-4 text-purple-200" />}>
            {addenda.length === 0 ? (
              <p className="text-sm text-white/60">No addenda issued yet.</p>
            ) : (
              <div className="space-y-4">
                {addenda.map((addendum) => (
                  <div key={addendum.id} className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">Addendum {addendum.number}</div>
                      <div className="flex items-center gap-2 text-xs text-white/50">
                        <span>{format(new Date(addendum.issued_at), "MMM d, yyyy")}</span>
                        {addendum.acknowledged_at && (
                          <Badge variant="outline" className="border-emerald-400/40 text-emerald-200">
                            Acknowledged
                          </Badge>
                        )}
                      </div>
                    </div>
                    {addendum.title && (
                      <div className="text-sm text-white/80">{addendum.title}</div>
                    )}
                    {addendum.message && (
                      <p className="text-sm text-white/70 whitespace-pre-wrap">{addendum.message}</p>
                    )}
                    {addendum.files.length > 0 && (
                      <div className="space-y-2">
                        {addendum.files.map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">{file.file_name}</p>
                              <p className="text-[11px] text-white/50">
                                {formatFileSize(file.size_bytes)}
                              </p>
                            </div>
                            {file.url && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-white/70 hover:text-white hover:bg-white/10"
                                asChild
                              >
                                <a href={file.url} target="_blank" rel="noopener noreferrer">
                                  <Download className="h-4 w-4" />
                                </a>
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {!addendum.acknowledged_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-white/20 text-white/80 hover:bg-white/10"
                        onClick={() => handleAcknowledge(addendum.id)}
                        disabled={isAcknowledging && acknowledgingId === addendum.id}
                      >
                        {isAcknowledging && acknowledgingId === addendum.id ? "Acknowledging..." : "Acknowledge"}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Submission History" icon={<CheckCircle2 className="h-4 w-4 text-emerald-200" />}>
            {submissionHistory.length === 0 ? (
              <p className="text-sm text-white/60">No submissions yet.</p>
            ) : (
              <div className="space-y-3">
                {submissionHistory.map((submission) => (
                  <div
                    key={submission.id}
                    className={cn(
                      "rounded-xl border px-4 py-3 flex flex-wrap items-center justify-between gap-3",
                      submission.is_current
                        ? "border-emerald-400/40 bg-emerald-400/10"
                        : "border-white/10 bg-white/5",
                    )}
                  >
                    <div>
                      <p className="text-sm font-medium">
                        Version {submission.version} • {submission.status.replaceAll("_", " ")}
                      </p>
                      <p className="text-xs text-white/50">
                        {submission.submitted_at
                          ? `Submitted ${format(new Date(submission.submitted_at), "MMM d, yyyy")}`
                          : "Not yet submitted"}
                      </p>
                    </div>
                    <div className="text-sm font-semibold">{formatCurrency(submission.total_cents)}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel title="Invite Summary" icon={<User className="h-4 w-4 text-white/70" />}>
            <div className="space-y-3 text-sm text-white/70">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-white/50" />
                <span>{access.invite.company?.name ?? "Vendor"}</span>
              </div>
              {access.invite.contact?.full_name && (
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-white/40" />
                  <span>{access.invite.contact.full_name}</span>
                </div>
              )}
              {(access.invite.contact?.email || access.invite.invite_email) && (
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-white/40" />
                  <span>{access.invite.contact?.email ?? access.invite.invite_email}</span>
                </div>
              )}
              {access.invite.contact?.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-white/40" />
                  <span>{access.invite.contact.phone}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="rounded-full border-white/15 text-white/60">
                  Invite status: {access.invite.status.replaceAll("_", " ")}
                </Badge>
              </div>
              {currentSubmission?.submitted_at && (
                <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
                  Latest submission received on {format(new Date(currentSubmission.submitted_at), "MMM d, yyyy")}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Submit Your Bid" icon={<Send className="h-4 w-4 text-emerald-200" />}>
            {biddingClosed || inviteInactive ? (
              <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                This bid package is no longer accepting submissions.
              </div>
            ) : (
              <div className="space-y-4">
                {isPastDue && (
                  <div className="rounded-xl border border-amber-300/40 bg-amber-400/10 px-4 py-3 text-xs text-amber-100">
                    This bid is past due. Submissions may be reviewed at the builder's discretion.
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.25em] text-white/50">Total price</label>
                  <Input
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    placeholder="0.00"
                    className="bg-white/5 border-white/10 text-white"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Valid until</label>
                    <Input
                      type="date"
                      value={validUntil}
                      onChange={(e) => setValidUntil(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Start available</label>
                    <Input
                      type="date"
                      value={startAvailable}
                      onChange={(e) => setStartAvailable(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Lead time (days)</label>
                    <Input
                      type="number"
                      value={leadTime}
                      onChange={(e) => setLeadTime(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Duration (days)</label>
                    <Input
                      type="number"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Your name</label>
                    <Input
                      value={submitterName}
                      onChange={(e) => setSubmitterName(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-[0.25em] text-white/50">Your email</label>
                    <Input
                      value={submitterEmail}
                      onChange={(e) => setSubmitterEmail(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.25em] text-white/50">Exclusions</label>
                  <Textarea
                    value={exclusions}
                    onChange={(e) => setExclusions(e.target.value)}
                    rows={3}
                    className="bg-white/5 border-white/10 text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.25em] text-white/50">Clarifications</label>
                  <Textarea
                    value={clarifications}
                    onChange={(e) => setClarifications(e.target.value)}
                    rows={3}
                    className="bg-white/5 border-white/10 text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.25em] text-white/50">Notes</label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="bg-white/5 border-white/10 text-white"
                  />
                </div>
                <Button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                >
                  <Send className="mr-2 h-4 w-4" />
                  {isSubmitting ? "Submitting..." : submissionLabel}
                </Button>
              </div>
            )}
          </Panel>
        </aside>
      </main>
    </div>
  )
}
