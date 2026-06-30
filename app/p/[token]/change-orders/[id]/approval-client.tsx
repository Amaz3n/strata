"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder } from "@/lib/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { QuotePortalShell, type PortalStatusTone } from "@/components/portal/quote-portal-shell"
import { SignatureCapture } from "@/app/d/[token]/components/signature-capture"
import {
  CheckCircle2,
  Clock,
  MessageSquare,
  PenLine,
  Send,
  X,
} from "@/components/icons"
import { approveChangeOrderInPortalAction, requestChangeOrderChangesAction } from "./actions"

interface Props {
  token: string
  changeOrder: ChangeOrder & { requires_signature?: boolean | null }
  org?: {
    name?: string | null
    logoUrl?: string | null
    address?: Record<string, any> | null
  } | null
  project?: {
    name?: string | null
    location?: Record<string, any> | null
  } | null
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

const STATUS_META: Record<string, { label: string; tone: PortalStatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Awaiting review", tone: "info" },
  sent: { label: "Awaiting review", tone: "info" },
  requested_changes: { label: "Changes requested", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  cancelled: { label: "Cancelled", tone: "danger" },
}

function formatDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return format(date, "MMM d, yyyy")
}

function formatAddress(address?: Record<string, any> | null) {
  if (!address) return null
  const lines = [
    address.addressLine1 ?? address.line1 ?? address.street,
    address.addressLine2 ?? address.line2,
    [address.city, address.state, address.postalCode ?? address.postal_code].filter(Boolean).join(", "),
    address.country,
  ]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean)
  return lines.length > 0 ? lines.join("\n") : null
}

function lineAmount(line: NonNullable<ChangeOrder["lines"]>[number]) {
  return Math.round((line.quantity ?? 1) * (line.unit_cost_cents ?? 0) + (line.allowance_cents ?? 0))
}

function StatusNotice({ changeOrder }: { changeOrder: ChangeOrder }) {
  if (changeOrder.status === "approved") {
    return (
      <div className="flex items-start gap-2.5 border border-emerald-500/30 bg-emerald-500/5 p-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div className="text-sm">
          <p className="font-semibold text-emerald-700">Approved</p>
          <p className="text-muted-foreground">
            {changeOrder.approved_at ? `Approved on ${formatDate(changeOrder.approved_at)}` : "This change order is complete."}
          </p>
        </div>
      </div>
    )
  }

  if (changeOrder.status === "requested_changes") {
    return (
      <div className="flex items-start gap-2.5 border border-amber-500/30 bg-amber-500/5 p-3">
        <MessageSquare className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="text-sm">
          <p className="font-semibold text-amber-700">Changes requested</p>
          <p className="text-muted-foreground">Your builder has the note and can revise this change order.</p>
        </div>
      </div>
    )
  }

  return null
}

