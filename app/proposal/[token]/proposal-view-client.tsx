"use client"

import { useMemo } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

type ProposalLine = {
  id: string
  line_type: "item" | "section" | "allowance" | "option"
  description: string
  quantity?: number | null
  unit?: string | null
  unit_cost_cents?: number | null
  markup_percent?: number | null
  is_optional?: boolean | null
  is_selected?: boolean | null
  allowance_cents?: number | null
  notes?: string | null
  sort_order?: number | null
}

type ProposalPortalPayload = {
  id: string
  number?: string | null
  title?: string | null
  summary?: string | null
  terms?: string | null
  valid_until?: string | null
  status: string
  total_cents?: number | null
  signature_required?: boolean | null
  snapshot?: {
    markup_percent?: number | null
    tax_rate?: number | null
    subtotal_cents?: number | null
    tax_cents?: number | null
  } | null
  lines?: ProposalLine[]
  org?: { name?: string | null } | null
  project?: { name?: string | null; location?: Record<string, unknown> | null } | null
  recipient?: { full_name?: string | null; email?: string | null } | null
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

interface Props {
  proposal: ProposalPortalPayload
  continueSigningUrl?: string | null
}

export function ProposalViewClient({ proposal, continueSigningUrl }: Props) {
  const requiresSignature = proposal.signature_required ?? true
  const sortedLines = useMemo(
    () => [...(proposal.lines ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [proposal.lines],
  )

  const totals = useMemo(() => {
    const subtotal = sortedLines.reduce((sum, line) => {
      if (line.line_type === "section") return sum
      if (line.is_optional && line.is_selected === false) return sum
      const base = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
      const markupPercent = line.markup_percent ?? proposal.snapshot?.markup_percent ?? 0
      const markup = Math.round((base * markupPercent) / 100)
      return sum + base + markup
    }, 0)

    const tax =
      proposal.snapshot?.tax_cents ??
      Math.round(subtotal * ((proposal.snapshot?.tax_rate ?? 0) / 100))

    const total = proposal.total_cents ?? subtotal + tax
    return { subtotal, tax, total }
  }, [proposal.snapshot, proposal.total_cents, sortedLines])

  const formatMoney = (value?: number | null) => currency.format((value ?? 0) / 100)

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="rounded-lg bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Proposal</p>
              <h1 className="text-2xl font-semibold text-foreground">
                {proposal.title ?? proposal.number ?? "Project Proposal"}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {proposal.project?.name ? <Badge variant="outline">{proposal.project.name}</Badge> : null}
                {proposal.number ? <Badge variant="secondary">#{proposal.number}</Badge> : null}
                {proposal.valid_until ? (
                  <Badge variant="outline">
                    Valid until {new Date(proposal.valid_until).toLocaleDateString()}
                  </Badge>
                ) : null}
                <Badge variant={proposal.status === "sent" ? "default" : "outline"} className="capitalize">
                  {proposal.status}
                </Badge>
              </div>
              {proposal.recipient?.full_name ? (
                <p className="text-sm text-muted-foreground">
                  Prepared for {proposal.recipient.full_name}
                  {proposal.recipient.email ? ` · ${proposal.recipient.email}` : ""}
                </p>
              ) : null}
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-3xl font-bold text-foreground">{formatMoney(totals.total)}</p>
              <p className="text-xs text-muted-foreground">
                Subtotal {formatMoney(totals.subtotal)} • Tax {formatMoney(totals.tax)}
              </p>
            </div>
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scope & Pricing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sortedLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No line items yet.</p>
            ) : (
              <div className="space-y-3">
                {sortedLines.map((line) =>
                  line.line_type === "section" ? (
                    <div key={line.id} className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {line.description}
                    </div>
                  ) : (
                    <div key={line.id} className="rounded-lg border bg-muted/50 p-3">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">{line.description}</p>
                            {line.line_type === "allowance" ? (
                              <Badge variant="outline" className="text-xs">Allowance</Badge>
                            ) : null}
                            {line.is_optional ? <Badge variant="secondary" className="text-xs">Optional</Badge> : null}
                            {line.line_type === "option" ? <Badge variant="outline" className="text-xs">Choice</Badge> : null}
                          </div>
                          {line.notes ? (
                            <p className="text-sm text-muted-foreground whitespace-pre-line">{line.notes}</p>
                          ) : null}
                          <div className="text-xs text-muted-foreground">
                            Qty {line.quantity ?? 1}
                            {line.unit ? ` ${line.unit}` : ""} · {formatMoney(line.unit_cost_cents)}
                            {line.markup_percent ? ` · Markup ${line.markup_percent}%` : ""}
                            {line.is_optional && line.is_selected === false ? " (not selected)" : ""}
                          </div>
                        </div>
                        <div className="text-right text-sm font-semibold text-foreground">
                          {formatMoney(
                            (line.unit_cost_cents ?? 0) * (line.quantity ?? 1) +
                              Math.round(
                                ((line.unit_cost_cents ?? 0) * (line.quantity ?? 1) *
                                  (line.markup_percent ?? proposal.snapshot?.markup_percent ?? 0)) / 100,
                              ),
                          )}
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="space-y-1 text-muted-foreground">
                <p>Subtotal: {formatMoney(totals.subtotal)}</p>
                <p>Tax: {formatMoney(totals.tax)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Grand total</p>
                <p className="text-xl font-bold text-foreground">{formatMoney(totals.total)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              {proposal.summary ? (
                <p className="whitespace-pre-line">{proposal.summary}</p>
              ) : (
                <p>No summary provided.</p>
              )}
              {proposal.terms ? (
                <div className="rounded-md bg-muted/60 p-3 text-xs text-foreground">
                  <p className="mb-1 font-semibold text-muted-foreground">Terms</p>
                  <p className="whitespace-pre-line">{proposal.terms}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Signature</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {requiresSignature
                  ? "This proposal now uses Arc's secure document-signing flow."
                  : "This proposal uses Arc's secure document-signing flow when signature is required."}
              </p>

              {continueSigningUrl ? (
                <Button className="w-full" asChild>
                  <a href={continueSigningUrl}>Continue to secure signing</a>
                </Button>
              ) : (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  The signing link is not active yet. Please use the latest email from your builder.
                </div>
              )}

              {proposal.valid_until ? (
                <p className="text-xs text-muted-foreground">
                  Expires on {new Date(proposal.valid_until).toLocaleDateString()}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
