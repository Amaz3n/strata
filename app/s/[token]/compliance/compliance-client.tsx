"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  Clock,
  Minus,
  ShieldCheck,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { cn, formatMoneyCentsExact, parseLocalDate } from "@/lib/utils"
import type {
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceStatusSummary,
} from "@/lib/types"
import { ComplianceUploadDialog } from "./upload-dialog"

interface ComplianceClientProps {
  status: ComplianceStatusSummary
  documentTypes: ComplianceDocumentType[]
  token: string
  canUpload: boolean
  /** The org blocks payment while requirements are unmet. */
  blocksPayment: boolean
}

type RequirementState = "met" | "pending" | "deficient" | "expired" | "rejected" | "missing" | "waived"

const STATE_COPY: Record<RequirementState, { label: string; className: string }> = {
  met: { label: "On file", className: "border-success/30 bg-success/10 text-success" },
  pending: { label: "Under review", className: "border-primary/30 bg-primary/10 text-primary" },
  deficient: { label: "Needs update", className: "border-warning/30 bg-warning/10 text-warning" },
  expired: { label: "Expired", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  rejected: { label: "Rejected", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  missing: { label: "Not provided", className: "border-border bg-muted text-muted-foreground" },
  waived: { label: "Waived", className: "border-border bg-muted text-muted-foreground" },
}

function daysUntil(date: string): number {
  const parsed = parseLocalDate(date)
  if (!parsed) return Number.POSITIVE_INFINITY
  return Math.ceil((parsed.getTime() - Date.now()) / 86_400_000)
}

function formatDay(value?: string | null) {
  const parsed = parseLocalDate(value)
  if (!parsed) return null
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** The endorsements a requirement demands, paired with what the document proves. */
function conditionsFor(requirement: ComplianceRequirement, doc?: ComplianceDocument) {
  const conditions: Array<{ label: string; met: boolean }> = []
  if (requirement.requires_additional_insured) {
    conditions.push({ label: "Additional insured", met: !!doc?.additional_insured })
  }
  if (requirement.requires_primary_noncontributory) {
    conditions.push({ label: "Primary & non-contributory", met: !!doc?.primary_noncontributory })
  }
  if (requirement.requires_waiver_of_subrogation) {
    conditions.push({ label: "Waiver of subrogation", met: !!doc?.waiver_of_subrogation })
  }
  return conditions
}

export function ComplianceClient({
  status,
  documentTypes,
  token,
  canUpload,
  blocksPayment,
}: ComplianceClientProps) {
  const router = useRouter()
  const [uploadFor, setUploadFor] = useState<ComplianceRequirement | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const deficiencyByRequirement = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const deficiency of status.deficiencies) {
      const current = map.get(deficiency.requirement_id) ?? []
      current.push(deficiency.message)
      map.set(deficiency.requirement_id, current)
    }
    return map
  }, [status.deficiencies])

  const rows = useMemo(() => {
    return status.requirements.map((requirement) => {
      const forType = status.documents.filter(
        (doc) => doc.document_type_id === requirement.document_type_id,
      )
      const approved = forType.find((doc) => doc.status === "approved")
      const pending = forType.find((doc) => doc.status === "pending_review")
      const rejected = forType.find((doc) => doc.status === "rejected")
      const doc = approved ?? pending ?? rejected
      const deficiencies = deficiencyByRequirement.get(requirement.id) ?? []
      const expiresIn = approved?.expiry_date ? daysUntil(approved.expiry_date) : null

      let state: RequirementState = "missing"
      if (requirement.waiver) state = "waived"
      else if (approved && expiresIn !== null && expiresIn < 0) state = "expired"
      else if (approved && deficiencies.length > 0) state = "deficient"
      else if (approved) state = "met"
      else if (pending) state = "pending"
      else if (rejected) state = "rejected"

      return { requirement, doc, approved, pending, rejected, deficiencies, expiresIn, state }
    })
  }, [status.requirements, status.documents, deficiencyByRequirement])

  const active = rows.filter((row) => row.state !== "waived")
  const metCount = active.filter((row) => row.state === "met").length
  const blockingCount = active.filter((row) =>
    ["missing", "expired", "deficient", "rejected"].includes(row.state),
  ).length
  const expiringSoon = active.filter(
    (row) => row.state === "met" && row.expiresIn !== null && row.expiresIn <= 30,
  )

  const openUpload = (requirement: ComplianceRequirement) => {
    setUploadFor(requirement)
    setUploadOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Leads with the consequence, because that is what the reader is actually
          deciding about — not the abstract idea of being "compliant". */}
      <section
        className={cn(
          "border p-4",
          blockingCount === 0
            ? "border-success/30 bg-success/10"
            : blocksPayment
              ? "border-destructive/30 bg-destructive/10"
              : "border-warning/30 bg-warning/10",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {blockingCount === 0 ? (
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
            ) : blocksPayment ? (
              <Ban className="mt-0.5 size-5 shrink-0 text-destructive" />
            ) : (
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {blockingCount === 0
                  ? "Your paperwork is in order"
                  : blocksPayment
                    ? `${blockingCount} ${blockingCount === 1 ? "item is" : "items are"} holding up your payments`
                    : `${blockingCount} ${blockingCount === 1 ? "item needs" : "items need"} your attention`}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {blockingCount === 0
                  ? "Nothing is blocking payment on this project."
                  : blocksPayment
                    ? "This builder holds invoice payments until every required document is current."
                    : "Keeping these current avoids delays when you invoice."}
              </p>
            </div>
          </div>
        </div>

        {active.length > 0 ? (
          <div className="mt-4 space-y-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Requirements met</span>
              <span className="tabular-nums">
                {metCount} of {active.length}
              </span>
            </div>
            <Progress value={(metCount / active.length) * 100} className="h-1.5" />
          </div>
        ) : null}
      </section>

      {expiringSoon.length > 0 ? (
        <section className="border border-warning/30 bg-warning/5 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Clock className="size-4 shrink-0 text-warning" />
            Renewing soon
          </p>
          <ul className="mt-2 space-y-1">
            {expiringSoon.map((row) => (
              <li key={row.requirement.id} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.requirement.document_type?.name}
                </span>
                <span className="shrink-0 tabular-nums">
                  {row.expiresIn === 0
                    ? "Expires today"
                    : row.expiresIn === 1
                      ? "1 day left"
                      : `${row.expiresIn} days left`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {active.length === 0 && rows.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-medium">No documents required yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This builder has not set compliance requirements for your company.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {rows.map((row) => {
            const { requirement, doc, approved, deficiencies, expiresIn, state } = row
            const conditions = conditionsFor(requirement, approved)
            const shortfall =
              requirement.min_coverage_cents &&
              approved?.coverage_amount_cents != null &&
              approved.coverage_amount_cents < requirement.min_coverage_cents

            return (
              <li key={requirement.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{requirement.document_type?.name}</p>
                      <span
                        className={cn(
                          "border px-1.5 py-0.5 text-[11px] font-medium",
                          STATE_COPY[state].className,
                        )}
                      >
                        {STATE_COPY[state].label}
                      </span>
                      {!requirement.is_required && state !== "waived" ? (
                        <span className="text-[11px] text-muted-foreground">Optional</span>
                      ) : null}
                    </div>

                    {state === "waived" ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {requirement.waiver?.reason
                          ? `Waived by the builder — ${requirement.waiver.reason}`
                          : "The builder has waived this requirement."}
                      </p>
                    ) : null}

                    {requirement.notes && state !== "waived" ? (
                      <p className="mt-1 text-sm text-muted-foreground">{requirement.notes}</p>
                    ) : null}

                    {/* What is actually on file */}
                    {approved && state !== "waived" ? (
                      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                        {approved.carrier_name ? (
                          <div className="flex gap-1.5">
                            <dt>Carrier</dt>
                            <dd className="text-foreground">{approved.carrier_name}</dd>
                          </div>
                        ) : null}
                        {approved.policy_number ? (
                          <div className="flex gap-1.5">
                            <dt>Policy</dt>
                            <dd className="tabular-nums text-foreground">{approved.policy_number}</dd>
                          </div>
                        ) : null}
                        {approved.coverage_amount_cents != null ? (
                          <div className="flex gap-1.5">
                            <dt>Coverage</dt>
                            <dd
                              className={cn(
                                "tabular-nums",
                                shortfall ? "text-warning" : "text-foreground",
                              )}
                            >
                              {formatMoneyCentsExact(approved.coverage_amount_cents)}
                              {shortfall && requirement.min_coverage_cents ? (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {formatMoneyCentsExact(requirement.min_coverage_cents)} required
                                </span>
                              ) : null}
                            </dd>
                          </div>
                        ) : null}
                        {approved.expiry_date ? (
                          <div className="flex gap-1.5">
                            <dt>Expires</dt>
                            <dd
                              className={cn(
                                "tabular-nums",
                                expiresIn !== null && expiresIn < 0
                                  ? "text-destructive"
                                  : expiresIn !== null && expiresIn <= 30
                                    ? "text-warning"
                                    : "text-foreground",
                              )}
                            >
                              {formatDay(approved.expiry_date)}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}

                    {/* The endorsements this builder requires, and whether the
                        document on file actually carries them. */}
                    {conditions.length > 0 && state !== "waived" ? (
                      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {conditions.map((condition) => (
                          <li
                            key={condition.label}
                            className={cn(
                              "flex items-center gap-1.5 text-xs",
                              condition.met ? "text-muted-foreground" : "text-warning",
                            )}
                          >
                            {condition.met ? (
                              <Check className="size-3.5 shrink-0 text-success" />
                            ) : approved ? (
                              <X className="size-3.5 shrink-0" />
                            ) : (
                              <Minus className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            {condition.label}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {row.rejected?.rejection_reason && state === "rejected" ? (
                      <p className="mt-2 border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                        {row.rejected.rejection_reason}
                      </p>
                    ) : null}

                    {deficiencies.length > 0 && state !== "waived"
                      ? deficiencies.map((message) => (
                          <p key={message} className="mt-1.5 text-xs text-warning">
                            {message}
                          </p>
                        ))
                      : null}
                  </div>

                  {canUpload && state !== "waived" ? (
                    <Button
                      size="sm"
                      variant={state === "met" ? "ghost" : "outline"}
                      onClick={() => openUpload(requirement)}
                      className="shrink-0"
                    >
                      {state === "met" ? "Replace" : doc ? "Resubmit" : "Upload"}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {status.documents.length > 0 ? (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown
              className={cn("size-4 transition-transform duration-150", historyOpen && "rotate-180")}
            />
            Everything you have submitted ({status.documents.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <ul className="divide-y divide-border border border-border bg-card">
              {status.documents.map((document) => (
                <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{document.document_type?.name}</p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      Sent {formatDay(document.created_at)}
                      {document.expiry_date ? ` · expires ${formatDay(document.expiry_date)}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs capitalize text-muted-foreground">
                    {document.status.replaceAll("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {/* Keyed so each requirement opens with its own clean state. */}
      {uploadFor ? (
        <ComplianceUploadDialog
          key={uploadFor.id}
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          token={token}
          requirement={uploadFor}
          documentType={
            uploadFor.document_type ??
            documentTypes.find((type) => type.id === uploadFor.document_type_id)
          }
          onUploaded={() => router.refresh()}
        />
      ) : null}
    </div>
  )
}
