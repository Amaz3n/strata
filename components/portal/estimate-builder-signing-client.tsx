"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { submitEstimateBuilderSignatureAction } from "@/app/d/[token]/actions"
import { SignatureCapture } from "@/app/d/[token]/components/signature-capture"
import { CheckCircle2, PenLine } from "@/components/icons"
import { QuoteDocumentView, type QuoteViewLine } from "@/components/portal/quote-document-view"
import { EstimatePhotoGallery } from "@/components/portal/estimate-photo-gallery"
import { QuotePortalShell } from "@/components/portal/quote-portal-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import type { EstimatePortalData } from "@/lib/services/estimate-portal"

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

const ELECTRONIC_SIGNATURE_CONSENT_TEXT =
  "I agree to use electronic records and signatures for this estimate, I can access and retain the estimate electronically, and I intend my electronic signature to be legally binding."

interface EstimateBuilderSigningClientProps {
  token: string
  estimate: EstimatePortalData
  signerEmail?: string | null
  signerName?: string | null
  pdfUrl: string
}

export function EstimateBuilderSigningClient({
  token,
  estimate,
  signerEmail: initialSignerEmail,
  signerName: initialSignerName,
  pdfUrl,
}: EstimateBuilderSigningClientProps) {
  const [signerName, setSignerName] = useState(initialSignerName ?? "")
  const [signerEmail, setSignerEmail] = useState(initialSignerEmail ?? "")
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const [pending, startTransition] = useTransition()

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

  // This document is already client-signed: optional add-ons are locked to the
  // client's recorded selection and the total reflects that acceptance.
  const acceptedOptionalIds = estimate.accepted_options?.ids ?? []
  const documentTotal = estimate.accepted_options?.accepted_total_cents ?? estimate.total_cents

  function submitSignature() {
    if (!signerName.trim()) {
      toast.error("Enter your full name to sign.")
      return
    }
    if (!signerEmail.trim()) {
      toast.error("Enter your email to sign.")
      return
    }
    if (!signatureImage) {
      toast.error("Draw or type your signature before signing.")
      return
    }
    if (!consentAccepted) {
      toast.error("Accept the electronic signature consent before signing.")
      return
    }

    startTransition(async () => {
      try {
        await submitEstimateBuilderSignatureAction({
          token,
          signerName,
          signerEmail,
          signatureText: signerName,
          signatureImage,
          consentText: ELECTRONIC_SIGNATURE_CONSENT_TEXT,
        })
        setIsComplete(true)
        toast.success("Estimate executed")
      } catch (error: any) {
        toast.error(error?.message ?? "Unable to sign estimate.")
      }
    })
  }

  return (
    <QuotePortalShell
      orgName={estimate.org_name}
      orgLogoUrl={estimate.org_logo_url}
      documentLabel="Estimate"
      statusLabel={isComplete ? "Executed" : "Builder signature"}
      statusTone={isComplete ? "success" : "info"}
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
          totalCents={documentTotal}
          accentColor={estimate.accent_color}
          fontFamily={estimate.font_family}
          pricingDisplay={estimate.pricing_display}
          selectedOptionalIds={acceptedOptionalIds}
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
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Project total
            </p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums" style={{ color: estimate.accent_color ?? undefined }}>{money(documentTotal)}</p>
            {estimate.project_name ? <p className="mt-1 text-xs text-muted-foreground">{estimate.project_name}</p> : null}
          </div>

          {isComplete ? (
            <div className="flex items-start gap-2.5 border border-emerald-500/30 bg-emerald-500/5 p-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm">
                <p className="font-semibold text-emerald-700">Estimate executed</p>
                <p className="text-muted-foreground">Your signature has been recorded and the executed PDF was generated.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div className="text-sm">
                  <p className="font-semibold text-emerald-700">Client signed</p>
                  <p className="text-muted-foreground">Review the estimate, then countersign to fully execute it.</p>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="builder-signer-name">Full name</Label>
                  <Input
                    id="builder-signer-name"
                    value={signerName}
                    onChange={(event) => setSignerName(event.target.value)}
                    placeholder="Your full legal name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="builder-signer-email">Email</Label>
                  <Input
                    id="builder-signer-email"
                    type="email"
                    value={signerEmail}
                    onChange={(event) => setSignerEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Signature</Label>
                  {signatureImage ? (
                    <div className="flex min-h-[100px] flex-col items-center justify-center border border-success/30 bg-white p-3">
                      <img src={signatureImage} alt="Adopted signature" className="h-16 w-full object-contain" />
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
                      className="flex h-20 w-full flex-col items-center justify-center gap-1 border-dashed"
                    >
                      <PenLine className="h-5 w-5 text-muted-foreground" />
                      <span className="text-sm font-semibold">Draw or type signature</span>
                    </Button>
                  )}
                </div>
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={consentAccepted}
                    onCheckedChange={(checked) => setConsentAccepted(checked === true)}
                  />
                  <span>
                    {ELECTRONIC_SIGNATURE_CONSENT_TEXT}{" "}
                    <a href="/esign-terms" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                      Electronic signature terms
                    </a>
                  </span>
                </label>
              </div>

              <Button className="h-10 w-full" disabled={pending} onClick={submitSignature}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {pending ? "Signing..." : "Sign and execute"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Adopt your signature</DialogTitle>
            <DialogDescription>Draw, type, or upload the signature you want recorded on this estimate.</DialogDescription>
          </DialogHeader>
          <SignatureCapture
            fieldLabel="Estimate builder signature"
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
