"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

import { submitDocumentSignatureAction } from "./actions"
import { FieldNavigator } from "./components/field-navigator"
import { PdfFieldViewer } from "./components/pdf-field-viewer"
import { SignatureCapture } from "./components/signature-capture"
import { SigningHeader } from "./components/signing-header"
import { SuccessScreen } from "./components/success-screen"
import { isFieldComplete, isRequiredField, type SigningField } from "./components/types"

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
}

type SigningStep = "fields" | "success"

function getTodayIsoDate() {
  return new Date().toISOString().split("T")[0]
}

export function DocumentSigningClient({
  token,
  fileUrl,
  document,
  fields,
  prefilledValues,
  signerRole,
}: DocumentSigningClientProps) {
  const [PDFComponents, setPDFComponents] = useState<{ Document: any; Page: any } | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [step, setStep] = useState<SigningStep>("fields")
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null)

  const [signerName, setSignerName] = useState("")
  const [signerEmail] = useState("")

  const [values, setValues] = useState<Record<string, unknown>>(prefilledValues ?? {})
  const [adoptedSignature, setAdoptedSignature] = useState<string | null>(null)
  const [signatureDialogFieldId, setSignatureDialogFieldId] = useState<string | null>(null)

  const [signedAt, setSignedAt] = useState<Date | null>(null)
  const [executedDocumentUrl, setExecutedDocumentUrl] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const loadPdf = async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
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

  const allRequiredComplete = requiredFields.every((field) => isFieldComplete(field, values))

  useEffect(() => {
    setValues((previous) => {
      const next = { ...previous }
      let changed = false

      visibleFields.forEach((field) => {
        if (field.field_type === "date" && !next[field.id]) {
          next[field.id] = getTodayIsoDate()
          changed = true
        }

        if (field.field_type === "name" && signerName.trim() && !next[field.id]) {
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
            if (visibleField.field_type === "name" && !String(next[visibleField.id] ?? "").trim()) {
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
    if (step !== "fields") return

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
  }, [goToNextField, goToPreviousField, step])

  const handleSubmit = () => {
    if (!allRequiredComplete) {
      toast.error("Complete all required fields before finishing")
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
          values,
          consentText: "I agree to sign this document electronically.",
        })

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

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SigningHeader
        title={document.title}
        completedRequired={completedRequired}
        totalRequired={requiredFields.length}
      />

      <main className="mx-auto w-full max-w-7xl px-4 pb-32 pt-4">
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
          onFinish={handleSubmit}
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
    </div>
  )
}
