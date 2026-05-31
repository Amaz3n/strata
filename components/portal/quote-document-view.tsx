"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"

export type QuoteViewLine = {
  id?: string
  kind: "item" | "section"
  description: string
  quantity?: number | null
  unit?: string | null
  unit_cost_cents?: number | null
  amount_cents?: number | null
  badges?: string[]
  notes?: string | null
  muted?: boolean
}

export interface QuoteDocumentViewProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  documentLabel: string
  title: string
  number?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  projectName?: string | null
  issuedAt?: string | null
  validUntil?: string | null
  summary?: string | null
  terms?: string | null
  lines: QuoteViewLine[]
  totalCents?: number | null
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

function formatDate(value?: string | null) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

function MetaCell({ label, value, sub }: { label: string; value?: string | null; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-foreground">{value || "—"}</dd>
      {sub ? <dd className="truncate text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  )
}

/**
 * Native, premium rendering of a quote (estimate or proposal) for the client portal.
 * Fixed height with internal scroll so the portal page stays compact. Sharp-edged to
 * match the app's house style.
 */
export function QuoteDocumentView({
  orgName,
  orgLogoUrl,
  documentLabel,
  title,
  number,
  recipientName,
  recipientEmail,
  projectName,
  issuedAt,
  validUntil,
  summary,
  terms,
  lines,
  totalCents,
}: QuoteDocumentViewProps) {
  const [showFullSummary, setShowFullSummary] = useState(false)
  const summaryIsLong = !!summary && (summary.length > 160 || summary.includes("\n"))

  return (
    <div className="flex h-[60vh] min-h-[460px] flex-col overflow-hidden border bg-card shadow-sm lg:h-[calc(100dvh-9rem)]">
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-8 sm:px-12 sm:py-10">
          {/* Letterhead — org name and document label vertically centered together */}
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              {orgLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={orgLogoUrl} alt={orgName ?? "Logo"} className="h-11 w-11 border object-contain" />
              ) : (
                <div className="flex h-11 w-11 items-center justify-center border bg-muted text-base font-bold">
                  {(orgName ?? "A").slice(0, 1).toUpperCase()}
                </div>
              )}
              <p className="text-base font-semibold leading-none">{orgName ?? "Arc"}</p>
            </div>
            <p className="text-xs font-semibold uppercase leading-none tracking-[0.18em] text-muted-foreground">
              {documentLabel}
              {number ? <span className="text-foreground/70"> · {number}</span> : null}
            </p>
          </div>

          {/* Title */}
          <h1 className="mt-9 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>

          {/* Symmetric meta grid */}
          <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-5 border-y py-6 sm:grid-cols-4">
            <MetaCell label="Client" value={recipientName} sub={recipientEmail} />
            <MetaCell label="Project" value={projectName} />
            <MetaCell label="Issued" value={formatDate(issuedAt)} />
            <MetaCell label="Valid until" value={formatDate(validUntil)} />
          </dl>

          {/* Collapsible summary — keeps pricing visible on open */}
          {summary ? (
            <div className="mt-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Scope</p>
              <p
                className={`mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90 ${
                  summaryIsLong && !showFullSummary ? "line-clamp-2" : ""
                }`}
              >
                {summary}
              </p>
              {summaryIsLong ? (
                <button
                  type="button"
                  onClick={() => setShowFullSummary((v) => !v)}
                  className="mt-1 text-xs font-medium text-primary hover:underline"
                >
                  {showFullSummary ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Line items */}
          <div className="mt-8">
            <div className="flex items-baseline justify-between border-b pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Pricing breakdown
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Amount</span>
            </div>
            <div className="divide-y divide-border/70">
              {lines.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">No line items.</p>
              ) : (
                lines.map((line, idx) =>
                  line.kind === "section" ? (
                    <div key={line.id ?? `s-${idx}`} className="pb-1 pt-6 first:pt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground/70">
                        {line.description}
                      </p>
                    </div>
                  ) : (
                    <div
                      key={line.id ?? `l-${idx}`}
                      className={`flex items-start justify-between gap-6 py-4 ${line.muted ? "opacity-55" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{line.description}</p>
                          {line.badges?.map((b) => (
                            <Badge key={b} variant="outline" className="px-2 py-0 text-[10px] font-medium">
                              {b}
                            </Badge>
                          ))}
                        </div>
                        {line.notes ? (
                          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                            {line.notes}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {line.quantity ?? 1}
                          {line.unit ? ` ${line.unit}` : ""} × {money(line.unit_cost_cents)}
                        </p>
                      </div>
                      <div className="shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-foreground">
                        {money(line.amount_cents)}
                      </div>
                    </div>
                  ),
                )
              )}
            </div>
          </div>

          {/* Total only */}
          <div className="mt-6 flex items-center justify-between border-t-2 border-foreground/80 pt-5">
            <span className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground">Total</span>
            <span className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">{money(totalCents)}</span>
          </div>

          {/* Terms */}
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
