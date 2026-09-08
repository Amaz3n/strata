"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { AlertTriangle, FileText, Loader2, Upload, X } from "lucide-react"

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
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ResponsiveDialog } from "@/components/ui/responsive-dialog"
import { formatFileSize } from "@/components/files/types"
import { cn, formatMoneyCentsExact } from "@/lib/utils"
import type { ComplianceDocumentType, ComplianceRequirement } from "@/lib/types"
import {
  DocumentFactFields,
  EMPTY_FACTS,
  factsToInput,
  parseMoneyToCents,
  type DocumentFactValues,
} from "@/components/compliance/document-fact-fields"

interface ComplianceUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string
  /** The one requirement this upload satisfies. Always known from the row. */
  requirement: ComplianceRequirement
  documentType?: ComplianceDocumentType
  onUploaded: () => void
}

export function ComplianceUploadDialog({
  open,
  onOpenChange,
  token,
  requirement,
  documentType,
  onUploaded,
}: ComplianceUploadDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [facts, setFacts] = useState<DocumentFactValues>(EMPTY_FACTS)
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedType = documentType ?? requirement.document_type

  const coverageCents = useMemo(() => parseMoneyToCents(facts.coverage_amount) ?? null, [facts.coverage_amount])

  const coverageShort =
    requirement?.min_coverage_cents != null &&
    coverageCents != null &&
    coverageCents < requirement.min_coverage_cents

  const unmetConditions = requirement
    ? [
        requirement.requires_additional_insured && !facts.additional_insured
          ? "additional insured"
          : null,
        requirement.requires_primary_noncontributory && !facts.primary_noncontributory
          ? "primary & non-contributory"
          : null,
        requirement.requires_waiver_of_subrogation && !facts.waiver_of_subrogation
          ? "waiver of subrogation"
          : null,
      ].filter((value): value is string => value !== null)
    : []

  function reset() {
    setFacts(EMPTY_FACTS)
    setFile(null)
    setProgress(0)
    setError(null)
  }

  function submit() {
    if (!file) return setError("Attach the document.")

    setError(null)
    startTransition(async () => {
      const ticker = setInterval(() => setProgress((prev) => Math.min(prev + 15, 80)), 250)
      try {
        const formData = new FormData()
        formData.append("file", file)
        const uploadRes = await fetch(`/api/portal/s/${token}/compliance/upload`, {
          method: "POST",
          body: formData,
        })
        if (!uploadRes.ok) {
          const body = await uploadRes.json().catch(() => ({}))
          throw new Error(body.error ?? "That upload did not go through. Try again.")
        }
        const { fileId } = await uploadRes.json()

        const res = await fetch(`/api/portal/s/${token}/compliance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_type_id: requirement.document_type_id,
            file_id: fileId,
            ...factsToInput(facts),
          }),
        })
        clearInterval(ticker)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? "That document could not be saved.")
        }

        setProgress(100)
        reset()
        onUploaded()
        onOpenChange(false)
      } catch (caught) {
        clearInterval(ticker)
        setProgress(0)
        setError(caught instanceof Error ? caught.message : "Something went wrong. Try again.")
      }
    })
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
      title={`Send your ${selectedType?.name ?? "document"}`}
      description="The builder reviews it before it counts toward your requirements."
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {error ? (
          <p
            role="alert"
            className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {selectedType?.description ? (
          <p className="text-sm text-muted-foreground">{selectedType.description}</p>
        ) : null}

        {/* Spells out what this builder demands, rather than leaving the sub to
            guess which endorsements matter. */}
        {requirement.min_coverage_cents ||
        requirement.requires_additional_insured ||
        requirement.requires_primary_noncontributory ||
        requirement.requires_waiver_of_subrogation ? (
          <div className="border border-border bg-muted/40 px-3 py-2.5 text-xs">
            <p className="font-medium text-foreground">What this builder requires</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {requirement.min_coverage_cents ? (
                <li>
                  At least{" "}
                  <span className="tabular-nums text-foreground">
                    {formatMoneyCentsExact(requirement.min_coverage_cents)}
                  </span>{" "}
                  in coverage
                </li>
              ) : null}
              {requirement.requires_additional_insured ? <li>Additional insured endorsement</li> : null}
              {requirement.requires_primary_noncontributory ? (
                <li>Primary &amp; non-contributory wording</li>
              ) : null}
              {requirement.requires_waiver_of_subrogation ? <li>Waiver of subrogation</li> : null}
            </ul>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>File</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
            className="hidden"
            onChange={(event) => {
              const picked = event.target.files?.[0]
              if (picked) {
                setFile(picked)
                setError(null)
              }
            }}
          />
          {file ? (
            <Attachment state={isPending ? "uploading" : "done"} className="w-full">
              <AttachmentMedia variant="icon">
                {isPending ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <FileText className="size-4" />
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{file.name}</AttachmentTitle>
                {isPending ? (
                  <Progress value={progress} className="mt-1.5 h-1.5" />
                ) : (
                  <AttachmentDescription>{formatFileSize(file.size)}</AttachmentDescription>
                )}
              </AttachmentContent>
              {!isPending ? (
                <AttachmentActions className="pr-1.5">
                  <AttachmentAction onClick={() => setFile(null)} aria-label={`Remove ${file.name}`}>
                    <X className="size-4" />
                  </AttachmentAction>
                </AttachmentActions>
              ) : null}
            </Attachment>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 border border-dashed border-border bg-card px-3 py-5 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
            >
              <Upload className="size-4" />
              Choose a PDF or photo
            </button>
          )}
        </div>

        {selectedType ? (
          <DocumentFactFields
            kind={selectedType.kind}
            hasExpiry={selectedType.has_expiry}
            values={facts}
            onChange={(next) => setFacts((prev) => ({ ...prev, ...next }))}
          />
        ) : null}

        {coverageShort && requirement?.min_coverage_cents ? (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Below the {formatMoneyCentsExact(requirement.min_coverage_cents)} this builder requires.
            You can still send it — they will review the shortfall.
          </p>
        ) : null}

        {unmetConditions.length > 0 ? (
          <p className="flex items-start gap-1.5 border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This builder also requires {unmetConditions.join(", ")}. Sending without{" "}
              {unmetConditions.length === 1 ? "it" : "them"} will leave the requirement open.
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={isPending || !file}>
          {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Send for review
        </Button>
      </div>
    </ResponsiveDialog>
  )
}
