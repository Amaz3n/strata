"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  certifyPayApplicationPortalAction,
  returnPayApplicationPortalAction,
} from "@/app/p/[token]/pay-applications/actions"
import { AlertTriangle, ArrowLeft, PenLine } from "@/components/icons"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { PayApplicationDeferralEditor } from "@/components/financials/pay-application-deferral-editor"
import { resolvePayApplicationDeferrals, type DeferrablePayApplicationLine, type PayApplicationDeferralDraft } from "@/lib/financials/pay-app-deferrals"
import { formatMoneyCentsExact } from "@/lib/utils"

interface Props {
  token: string
  payApplicationId: string
  applicationNumber: number
  /** Original requested amount, before explicit certification deferrals. */
  amountCents: number
  lines: DeferrablePayApplicationLine[]
}

export function PortalPayApplicationActions({
  token,
  payApplicationId,
  applicationNumber,
  amountCents,
  lines,
}: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [certifyOpen, setCertifyOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)

  const [signerName, setSignerName] = useState("")
  const [signatureText, setSignatureText] = useState("")
  const [consent, setConsent] = useState(false)
  const [note, setNote] = useState("")
  const [reason, setReason] = useState("")

  const [deferralDraft, setDeferralDraft] = useState<PayApplicationDeferralDraft>({})
  const certificate = resolvePayApplicationDeferrals(lines, deferralDraft, amountCents)
  const amount = formatMoneyCentsExact(amountCents)
  const certifiedAmount = formatMoneyCentsExact(certificate.certifiedCents)

  function submitCertificate() {
    if (certificate.error) return
    startTransition(async () => {
      const result = await certifyPayApplicationPortalAction(token, payApplicationId, {
        signerName,
        signatureText,
        consentAccepted: consent,
        deferrals: certificate.deferrals,
        note: note.trim() || null,
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(`Application #${applicationNumber} certified. The invoice has been issued.`)
      setCertifyOpen(false)
      setConsent(false)
      setDeferralDraft({})
      setNote("")
      router.refresh()
    })
  }

  function submitReturn() {
    startTransition(async () => {
      const result = await returnPayApplicationPortalAction(token, payApplicationId, { reason })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success("Returned to your contractor with your comments.")
      setReturnOpen(false)
      setReason("")
      router.refresh()
    })
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="sm:flex-1" onClick={() => setCertifyOpen(true)} disabled={pending}>
          <PenLine className="mr-2 h-4 w-4" aria-hidden />
          Certify for payment
        </Button>
        <Button
          variant="outline"
          className="sm:flex-1"
          onClick={() => setReturnOpen(true)}
          disabled={pending}
        >
          <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
          Return with comments
        </Button>
      </div>

      <Dialog open={certifyOpen} onOpenChange={(open) => (pending ? null : setCertifyOpen(open))}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Certify Application #{applicationNumber}</DialogTitle>
            <DialogDescription>
              You are certifying {certifiedAmount} as due to your contractor for this period. Signing issues
              the invoice for that amount.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <PayApplicationDeferralEditor lines={lines} value={deferralDraft} onChange={setDeferralDraft}
              appliedCents={amountCents} disabled={pending} />

            <div className="space-y-1.5">
              <Label htmlFor="pay-app-signer-name">Your full name</Label>
              <Input
                id="pay-app-signer-name"
                value={signerName}
                onChange={(event) => setSignerName(event.target.value)}
                placeholder="Your full legal name"
                autoComplete="name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pay-app-signature">Type your signature</Label>
              <Input
                id="pay-app-signature"
                value={signatureText}
                onChange={(event) => setSignatureText(event.target.value)}
                placeholder="Type your name to sign"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pay-app-note">Note to your contractor (optional)</Label>
              <Textarea
                id="pay-app-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Anything you want recorded with the certificate."
              />
            </div>

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={consent}
                onCheckedChange={(checked) => setConsent(checked === true)}
                aria-label="Electronic signature consent"
              />
              <span>
                The name I typed above is my electronic signature. I intend it to be legally binding
                and I agree to certify this application electronically.{" "}
                <a
                  href="/esign-terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  Electronic signature terms
                </a>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCertifyOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={submitCertificate}
              disabled={
                pending || Boolean(certificate.error) || signerName.trim().length < 2 || signatureText.trim().length < 2 || !consent
              }
            >
              {pending ? "Certifying…" : `Certify ${certifiedAmount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={returnOpen} onOpenChange={(open) => (pending ? null : setReturnOpen(open))}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Return Application #{applicationNumber}</DialogTitle>
            <DialogDescription>
              Your contractor gets your comments and revises the application. It comes back with the
              same number and a revision mark.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-start gap-2.5 border border-destructive/40 bg-destructive/5 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <p className="text-sm text-muted-foreground">
                Returning voids the {amount} invoice for this application and sends it back to your
                contractor for revision.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pay-app-return-reason">Why are you returning it?</Label>
              <Textarea
                id="pay-app-return-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                placeholder="e.g. Line 6 shows 80% complete but the framing inspection has not passed."
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Your contractor sees this exactly as written.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitReturn} disabled={pending || reason.trim().length < 10}>
              {pending ? "Returning…" : "Return application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
