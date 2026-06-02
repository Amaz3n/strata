"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"

export type QuotePricingDisplay = "itemized" | "subtotals" | "lump_sum"

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
  /** Optional add-on the client can choose to include. */
  is_optional?: boolean
}

export interface QuoteDocumentViewProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  orgAddress?: string | null
  documentLabel: string
  title: string
  number?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  projectName?: string | null
  issuedAt?: string | null
  validUntil?: string | null
  intro?: string | null
  summary?: string | null
  terms?: string | null
  lines: QuoteViewLine[]
  totalCents?: number | null
  /** Hex accent color for headings, totals, and chrome. */
  accentColor?: string | null
  /** CSS font-family applied to the document body. */
  fontFamily?: string | null
  /** How much pricing breakdown to expose. Defaults to "itemized". */
  pricingDisplay?: QuotePricingDisplay
  /** Ids of optional add-ons currently selected (controlled by the portal). */
  selectedOptionalIds?: string[]
  /** When provided, optional add-ons render as interactive checkboxes. */
  onToggleOptional?: (id: string) => void
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

function formatDate(value?: string | null) {
  if (!value) return null
  // If it starts with a YYYY-MM-DD pattern, parse it timezone-safely as a UTC date
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    const year = parseInt(match[1], 10)
    const month = parseInt(match[2], 10) - 1
    const day = parseInt(match[3], 10)
    const d = new Date(Date.UTC(year, month, day))
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    }
  }
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
  orgAddress,
  documentLabel,
  title,
  number,
  recipientName,
  recipientEmail,
  projectName,
  issuedAt,
  validUntil,
  intro,
  summary,
  terms,
  lines,
  totalCents,
  accentColor,
  fontFamily,
  pricingDisplay = "itemized",
  selectedOptionalIds,
  onToggleOptional,
}: QuoteDocumentViewProps) {
  const [showFullSummary, setShowFullSummary] = useState(false)
  const summaryIsLong = !!summary && (summary.length > 160 || summary.includes("\n"))

  const accent = accentColor || undefined
  const showAmounts = pricingDisplay !== "lump_sum"
  const showUnitLine = pricingDisplay === "itemized"
  const selected = new Set(selectedOptionalIds ?? [])

  // Split out optional add-ons so they render as a distinct, selectable block.
  const mainLines = lines.filter((l) => !l.is_optional)
  const optionalLines = lines.filter((l) => l.is_optional && l.kind === "item")

  return (
    <div
      className="flex h-[60vh] min-h-[460px] flex-col overflow-hidden border bg-card shadow-sm lg:h-[calc(100dvh-9rem)]"
      style={fontFamily ? { fontFamily } : undefined}
    >
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
              <div className="min-w-0">
                <p className="text-base font-semibold leading-none">{orgName ?? "Arc"}</p>
                {orgAddress
                  ? orgAddress
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .map((line, i) => (
                        <p key={i} className="mt-1 text-xs leading-tight text-muted-foreground">
                          {line}
                        </p>
                      ))
                  : null}
              </div>
            </div>
            <p className="text-xs font-semibold uppercase leading-none tracking-[0.18em]" style={{ color: accent ?? undefined }}>
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

          {/* Cover note */}
          {intro ? (
            <div className="mt-6">
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{intro}</p>
            </div>
          ) : null}

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
            <div className="flex items-baseline justify-between border-b pb-2" style={accent ? { borderColor: accent } : undefined}>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Pricing breakdown
              </span>
              {showAmounts ? (
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Amount</span>
              ) : null}
            </div>
            <div className="divide-y divide-border/70">
              {mainLines.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">No line items.</p>
              ) : (
                mainLines.map((line, idx) =>
                  line.kind === "section" ? (
                    <div key={line.id ?? `s-${idx}`} className="pb-1 pt-6 first:pt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: accent ?? undefined }}>
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
                        {showUnitLine ? (
                          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                            {line.quantity ?? 1}
                            {line.unit ? ` ${line.unit}` : ""} × {money(line.unit_cost_cents)}
                          </p>
                        ) : null}
                      </div>
                      {showAmounts ? (
                        <div className="shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-foreground">
                          {money(line.amount_cents)}
                        </div>
                      ) : null}
                    </div>
                  ),
                )
              )}
            </div>
          </div>

          {/* Optional add-ons */}
          {optionalLines.length > 0 ? (
            <div className="mt-6">
              <div className="flex items-baseline justify-between border-b pb-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Optional add-ons
                </span>
                {onToggleOptional ? (
                  <span className="text-[10px] font-medium normal-case tracking-normal text-muted-foreground">Tap to include</span>
                ) : null}
              </div>
              <div className="divide-y divide-border/70">
                {optionalLines.map((line, idx) => {
                  const id = line.id ?? `opt-${idx}`
                  const isOn = selected.has(id)
                  const interactive = !!onToggleOptional
                  const body = (
                    <>
                      <div className="flex min-w-0 items-center gap-3">
                        {interactive ? (
                          <Checkbox checked={isOn} className="pointer-events-none" style={accent && isOn ? { backgroundColor: accent, borderColor: accent } : undefined} />
                        ) : null}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{line.description}</p>
                          {line.notes ? (
                            <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{line.notes}</p>
                          ) : null}
                        </div>
                      </div>
                      {showAmounts ? (
                        <div className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: isOn ? (accent ?? undefined) : undefined }}>
                          + {money(line.amount_cents)}
                        </div>
                      ) : null}
                    </>
                  )
                  const rowClass = `flex w-full items-center justify-between gap-4 py-3.5 text-left transition-colors ${
                    interactive ? "cursor-pointer hover:bg-muted/40" : ""
                  } ${interactive && !isOn ? "opacity-70" : ""}`
                  return interactive ? (
                    <button key={id} type="button" onClick={() => onToggleOptional!(id)} className={rowClass}>
                      {body}
                    </button>
                  ) : (
                    <div key={id} className={rowClass}>
                      {body}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* Total only */}
          <div className="mt-6 flex items-center justify-between border-t-2 pt-5" style={{ borderColor: accent ?? undefined }}>
            <span className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground">Total</span>
            <span className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl" style={{ color: accent ?? undefined }}>
              {money(totalCents)}
            </span>
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
