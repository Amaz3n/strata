"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { CheckCircle2, XCircle, MessageSquare, Send, Clock, AlertTriangle, Plus, X, PenLine } from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SignatureCapture } from "@/app/d/[token]/components/signature-capture"
import { QuotePortalShell, type PortalStatusTone } from "@/components/portal/quote-portal-shell"
import { QuoteDocumentView, type QuoteViewLine } from "@/components/portal/quote-document-view"
import { EstimatePhotoGallery } from "@/components/portal/estimate-photo-gallery"
import { submitEstimateDecisionAction, type EstimatePortalPayload } from "@/app/e/[token]/actions"

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

const STATUS_META: Record<string, { label: string; tone: PortalStatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Awaiting your review", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  client_signed: { label: "Client signed", tone: "success" },
  executed: { label: "Executed", tone: "success" },
  converted_to_project: { label: "Project created", tone: "success" },
  rejected: { label: "Declined", tone: "danger" },
  changes_requested: { label: "Changes requested", tone: "warning" },
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

interface Props {
  token: string
  estimate: EstimatePortalPayload
  pdfUrl: string
  expired: boolean
}

export function EstimatePortalClient({ token, estimate, pdfUrl, expired }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [changesOpen, setChangesOpen] = useState(false)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [changeItems, setChangeItems] = useState<string[]>([""])
  const [signerName, setSignerName] = useState(estimate.recipient_name ?? "")
  const [signerEmail, setSignerEmail] = useState(estimate.recipient_email ?? "")
  const [signatureText, setSignatureText] = useState(estimate.recipient_name ?? "")
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)

  const statusMeta = STATUS_META[estimate.status] ?? STATUS_META.sent
  const isApproved = estimate.status === "approved" || estimate.status === "client_signed" || estimate.status === "executed" || estimate.status === "converted_to_project"
  const isClientSigned = estimate.status === "client_signed"
  const isExecuted = estimate.status === "executed" || estimate.status === "converted_to_project"
  const isDeclined = estimate.status === "rejected"
  const canDecide = !isApproved && !expired && estimate.is_current_version

  const viewLines = useMemo<QuoteViewLine[]>(
    () =>
      estimate.items.map((it) => {
        const isGroup = it.item_type === "group"
        return {
          id: it.id,
          kind: isGroup ? "section" : "item",
          description: it.description,
          quantity: it.quantity,
          unit: it.unit,
          unit_cost_cents: it.unit_cost_cents,
          amount_cents: it.amount_cents,
          notes: it.notes,
          is_optional: it.is_optional,
          badges: it.is_allowance ? ["Allowance"] : undefined,
        }
      }),
    [estimate.items],
  )

  // Optional add-ons the client can toggle. Pre-fill from the recorded selection
  // once signed; otherwise start unselected and let the client opt in.
  const optionalAmountById = useMemo(
    () => new Map(estimate.items.filter((it) => it.is_optional).map((it) => [it.id, it.amount_cents ?? 0])),
    [estimate.items],
  )
  const [selectedOptionalIds, setSelectedOptionalIds] = useState<string[]>(estimate.accepted_options?.ids ?? [])
  const toggleOptional = (id: string) =>
    setSelectedOptionalIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const baseTotal = estimate.total_cents ?? 0
  const selectedOptionalSubtotal = selectedOptionalIds.reduce(
    (sum, id) => sum + (optionalAmountById.get(id) ?? 0),
    0,
  )
  // Add-ons are taxed at the document rate; mirror the server's acceptance math
  // so the number the client sees is the number that gets recorded.
  const selectedOptionalTotal =
    selectedOptionalSubtotal + Math.round((selectedOptionalSubtotal * (estimate.tax_rate ?? 0)) / 100)
  const displayTotal =
    isApproved && estimate.accepted_options
      ? estimate.accepted_options.accepted_total_cents
      : baseTotal + selectedOptionalTotal
  const hasOptionals = optionalAmountById.size > 0

  function runDecision(decision: "approved" | "rejected" | "changes_requested", note?: string) {
    startTransition(async () => {
      try {
        await submitEstimateDecisionAction({
          token,
          decision,
          note,
          selected_optional_ids: decision === "approved" ? selectedOptionalIds : undefined,
          signature:
            decision === "approved"
              ? {
                  signer_name: signerName.trim(),
                  signer_email: signerEmail.trim() || null,
                  signature_text: signatureText.trim() || signerName.trim(),
                  signature_image: signatureImage || null,
                  consent_accepted: consentAccepted,
                }
              : null,
        })
        toast.success(
          decision === "approved"
            ? "Estimate signed — thank you!"
            : decision === "rejected"
              ? "Estimate declined."
              : "Change requests sent to your builder.",
        )
        setChangesOpen(false)
        setSignatureOpen(false)
        setChangeItems([""])
        router.refresh()
      } catch (error: any) {
        toast.error(error?.message ?? "Something went wrong. Please try again.")
      }
    })
  }

  function submitChanges() {
    const items = changeItems.map((c) => c.trim()).filter(Boolean)
    if (items.length === 0) {
      toast.error("Add at least one change before sending.")
      return
    }
    const note = items.length === 1 ? items[0] : items.map((c, i) => `${i + 1}. ${c}`).join("\n")
    runDecision("changes_requested", note)
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
    runDecision("approved")
  }

  return (
    <QuotePortalShell
      orgName={estimate.org_name}
      orgLogoUrl={estimate.org_logo_url}
      documentLabel="Estimate"
      statusLabel={statusMeta.label}
      statusTone={statusMeta.tone}
      pdfUrl={pdfUrl}
      document={
        <QuoteDocumentView
          orgName={estimate.org_name}
          orgLogoUrl={estimate.org_logo_url}
          orgAddress={estimate.org_address}
          documentLabel="Estimate"
          title={estimate.title}
          number={`v${estimate.version}`}
          recipientName={estimate.recipient_name}
          recipientEmail={estimate.recipient_email}
          projectName={estimate.project_name}
          issuedAt={estimate.issued_at}
          validUntil={estimate.valid_until}
          intro={estimate.intro}
          summary={estimate.summary}
          terms={estimate.terms}
          lines={viewLines}
          totalCents={displayTotal}
          accentColor={estimate.accent_color}
          fontFamily={estimate.font_family}
          pricingDisplay={estimate.pricing_display}
          selectedOptionalIds={selectedOptionalIds}
          onToggleOptional={canDecide ? toggleOptional : undefined}
        />
      }
    >
      {estimate.photos.length > 0 ? (
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <EstimatePhotoGallery photos={estimate.photos} accentColor={estimate.accent_color} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardContent className="space-y-5 p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Project total</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums" style={{ color: estimate.accent_color ?? undefined }}>{money(displayTotal)}</p>
            {hasOptionals && selectedOptionalTotal > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                Includes {money(selectedOptionalTotal)} in selected add-ons
              </p>
            ) : null}
            {estimate.project_name ? <p className="mt-1 text-xs text-muted-foreground">{estimate.project_name}</p> : null}
          </div>

          {!estimate.is_current_version ? (
            <div className="flex items-start gap-2.5 border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-muted-foreground">A newer version has been issued — please use the latest link from your builder.</p>
            </div>
          ) : null}

          {isApproved ? (
            <div className="flex items-start gap-2.5 border border-emerald-500/30 bg-emerald-500/5 p-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm">
                <p className="font-semibold text-emerald-700">
                  {isExecuted ? "Executed" : isClientSigned ? "Signed" : "Approved"}
                </p>
                <p className="text-muted-foreground">
                  {estimate.client_signed_at ? formatTime(estimate.client_signed_at) : estimate.responded_at ? formatTime(estimate.responded_at) : ""}
                </p>
              </div>
            </div>
          ) : isDeclined ? (
            <div className="flex items-start gap-2.5 border border-red-500/30 bg-red-500/5 p-3">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div className="text-sm">
                <p className="font-semibold text-red-700">Declined</p>
                <p className="text-muted-foreground">Your builder has been notified.</p>
              </div>
            </div>
          ) : expired ? (
            <div className="flex items-start gap-2.5 border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-muted-foreground">This estimate has expired. Please contact your builder for an updated copy.</p>
            </div>
          ) : estimate.status === "changes_requested" ? (
            <div className="flex items-start gap-2.5 border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-muted-foreground">Your change requests were sent to {estimate.org_name || "your builder"}.</p>
            </div>
          ) : null}

          {canDecide ? (
            <>
              <Separator />
              {signatureOpen ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Approve and sign</p>
                    <button
                      type="button"
                      onClick={() => setSignatureOpen(false)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your typed signature records your approval of this estimate and its terms.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="estimate-signer-name">Full name</Label>
                      <Input
                        id="estimate-signer-name"
                        value={signerName}
                        onChange={(event) => {
                          setSignerName(event.target.value)
                          if (!signatureText || signatureText === estimate.recipient_name) {
                            setSignatureText(event.target.value)
                          }
                        }}
                        placeholder="Your full legal name"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="estimate-signer-email">Email</Label>
                      <Input
                        id="estimate-signer-email"
                        type="email"
                        value={signerEmail}
                        onChange={(event) => setSignerEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Signature</Label>
                      {signatureImage ? (
                        <div className="relative rounded-md border bg-white p-3 flex flex-col items-center justify-center min-h-[100px] group border-success/30 hover:border-success/60 transition-colors">
                          <img
                            src={signatureImage}
                            alt="Adopted signature"
                            className="h-16 w-full object-contain"
                          />
                          <button
                            type="button"
                            onClick={() => setCaptureOpen(true)}
                            className="mt-2 text-xs text-primary hover:underline"
                          >
                            Change signature
                          </button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setCaptureOpen(true)}
                          className="h-20 w-full border-dashed flex flex-col gap-1 items-center justify-center hover:bg-muted/30 hover:border-primary/50 transition-colors"
                        >
                          <PenLine className="h-5 w-5 text-muted-foreground" />
                          <span className="text-sm font-semibold">Draw or Type Signature</span>
                          <span className="text-xs text-muted-foreground">Click to sign electronically</span>
                        </Button>
                      )}
                    </div>
                    <label className="flex items-start gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={consentAccepted}
                        onCheckedChange={(checked) => setConsentAccepted(checked === true)}
                      />
                      <span>
                        I agree to use electronic records and signatures for this estimate, I can access and retain the estimate electronically, and I intend my electronic signature to be legally binding.{" "}
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
              ) : changesOpen ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Request changes</p>
                    <button
                      type="button"
                      onClick={() => { setChangesOpen(false); setChangeItems([""]) }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">List each change separately so your builder can address them one by one.</p>

                  <div className="space-y-2">
                    {changeItems.map((item, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <div className="mt-2.5 flex h-5 w-5 shrink-0 items-center justify-center border bg-muted text-[11px] font-semibold tabular-nums">
                          {idx + 1}
                        </div>
                        <Textarea
                          value={item}
                          onChange={(e) =>
                            setChangeItems((prev) => prev.map((c, i) => (i === idx ? e.target.value : c)))
                          }
                          rows={2}
                          placeholder={idx === 0 ? "e.g. Swap the flooring to engineered oak" : "Another change…"}
                          autoFocus={idx === 0}
                          className="flex-1"
                        />
                        {changeItems.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => setChangeItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="mt-2 text-muted-foreground hover:text-foreground"
                            aria-label="Remove change"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setChangeItems((prev) => [...prev, ""])}
                    className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add another change
                  </button>

                  <Button className="h-10 w-full" disabled={pending} onClick={submitChanges}>
                    <Send className="mr-2 h-4 w-4" />
                    Send to builder
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setSignatureOpen(true)}
                    className="flex flex-col items-center justify-center gap-1.5 border border-emerald-500/40 bg-emerald-950 p-4 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-900 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-5 w-5" />
                    Sign
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setChangesOpen(true)}
                    className="flex flex-col items-center justify-center gap-1.5 border border-blue-500/40 bg-blue-950 p-4 text-xs font-semibold text-blue-400 transition-colors hover:bg-blue-900 disabled:opacity-50"
                  >
                    <MessageSquare className="h-5 w-5" />
                    Changes
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => runDecision("rejected")}
                    className="flex flex-col items-center justify-center gap-1.5 border border-red-500/40 bg-red-950 p-4 text-xs font-semibold text-red-400 transition-colors hover:bg-red-900 disabled:opacity-50"
                  >
                    <XCircle className="h-5 w-5" />
                    Decline
                  </button>
                </div>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Adopt your signature</DialogTitle>
            <DialogDescription>
              Create your custom signature. You can either draw it with your mouse/touchscreen or type it using one of our handwriting styles.
            </DialogDescription>
          </DialogHeader>
          <SignatureCapture
            fieldLabel="Estimate client signature"
            onApply={(signatureDataUrl) => {
              setSignatureImage(signatureDataUrl)
              setSignatureText(signerName || "Signed Electronically")
              setCaptureOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>
    </QuotePortalShell>
  )
}
