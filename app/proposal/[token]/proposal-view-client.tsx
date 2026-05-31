"use client"

import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { QuotePortalShell, type PortalStatusTone } from "@/components/portal/quote-portal-shell"
import { QuoteDocumentView, type QuoteViewLine } from "@/components/portal/quote-document-view"
import { formatLocalDate } from "@/lib/utils"

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
  created_at?: string | null
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
  org?: { name?: string | null; logo_url?: string | null } | null
  project?: { name?: string | null; location?: Record<string, unknown> | null } | null
  recipient?: { full_name?: string | null; email?: string | null } | null
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents?: number | null) => currency.format((cents ?? 0) / 100)

const STATUS_META: Record<string, { label: string; tone: PortalStatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Awaiting signature", tone: "info" },
  accepted: { label: "Executed", tone: "success" },
  rejected: { label: "Declined", tone: "danger" },
}

interface Props {
  proposal: ProposalPortalPayload
  pdfUrl: string
  continueSigningUrl?: string | null
}

export function ProposalViewClient({ proposal, pdfUrl, continueSigningUrl }: Props) {
  const requiresSignature = proposal.signature_required ?? true
  const statusMeta = STATUS_META[proposal.status] ?? STATUS_META.sent

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
    const tax = proposal.snapshot?.tax_cents ?? Math.round(subtotal * ((proposal.snapshot?.tax_rate ?? 0) / 100))
    const total = proposal.total_cents ?? subtotal + tax
    return { subtotal, tax, total }
  }, [proposal.snapshot, proposal.total_cents, sortedLines])

  const viewLines = useMemo<QuoteViewLine[]>(
    () =>
      sortedLines.map((line) => {
        const isSection = line.line_type === "section"
        const base = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
        const markupPercent = line.markup_percent ?? proposal.snapshot?.markup_percent ?? 0
        const amount = isSection ? null : Math.round(base + (base * markupPercent) / 100)
        const badges: string[] = []
        if (line.line_type === "allowance") badges.push("Allowance")
        if (line.is_optional) badges.push("Optional")
        if (line.line_type === "option") badges.push("Choice")
        return {
          id: line.id,
          kind: isSection ? "section" : "item",
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unit_cost_cents: line.unit_cost_cents,
          amount_cents: amount,
          badges,
          notes: line.notes,
          muted: !!line.is_optional && line.is_selected === false,
        }
      }),
    [sortedLines, proposal.snapshot],
  )

  return (
    <QuotePortalShell
      orgName={proposal.org?.name}
      orgLogoUrl={proposal.org?.logo_url}
      documentLabel="Proposal"
      statusLabel={statusMeta.label}
      statusTone={statusMeta.tone}
      pdfUrl={pdfUrl}
      document={
        <QuoteDocumentView
          orgName={proposal.org?.name}
          orgLogoUrl={proposal.org?.logo_url}
          documentLabel="Proposal"
          title={proposal.title ?? proposal.number ?? "Project Proposal"}
          number={proposal.number}
          recipientName={proposal.recipient?.full_name}
          recipientEmail={proposal.recipient?.email}
          projectName={proposal.project?.name}
          issuedAt={proposal.created_at}
          validUntil={proposal.valid_until}
          summary={proposal.summary}
          terms={proposal.terms}
          lines={viewLines}
          totalCents={totals.total}
        />
      }
    >
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Project total</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{money(totals.total)}</p>
            {proposal.project?.name ? <p className="mt-1 text-xs text-muted-foreground">{proposal.project.name}</p> : null}
          </div>
          <Separator />
          <p className="text-sm text-muted-foreground">
            {requiresSignature
              ? "Review every page of the proposal above. When you're ready, continue to the execution document to sign electronically."
              : "Review every page of the proposal above. Your builder may send a separate execution document if a signature is needed."}
          </p>

          {continueSigningUrl ? (
            <Button className="w-full" asChild>
              <a href={continueSigningUrl}>Continue to execution document</a>
            </Button>
          ) : (
            <div className="border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              The execution document is not active yet. Please use the latest signing email from your builder.
            </div>
          )}

          {proposal.valid_until ? (
            <p className="text-xs text-muted-foreground">
              Expires on {formatLocalDate(proposal.valid_until, "MMM d, yyyy")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </QuotePortalShell>
  )
}
