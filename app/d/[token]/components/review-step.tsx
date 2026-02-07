import { AlertTriangle, CheckCircle2, Loader2, PenLine } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { formatFieldValue, isFieldComplete, normalizeFieldLabel, type SigningField } from "./types"

interface ReviewStepProps {
  documentTitle: string
  signerName: string
  signerEmail: string
  values: Record<string, unknown>
  visibleFields: SigningField[]
  consentChecked: boolean
  isSubmitting: boolean
  onSignerNameChange: (value: string) => void
  onSignerEmailChange: (value: string) => void
  onConsentChange: (checked: boolean) => void
  onBack: () => void
  onSubmit: () => void
}

export function ReviewStep({
  documentTitle,
  signerName,
  signerEmail,
  values,
  visibleFields,
  consentChecked,
  isSubmitting,
  onSignerNameChange,
  onSignerEmailChange,
  onConsentChange,
  onBack,
  onSubmit,
}: ReviewStepProps) {
  const requiredFields = visibleFields.filter((field) => field.required !== false)
  const missingRequired = requiredFields.filter((field) => !isFieldComplete(field, values))

  return (
    <section className="mx-auto w-full max-w-4xl rounded-lg border bg-card p-4 sm:p-6">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Final review</p>
        <h2 className="text-xl font-semibold">Review and sign {documentTitle}</h2>
      </div>

      {missingRequired.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Complete required fields before signing</p>
              <p className="mt-1 text-xs text-amber-800">
                Missing: {missingRequired.map((field) => normalizeFieldLabel(field)).join(", ")}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" />
          All required fields are complete.
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="review-signer-name">Full legal name</Label>
          <Input
            id="review-signer-name"
            value={signerName}
            onChange={(event) => onSignerNameChange(event.target.value)}
            placeholder="Jane Doe"
            autoComplete="name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="review-signer-email">Email (optional)</Label>
          <Input
            id="review-signer-email"
            value={signerEmail}
            onChange={(event) => onSignerEmailChange(event.target.value)}
            placeholder="jane@example.com"
            autoComplete="email"
          />
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <p className="text-sm font-semibold">Responses</p>
        <div className="space-y-2">
          {visibleFields.map((field) => {
            const value = values[field.id]
            const complete = isFieldComplete(field, values)
            const label = normalizeFieldLabel(field)

            return (
              <div
                key={field.id}
                className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{field.required === false ? "Optional" : "Required"}</p>
                </div>
                <div className="max-w-[55%] text-right">
                  {field.field_type === "signature" && typeof value === "string" && value.length > 0 ? (
                    <img src={value} alt={label} className="h-10 w-32 rounded border bg-background object-contain" />
                  ) : (
                    <p className="truncate text-sm text-muted-foreground">{formatFieldValue(field, value) || (complete ? "Completed" : "Not set")}</p>
                  )}
                </div>
              </div>
            )
          })}

          {visibleFields.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No fields were assigned to this signer.
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 rounded-md border bg-muted/40 p-3">
        <div className="flex items-start gap-2">
          <Checkbox id="consent" checked={consentChecked} onCheckedChange={(checked) => onConsentChange(checked === true)} />
          <Label htmlFor="consent" className="text-sm leading-5">
            I agree to sign this document electronically and understand this signature is legally binding.
          </Label>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back to document
        </Button>
        <Button
          type="button"
          className="px-5"
          disabled={missingRequired.length > 0 || !consentChecked || !signerName.trim() || isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PenLine className="mr-1.5 h-4 w-4" />}
          Sign Document
        </Button>
      </div>
    </section>
  )
}