function ChangeOrderDocumentView({
  changeOrder,
  org,
  project,
}: {
  changeOrder: ChangeOrder
  org?: Props["org"]
  project?: Props["project"]
}) {
  const projectAddress = formatAddress(project?.location)
  const lines = changeOrder.lines ?? []
  const totals = changeOrder.totals
  const issued = formatDate(changeOrder.created_at)
  const intro = typeof changeOrder.metadata?.intro === "string" ? changeOrder.metadata.intro : null
  const terms = typeof changeOrder.metadata?.terms === "string" ? changeOrder.metadata.terms : null
  const pricingDisplay = changeOrder.metadata?.display?.pricing
  const showAmounts = pricingDisplay !== "lump_sum"
  const showUnitLine = pricingDisplay !== "subtotals" && pricingDisplay !== "lump_sum"

  return (
    <div className="flex h-[60vh] min-h-[460px] flex-col overflow-hidden border bg-card shadow-sm lg:h-[calc(100dvh-9rem)]">
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-8 sm:px-12 sm:py-10">
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              {org?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={org.logoUrl} alt={org.name ?? "Logo"} className="h-11 w-11 border object-contain" />
              ) : (
                <div className="flex h-11 w-11 items-center justify-center border bg-muted text-base font-bold">
                  {(org?.name ?? "A").slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-base font-semibold leading-none">{org?.name ?? "Arc"}</p>
              </div>
            </div>
            <p className="text-xs font-semibold uppercase leading-none tracking-[0.18em] text-blue-600">
              Change Order
              {changeOrder.co_number ? <span className="text-foreground/70"> · {changeOrder.co_number}</span> : null}
            </p>
          </div>

          <h1 className="mt-9 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{changeOrder.title}</h1>

          <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-5 border-y py-6 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Project</dt>
              <dd className="mt-1 truncate text-sm font-medium text-foreground">{project?.name || "-"}</dd>
              {projectAddress ? <dd className="truncate text-xs text-muted-foreground">{projectAddress.split("\n")[0]}</dd> : null}
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Reason</dt>
              <dd className="mt-1 truncate text-sm font-medium capitalize text-foreground">
                {changeOrder.reason?.replaceAll("_", " ") || "Field change"}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Issued</dt>
              <dd className="mt-1 truncate text-sm font-medium text-foreground">{issued || "-"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Schedule</dt>
              <dd className="mt-1 truncate text-sm font-medium text-foreground">
                {changeOrder.days_impact != null ? `${changeOrder.days_impact} days` : "No impact"}
              </dd>
            </div>
          </dl>

          {intro ? (
            <div className="mt-6">
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{intro}</p>
            </div>
          ) : null}

          {changeOrder.summary ? (
            <div className="mt-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Summary</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{changeOrder.summary}</p>
            </div>
          ) : null}

          {changeOrder.description && changeOrder.description !== intro ? (
            <div className="mt-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Scope details</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{changeOrder.description}</p>
            </div>
          ) : null}

          <div className="mt-8">
            <div className="flex items-baseline justify-between border-b border-blue-600 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Cost breakdown
              </span>
              {showAmounts ? (
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Amount</span>
              ) : null}
            </div>
            <div className="divide-y divide-border/70">
              {lines.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">No line items were included with this change order.</p>
              ) : (
                lines.map((line, index) => (
                  <div key={line.id ?? index} className="flex items-start justify-between gap-6 py-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{line.description}</p>
                      {showUnitLine ? (
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {line.quantity ?? 1}
                          {line.unit ? ` ${line.unit}` : ""} x {money(line.unit_cost_cents)}
                          {line.allowance_cents ? ` + ${money(line.allowance_cents)} allowance` : ""}
                        </p>
                      ) : null}
                    </div>
                    {showAmounts ? (
                      <div className="shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-foreground">
                        {money(lineAmount(line))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>

          {totals && showUnitLine ? (
            <div className="mt-5 space-y-2 border-t pt-4 text-sm">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">{money(totals.subtotal_cents)}</span>
              </div>
              {totals.markup_cents ? (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Markup{totals.markup_percent != null ? ` (${totals.markup_percent}%)` : ""}</span>
                  <span className="tabular-nums">{money(totals.markup_cents)}</span>
                </div>
              ) : null}
              {totals.tax_cents ? (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Tax{totals.tax_rate != null ? ` (${totals.tax_rate}%)` : ""}</span>
                  <span className="tabular-nums">{money(totals.tax_cents)}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 flex items-center justify-between border-t-2 border-blue-600 pt-5">
            <span className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground">Total change</span>
            <span className="text-2xl font-bold tracking-tight text-blue-600 tabular-nums sm:text-3xl">
              {money(changeOrder.total_cents)}
            </span>
          </div>

          {terms ? (
            <div className="mt-9 border bg-muted/30 p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Terms &amp; conditions
              </p>
              <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-foreground/75">{terms}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ChangeOrderApprovalClient({ token, changeOrder, org, project }: Props) {
  const [requestOpen, setRequestOpen] = useState(false)
  const [requestNote, setRequestNote] = useState("")
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [signerName, setSignerName] = useState("")
  const [signerEmail, setSignerEmail] = useState("")
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [pending, startTransition] = useTransition()

  const statusMeta = STATUS_META[changeOrder.status] ?? { label: changeOrder.status, tone: "neutral" as const }
  const canAct = changeOrder.status !== "approved" && changeOrder.status !== "requested_changes" && changeOrder.status !== "cancelled"
  const lastChangeRequest = useMemo(() => {
    const requests = changeOrder.metadata?.portal_change_requests
    return Array.isArray(requests) ? requests[requests.length - 1] : null
  }, [changeOrder.metadata])

  function submitChanges() {
    startTransition(async () => {
      try {
        await requestChangeOrderChangesAction({
          token,
          changeOrderId: changeOrder.id,
          note: requestNote,
        })
        toast.success("Changes sent to your builder.")
        setRequestOpen(false)
      } catch (error: any) {
        toast.error(error?.message ?? "Could not send changes.")
      }
    })
  }

  function submitApprovalSignature() {
    if (!signerName.trim()) {
      toast.error("Enter your full name to sign.")
      return
    }
    if (!signatureImage) {
      toast.error("Please draw or type your signature before approving.")
      return
    }
    if (!consentAccepted) {
      toast.error("Accept the signature consent before approving.")
      return
    }

    startTransition(async () => {
      try {
        await approveChangeOrderInPortalAction({
          token,
          changeOrderId: changeOrder.id,
          signature: {
            signer_name: signerName.trim(),
            signer_email: signerEmail.trim() || null,
            signature_text: signerName.trim(),
            signature_image: signatureImage,
            consent_accepted: consentAccepted,
          },
        })
        toast.success("Change order signed and approved.")
        setSignatureOpen(false)
      } catch (error: any) {
        toast.error(error?.message ?? "Could not approve change order.")
      }
    })
  }

  return (
    <QuotePortalShell
      orgName={org?.name}
      orgLogoUrl={org?.logoUrl}
      documentLabel="Change Order"
      statusLabel={statusMeta.label}
      statusTone={statusMeta.tone}
      pdfUrl={`/p/${token}/change-orders/${changeOrder.id}/pdf`}
      document={<ChangeOrderDocumentView changeOrder={changeOrder} org={org} project={project} />}
    >
      <Card className="overflow-hidden">
        <CardContent className="space-y-5 p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Total change</p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-blue-600 tabular-nums">{money(changeOrder.total_cents)}</p>
            {project?.name ? <p className="mt-1 text-xs text-muted-foreground">{project.name}</p> : null}
          </div>

          <StatusNotice changeOrder={changeOrder} />

          {lastChangeRequest?.note ? (
            <div className="border bg-muted/30 p-3 text-sm">
              <p className="font-semibold">Latest request</p>
              <p className="mt-1 whitespace-pre-line text-muted-foreground">{lastChangeRequest.note}</p>
            </div>
          ) : null}

          {canAct ? (
            <>
              <Separator />
              {signatureOpen ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Approve and sign</p>
                    <button
                      type="button"
                      onClick={() => setSignatureOpen(false)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Cancel signature"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your signature records approval of this change order and its terms.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="co-signer-name">Full name</Label>
                      <Input
                        id="co-signer-name"
                        value={signerName}
                        onChange={(event) => setSignerName(event.target.value)}
                        placeholder="Your full legal name"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="co-signer-email">Email</Label>
                      <Input
                        id="co-signer-email"
                        type="email"
                        value={signerEmail}
                        onChange={(event) => setSignerEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Signature</Label>
                      {signatureImage ? (
                        <div className="relative flex min-h-[100px] flex-col items-center justify-center border border-success/30 bg-white p-3">
                          <img src={signatureImage} alt="Adopted signature" className="h-16 w-full object-contain" />
                          <button type="button" onClick={() => setCaptureOpen(true)} className="mt-2 text-xs text-primary hover:underline">
                            Change signature
                          </button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setCaptureOpen(true)}
                          className="h-20 w-full flex-col gap-1 border-dashed"
                        >
                          <PenLine className="h-5 w-5 text-muted-foreground" />
                          <span className="text-sm font-semibold">Draw or type signature</span>
                        </Button>
                      )}
                    </div>
                    <label className="flex items-start gap-2 text-xs text-muted-foreground">
                      <Checkbox checked={consentAccepted} onCheckedChange={(checked) => setConsentAccepted(checked === true)} />
                      <span>
                        I agree to use electronic records and signatures for this change order, I can access and retain it electronically, and I intend my electronic signature to be legally binding.{" "}
                        <a href="/esign-terms" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                          Electronic signature terms
                        </a>
                      </span>
                    </label>
                  </div>
                  <Button className="h-10 w-full" disabled={pending} onClick={submitApprovalSignature}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Sign and approve
                  </Button>
                </div>
              ) : requestOpen ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Request changes</p>
                    <button
                      type="button"
                      onClick={() => setRequestOpen(false)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Cancel request"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tell your builder what needs to change before this can be approved.
                  </p>
                  <Textarea
                    value={requestNote}
                    onChange={(event) => setRequestNote(event.target.value)}
                    rows={4}
                    placeholder="e.g. Please break out the labor and material cost, then resend."
                    autoFocus
                  />
                  <Button className="h-10 w-full" disabled={pending} onClick={submitChanges}>
                    <Send className="mr-2 h-4 w-4" />
                    Send to builder
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="h-16 flex-col gap-1.5 border-emerald-500/40 bg-emerald-950 text-emerald-400 hover:bg-emerald-900"
                    onClick={() => setSignatureOpen(true)}
                  >
                    <PenLine className="h-5 w-5" />
                    Approve & sign
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-16 flex-col gap-1.5"
                    disabled={pending}
                    onClick={() => setRequestOpen(true)}
                  >
                    <MessageSquare className="h-5 w-5" />
                    Request changes
                  </Button>
                </div>
              )}
            </>
          ) : null}

          {changeOrder.status !== "approved" && changeOrder.status !== "requested_changes" ? (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>Approving records your electronic signature and updates the change-order register.</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Adopt your signature</DialogTitle>
            <DialogDescription>Draw or type the signature you want recorded on this change order.</DialogDescription>
          </DialogHeader>
          <SignatureCapture
            fieldLabel="Change order client signature"
            onApply={(signatureDataUrl) => {
              setSignatureImage(signatureDataUrl)
              setCaptureOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>
    </QuotePortalShell>
  )
}
