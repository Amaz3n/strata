"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ELECTRONIC_SIGNATURE_CONSENT_TEXT } from "@/lib/esign/consent"
import { readUnsignedDraft, unsignedDraftValues } from "@/lib/esign/esign-ui-helpers"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import { declineDocumentSignatureAction, submitDocumentSignatureAction } from "./actions"
import { FieldNavigator } from "./components/field-navigator"
import { PdfFieldViewer } from "./components/pdf-field-viewer"
import { ReviewStep } from "./components/review-step"
import { SignatureCapture } from "./components/signature-capture"
import { SigningHeader } from "./components/signing-header"
import { SuccessScreen } from "./components/success-screen"
import { isFieldComplete, isRequiredField, type SigningField } from "./components/types"
import { configurePdfWorker } from "@/lib/pdf/worker"

interface DocumentSigningClientProps {
  token: string
  fileUrl: string
  document: {
    id: string
    title: string
    document_type: string
  }
  fields: SigningField[]
  prefilledValues: Record<string, any>
  signerRole: string
  signerEmail?: string | null
}

type SigningStep = "fields" | "review" | "success" | "declined"

function getTodayIsoDate() {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
}

export function DocumentSigningClient({
  token,
  fileUrl,
  document,
  fields,
  prefilledValues,
  signerRole,
  signerEmail: initialSignerEmail,
}: DocumentSigningClientProps) {
  const [PDFComponents, setPDFComponents] = useState<{ Document: any; Page: any } | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [step, setStep] = useState<SigningStep>("fields")
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null)

  const [signerName, setSignerName] = useState("")
  const [signerEmail, setSignerEmail] = useState(initialSignerEmail ?? "")
  const [consentChecked, setConsentChecked] = useState(false)

  const [values, setValues] = useState<Record<string, unknown>>(prefilledValues ?? {})
  const [adoptedSignature, setAdoptedSignature] = useState<string | null>(null)
  const [signatureDialogFieldId, setSignatureDialogFieldId] = useState<string | null>(null)

  const [signedAt, setSignedAt] = useState<Date | null>(null)
  const [executedDocumentUrl, setExecutedDocumentUrl] = useState<string | null>(null)
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState("")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const loadPdf = async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        configurePdfWorker()
        setPDFComponents({ Document, Page })
      } catch (error) {
        console.error("Failed to load PDF renderer", error)
        toast.error("Unable to load document preview")
      }
    }

    loadPdf()
  }, [])

  const visibleFields = useMemo(
    () => fields.filter((field) => !field.signer_role || field.signer_role === signerRole),
    [fields, signerRole],
  )

  const [draftKey, setDraftKey] = useState<string | null>(null)
  const [rememberProgress, setRememberProgress] = useState(false)
  const [draftNotice, setDraftNotice] = useState("")
  const fieldScope = visibleFields.map(field => field.id).join(":")
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bytes = new TextEncoder().encode(`${token}:${document.id}:${fieldScope}`)
      const digest = await crypto.subtle.digest("SHA-256", bytes)
      const key = `arc-signing-draft-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`
      if (cancelled) return
      setDraftKey(key)
      try {
        const saved = readUnsignedDraft(sessionStorage.getItem(key), visibleFields)
        if (saved) {
          setValues(previous => ({ ...previous, ...saved }))
          setRememberProgress(true)
          setDraftNotice("Your unsigned fields were restored. Add your signature and consent again.")
        } else sessionStorage.removeItem(key)
      } catch { setDraftNotice("This browser cannot save progress.") }
    })().catch(() => { if (!cancelled) setDraftNotice("This browser cannot save progress.") })
    return () => { cancelled = true }
  }, [token, document.id, fieldScope])

  useEffect(() => {
    if (!draftKey || !rememberProgress || step === "success" || step === "declined") return
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ version: 1, savedAt: Date.now(), values: unsignedDraftValues(visibleFields, values) }))
    } catch { setDraftNotice("Progress could not be saved. Keep this page open until you finish.") }
  }, [draftKey, rememberProgress, step, values, visibleFields])

  const clearLocalDraft = () => {
    if (draftKey) { try { sessionStorage.removeItem(draftKey) } catch {} }
    setRememberProgress(false)
  }

  const requiredFields = useMemo(
    () => visibleFields.filter((field) => isRequiredField(field)),
    [visibleFields],
  )

  const fieldsById = useMemo(() => {
    return fields.reduce<Record<string, SigningField>>((acc, field) => {
      acc[field.id] = field
      return acc
    }, {})
  }, [fields])

  const fieldsByPage = useMemo(() => {
    return fields.reduce<Record<number, SigningField[]>>((acc, field) => {
      acc[field.page_index] = acc[field.page_index] ? [...acc[field.page_index], field] : [field]
      return acc
    }, {})
  }, [fields])

  const completedRequired = useMemo(
    () => requiredFields.filter((field) => isFieldComplete(field, values)).length,
    [requiredFields, values],
  )

  const allRequiredComplete = visibleFields.every(field => {
    const value = values[field.id]
    const provided = typeof value === "string" ? value.trim().length > 0 : value === true
    return !isRequiredField(field) && !provided || isFieldComplete(field, values)
  })

  useEffect(() => {
    setValues((previous) => {
      const next = { ...previous }
      let changed = false

      visibleFields.forEach((field) => {
        if (field.field_type === "date" && !next[field.id]) {
          next[field.id] = getTodayIsoDate()
          changed = true
        }

        if (field.field_type === "name" && signerName.trim() && next[field.id] !== signerName.trim()) {
          next[field.id] = signerName.trim()
          changed = true
        }
      })

      return changed ? next : previous
    })
  }, [signerName, visibleFields])

  useEffect(() => {
    if (signerName.trim()) return

    const existingName = visibleFields
      .map((field) => (field.field_type === "name" ? values[field.id] : null))
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)

    if (existingName) {
      setSignerName(existingName)
    }
  }, [signerName, values, visibleFields])

  useEffect(() => {
    if (step !== "fields") return

    if (visibleFields.length === 0) {
      setActiveFieldId(null)
      return
    }

    setActiveFieldId((current) => {
      if (current && visibleFields.some((field) => field.id === current)) return current

      const firstRequiredMissing = visibleFields.find(
        (field) => isRequiredField(field) && !isFieldComplete(field, values),
      )
      const firstPending = visibleFields.find((field) => !isFieldComplete(field, values))
      return (firstRequiredMissing ?? firstPending ?? visibleFields[0]).id
    })
  }, [step, values, visibleFields])

  const activeField = activeFieldId ? fieldsById[activeFieldId] ?? null : null
  const activeFieldIndex = activeFieldId ? visibleFields.findIndex((field) => field.id === activeFieldId) : -1
  const signatureDialogField = signatureDialogFieldId ? fieldsById[signatureDialogFieldId] ?? null : null

  useEffect(() => {
    if (!activeField) return
    setCurrentPageIndex(activeField.page_index)
  }, [activeField])

  useEffect(() => {
    if (pageCount <= 0) return
    setCurrentPageIndex((current) => Math.min(current, pageCount - 1))
  }, [pageCount])

  const jumpToField = useCallback(
    (fieldId: string) => {
      const field = fieldsById[fieldId]
      if (!field) return
      setActiveFieldId(fieldId)
      setCurrentPageIndex(field.page_index)
    },
    [fieldsById],
  )

  const goToAdjacentField = useCallback(
    (offset: number) => {
      if (visibleFields.length === 0) return

      const currentIndex = activeFieldIndex >= 0 ? activeFieldIndex : 0
      const nextIndex = Math.max(0, Math.min(visibleFields.length - 1, currentIndex + offset))
      jumpToField(visibleFields[nextIndex].id)
    },
    [activeFieldIndex, jumpToField, visibleFields],
  )

  const goToNextField = useCallback(() => goToAdjacentField(1), [goToAdjacentField])
  const goToPreviousField = useCallback(() => goToAdjacentField(-1), [goToAdjacentField])

  const applyFieldValue = useCallback(
    (
      field: SigningField,
      nextValue: unknown,
      options?: { advance?: boolean; updateSignerName?: boolean },
    ) => {
      setValues((previous) => {
        const next = { ...previous, [field.id]: nextValue }

        if (field.field_type === "name" && typeof nextValue === "string" && nextValue.trim()) {
          visibleFields.forEach((visibleField) => {
            if (visibleField.field_type === "name") {
              next[visibleField.id] = nextValue.trim()
            }
          })
        }

        return next
      })

      if (options?.updateSignerName && typeof nextValue === "string") {
        setSignerName(nextValue)
      }

      if (options?.advance) {
        const currentIndex = visibleFields.findIndex((visibleField) => visibleField.id === field.id)
        if (currentIndex >= 0 && currentIndex < visibleFields.length - 1) {
          jumpToField(visibleFields[currentIndex + 1].id)
        }
      }
    },
    [jumpToField, visibleFields],
  )

  const handleSignatureRequested = useCallback(
    (field: SigningField) => {
      if (adoptedSignature) {
        applyFieldValue(field, adoptedSignature, { advance: true })
        return
      }

      setSignatureDialogFieldId(field.id)
    },
    [adoptedSignature, applyFieldValue],
  )

  useEffect(() => {
    if (step !== "fields" || signatureDialogFieldId || declineDialogOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isInputTarget =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable

      if (isInputTarget) return

      if (event.key === "ArrowRight") {
        event.preventDefault()
        goToNextField()
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault()
        goToPreviousField()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [goToNextField, goToPreviousField, step, signatureDialogFieldId, declineDialogOpen])

  const handleFinishFields = () => {
    if (!allRequiredComplete) {
      toast.error("Complete required fields and correct invalid values before finishing")
      return
    }

    setStep("review")
  }

  const handleSubmit = () => {
    if (!allRequiredComplete) {
      toast.error("Complete required fields and correct invalid values before signing")
      setStep("fields")
      return
    }

    if (!consentChecked) {
      toast.error("Review and accept the electronic signature disclosure before signing")
      return
    }

    const resolvedSignerName =
      signerName.trim() ||
      visibleFields
        .map((field) => values[field.id])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ||
      "Document signer"

    startTransition(async () => {
      try {
        const response = await submitDocumentSignatureAction({
          token,
          signerName: resolvedSignerName,
          signerEmail,
          values: Object.fromEntries(visibleFields.filter(field => values[field.id] !== undefined).map(field => [field.id, values[field.id]])),
          consentText: ELECTRONIC_SIGNATURE_CONSENT_TEXT,
        })

        clearLocalDraft()
        setSignedAt(new Date())
        setExecutedDocumentUrl(response.executedDocumentUrl ?? null)
        setStep("success")
        toast.success("Document signed")
      } catch (error: any) {
        console.error(error)
        toast.error("Unable to sign", {
          description: error?.message ?? "Please try again.",
        })
      }
    })
  }

  const handleDecline = () => {
    startTransition(async () => {
      try {
        await declineDocumentSignatureAction({ token, reason: declineReason })
        clearLocalDraft()
        setDeclineDialogOpen(false)
        setStep("declined")
        toast.success("Signature request declined")
      } catch (error: any) {
        console.error(error)
        toast.error("Unable to decline", {
          description: error?.message ?? "Please try again.",
        })
      }
    })
  }

  if (step === "success" && signedAt) {
    return (
      <div className="min-h-screen bg-background">
        <SuccessScreen
          title={document.title}
          signerEmail={signerEmail}
          signedAt={signedAt}
          executedDocumentUrl={executedDocumentUrl}
        />
      </div>
    )
  }

  if (step === "declined") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg rounded-lg border bg-card p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold">Signature request declined</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The sender will see that this envelope is no longer active.
          </p>
        </div>
      </div>
    )
  }

  if (step === "review") {
    return (
      <div className="min-h-screen bg-background px-4 py-8">
        <ReviewStep
          documentTitle={document.title}
          signerName={signerName}
          signerEmail={signerEmail}
          values={values}
          visibleFields={visibleFields}
          consentChecked={consentChecked}
          isSubmitting={isPending}
          onSignerNameChange={setSignerName}
          onSignerEmailChange={setSignerEmail}
          onConsentChange={setConsentChecked}
          onBack={() => setStep("fields")}
          onSubmit={handleSubmit}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SigningHeader
        title={document.title}
        completedRequired={completedRequired}
        totalRequired={requiredFields.length}
      />
      <div className="border-b bg-muted/20 px-4 py-2">
        <div className="mx-auto flex w-full max-w-7xl justify-end">
          <Button variant="ghost" size="sm" onClick={() => setDeclineDialogOpen(true)}>
            Decline to sign
          </Button>
        </div>
      </div>

      <main className="mx-auto w-full max-w-7xl px-4 pb-32 pt-4">
        <div className="mb-3 space-y-1 text-sm">
          <label className="flex items-center gap-2"><Checkbox checked={rememberProgress} onCheckedChange={checked => { if (checked === true) setRememberProgress(true); else clearLocalDraft() }} />Save unsigned fields in this browser tab for up to 24 hours</label>
          <p className="text-xs text-muted-foreground">Use only on a private device. Signatures and consent are never saved. Saved fields stay in this tab’s session and expire after 24 hours.</p>
          {draftNotice ? <p role="status">{draftNotice}</p> : null}
        </div>
        <PdfFieldViewer
          PDFComponents={PDFComponents}
          fileUrl={fileUrl}
          fieldsByPage={fieldsByPage}
          signerRole={signerRole}
          values={values}
          activeFieldId={activeFieldId}
          currentPageIndex={currentPageIndex}
          pageCount={pageCount}
          onFieldSelect={jumpToField}
          onPageChange={setCurrentPageIndex}
          onPageCountChange={setPageCount}
          onApplyFieldValue={applyFieldValue}
          onSignatureRequested={handleSignatureRequested}
        />
      </main>

      {step === "fields" ? (
        <FieldNavigator
          activeField={activeField}
          currentIndex={Math.max(activeFieldIndex, 0)}
          totalFields={visibleFields.length}
          canGoPrevious={activeFieldIndex > 0}
          canGoNext={activeFieldIndex >= 0 && activeFieldIndex < visibleFields.length - 1}
          allRequiredComplete={allRequiredComplete}
          onPrevious={goToPreviousField}
          onNext={goToNextField}
          onFinish={handleFinishFields}
        />
      ) : null}

      <Dialog open={Boolean(signatureDialogField)} onOpenChange={(open) => !open && setSignatureDialogFieldId(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Adopt your signature</DialogTitle>
            <DialogDescription>
              Create your signature once. After adopting it, clicking other signature fields signs instantly.
            </DialogDescription>
          </DialogHeader>

          {signatureDialogField ? (
            <SignatureCapture
              fieldLabel={signatureDialogField.label?.trim() || "Signature"}
              preferredMethod={signatureDialogField.metadata?.signatureStyle}
              adoptedSignature={adoptedSignature}
              onApply={(signatureDataUrl, options) => {
                applyFieldValue(signatureDialogField, signatureDataUrl, { advance: true })
                if (options.adopt) {
                  setAdoptedSignature(signatureDataUrl)
                }
                setSignatureDialogFieldId(null)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={declineDialogOpen} onOpenChange={setDeclineDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline to sign?</DialogTitle>
            <DialogDescription>
              This will stop the signing process and notify the sender that the request was declined.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={declineReason}
            onChange={(event) => setDeclineReason(event.target.value)}
            rows={4}
            placeholder="Reason (optional)"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDecline} disabled={isPending}>
              {isPending ? "Declining..." : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
