import { documentTheme } from "@/lib/pdfs/document-theme"
import { isBuiltInSection, paymentAmounts, type ProposalDocument, type ProposalSectionId } from "@/lib/precon/proposal-documents"
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import type { ReactNode } from "react"
import sharp from "sharp"

/**
 * Shared renderer for client-facing pricing documents.
 *
 * Both the estimate (negotiation artifact) and the proposal (execution artifact)
 * render through this single component so the client signs the exact document they
 * approved. The only differences are driven by `variant`:
 *  - "estimate"  → review copy, no signature block
 *  - "proposal"  → adds org-templated terms + a signature block for e-sign field placement
 */

export type QuoteVariant = "estimate" | "proposal"

export type QuotePricingDisplay = "itemized" | "subtotals" | "lump_sum" | "sections"

export type QuoteLine = {
  id?: string | null
  description: string
  quantity?: number | null
  unit?: string | null
  unit_cost_cents?: number | null
  markup_pct?: number | null
  item_type?: string | null
  metadata?: Record<string, any> | null
}

export type QuoteSigner = {
  role?: string | null
  name?: string | null
  signedAt?: string | null
  signatureImage?: string | null
}

export type QuoteDocumentData = {
  variant: QuoteVariant
  orgName?: string | null
  orgLogoUrl?: string | null
  orgAddress?: string | null
  /** Hex accent color (#rrggbb) for document chrome. */
  accentColor?: string | null
  /** Org's CSS font-family choice; mapped to a built-in PDF face. */
  fontFamily?: string | null
  documentLabel?: string | null
  title: string
  number?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  projectName?: string | null
  /** Issue date for the meta grid (mirrors the portal's "Issued" cell). */
  issuedAt?: string | null
  /** Cover note rendered above the summary. */
  intro?: string | null
  summary?: string | null
  terms?: string | null
  /** How much of the pricing breakdown to expose. Defaults to "itemized". */
  pricingDisplay?: QuotePricingDisplay | null
  /** Ids of optional add-ons the client accepted (folded into the main table). */
  acceptedOptionalIds?: string[] | null
  /** When true, optional add-ons that weren't accepted are omitted entirely. */
  hideUnacceptedOptionals?: boolean | null
  subtotalCents?: number | null
  taxCents?: number | null
  totalCents?: number | null
  /** A budget prints its range in place of a total. */
  totalRange?: { lowCents: number; highCents: number } | null
  /** Contingency already included in totalCents; rendered as its own row. */
  contingencyCents?: number | null
  contingencyPercent?: number | null
  /** Scope qualifications rendered alongside the terms. */
  inclusions?: string | null
  exclusions?: string | null
  validUntil?: string | null
  /** Signature lines (proposal variant). Builder places real e-sign fields over these. */
  signers?: QuoteSigner[]
  /** A deal proposal: the sections written around the price, replacing intro, summary, qualifications and terms. */
  proposal?: ProposalDocument | null
  /** The builder's questions for the client, and the answers given. */
  questions?: Array<{ question: string; answer: string | null }>
  lines: QuoteLine[]
}

const DEFAULT_ACCENT = documentTheme.colors.text

function resolveAccent(value?: string | null): string {
  if (typeof value !== "string") return DEFAULT_ACCENT
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : DEFAULT_ACCENT
}

/**
 * Maps the org's CSS font-family choice to a react-pdf built-in face so the PDF
 * carries the same serif / sans / mono character as the portal — without fetching
 * a web font at render time (which could fail and break PDF generation).
 */
function resolveFontFamily(css?: string | null): string {
  if (typeof css !== "string") return "Helvetica"
  const v = css.toLowerCase()
  if (v.includes("mono") || v.includes("courier")) return "Courier"
  if ((v.includes("serif") && !v.includes("sans-serif")) || v.includes("georgia") || v.includes("times")) return "Times-Roman"
  return "Helvetica"
}

// Shared invoice identity, with room for scope qualifications and signatures.
const MUTED = documentTheme.colors.muted
const HAIRLINE = documentTheme.colors.line
const ROW_LINE = documentTheme.colors.line

const styles = StyleSheet.create({
  page: { ...documentTheme.page, paddingBottom: 60, color: documentTheme.colors.text },
  letterhead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 24 },
  logo: { maxWidth: 160, maxHeight: 56, objectFit: "contain" },
  docLabel: documentTheme.title,
  subtitle: { fontSize: 10.5, marginTop: 4, color: MUTED },
  title: { fontSize: 16, fontWeight: "bold", marginTop: 28, letterSpacing: -0.1 },
  metaGrid: { marginTop: 22 },
  metaRow: { flexDirection: "row", marginBottom: 5 },
  metaLabel: { ...documentTheme.label, width: 96 },
  metaValue: { fontSize: 10, flex: 1 },
  parties: { marginTop: 22, flexDirection: "row", gap: 32 },
  party: { flex: 1 },
  partyLabel: { ...documentTheme.label, marginBottom: 5 },
  partyLine: { fontSize: 10, lineHeight: 1.4 },

  introText: { fontSize: 10, lineHeight: 1.6, color: "#2a2a2a", marginTop: 22 },

  scopeBlock: { marginTop: 22 },
  blockLabel: { fontSize: 9.5, fontWeight: "bold", color: documentTheme.colors.text, marginBottom: 6 },
  scopeText: { fontSize: 10, lineHeight: 1.5, color: "#2a2a2a" },

  // Line items
  breakdownHeader: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, paddingBottom: 6, marginTop: 28 },
  breakdownLabel: { fontSize: 9.5, fontWeight: "bold", color: documentTheme.colors.text },
  sectionRow: { paddingTop: 16, paddingBottom: 2 },
  sectionText: { fontSize: 9, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 0.6 },
  itemRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", ...documentTheme.row },
  itemLeft: { flexGrow: 1, flexBasis: 0, paddingRight: 18 },
  itemDesc: { fontSize: 10 },
  itemNotes: { fontSize: 8, color: MUTED, marginTop: 2, lineHeight: 1.4 },
  itemUnitLine: { fontSize: 8, color: MUTED, marginTop: 3 },
  itemAmount: { fontSize: 10, textAlign: "right" },

  // Optional add-ons
  optionalSection: { marginTop: 22 },
  optionalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 9, borderBottomWidth: 1, borderColor: ROW_LINE, borderStyle: "dashed" },
  optionalAmount: { fontSize: 10, fontWeight: "bold", textAlign: "right" },

  totals: { width: documentTheme.totalsWidth, marginLeft: "auto", marginTop: 16 },
  contingencyRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  contingencyText: { fontSize: 9.5, color: MUTED },
  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, paddingTop: 8, marginTop: 6 },
  totalLabel: { fontSize: 10, fontWeight: "bold" },
  totalValue: { fontSize: 11, fontWeight: "bold" },
  termsBox: { marginTop: 20 },
  termsText: { fontSize: 9.5, lineHeight: 1.5, color: documentTheme.colors.text },

  // Signature block (proposal variant)
  sigSection: { marginTop: 32 },
  sigRow: { flexDirection: "row", gap: 32, marginTop: 20 },
  sigCol: { flexGrow: 1, flexBasis: 0 },
  sigLine: { borderBottomWidth: 1, borderColor: "#1a1a1a", height: 28, justifyContent: "flex-end" },
  sigLineText: { fontSize: 9, marginBottom: 3 },
  sigImageBox: { borderBottomWidth: 1, borderColor: "#1a1a1a", height: 56, justifyContent: "flex-end" },
  sigImage: { maxHeight: 52, objectFit: "contain", marginBottom: 2 },
  sigLabel: { fontSize: 8, color: "#6b6b6b", marginTop: 4 },
  sigMeta: { fontSize: 9, marginTop: 2 },

  sectionTitle: { fontSize: 11, fontWeight: "bold", marginTop: 24, paddingBottom: 5, borderBottomWidth: 1 },
  subTitle: { fontSize: 10, fontWeight: "bold", marginTop: 10 },
  faintText: { fontSize: 8.5, color: MUTED, marginTop: 3, lineHeight: 1.4 },
  twoCols: { flexDirection: "row", gap: 24, marginTop: 8 },
  bullet: { fontSize: 9.5, lineHeight: 1.5 },

  footer: {
    position: "absolute",
    bottom: 28,
    left: 48,
    right: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: "#9a9a9a",
    borderTopWidth: 1,
    borderColor: HAIRLINE,
    paddingTop: 6,
  },
})

function formatCurrency(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

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
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    }
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function lineTotalCents(line: QuoteLine): number {
  const qty = line.quantity ?? 1
  const unitCost = line.unit_cost_cents ?? 0
  const base = qty * unitCost
  const markup = Math.round((base * (line.markup_pct ?? 0)) / 100)
  return Math.round(base + markup)
}

function QuoteDocument({ data }: { data: QuoteDocumentData }) {
  const label = data.documentLabel ?? (data.variant === "proposal" ? "Proposal" : "Estimate")
  const validUntil = formatDate(data.validUntil)
  const issued = formatDate(data.issuedAt)
  const signers = data.signers && data.signers.length > 0 ? data.signers : [{ role: "client", name: data.recipientName }]
  const accent = resolveAccent(data.accentColor)
  const pricing: QuotePricingDisplay = data.pricingDisplay ?? "itemized"
  const showAmounts = pricing !== "lump_sum"
  const showUnitLine = pricing === "itemized"

  // Optional add-ons render in their own block (mirrors the portal). On signed
  // docs only the accepted ones are shown — they're already in the total.
  const accepted = new Set((data.acceptedOptionalIds ?? []).filter(Boolean) as string[])
  const isOptional = (l: QuoteLine) => l.metadata?.is_optional === true
  const isAcceptedOptional = (l: QuoteLine) => isOptional(l) && l.id != null && accepted.has(String(l.id))
  const mainLines = data.lines.filter((l) => !isOptional(l))
  const optionalLines = data.hideUnacceptedOptionals
    ? data.lines.filter((l) => isOptional(l) && isAcceptedOptional(l))
    : data.lines.filter((l) => isOptional(l))

  // Client-facing unit price is the SELL rate (cost + markup); the raw unit
  // cost is the builder's basis and never appears on the document.
  const unitSellCents = (line: QuoteLine) =>
    Math.round((line.unit_cost_cents ?? 0) * (1 + (line.markup_pct ?? 0) / 100))
  const unitLineText = (line: QuoteLine) =>
    `${line.quantity ?? 1}${line.unit ? ` ${line.unit}` : ""} × ${formatCurrency(unitSellCents(line))}`

  const addressLines = (data.orgAddress ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
  const proposal = data.proposal ?? null
  const sectionTitle = (title: string) => (
    <Text style={[styles.sectionTitle, { borderColor: accent }]} minPresenceAhead={40}>{title}</Text>
  )
  // "By section": each section's total, with its lines listed by name.
  const sections: Array<{ name: string; lines: QuoteLine[] }> = []
  for (const line of mainLines) {
    if (line.item_type === "group") sections.push({ name: line.description, lines: [] })
    else {
      if (!sections.length) sections.push({ name: "Work", lines: [] })
      sections[sections.length - 1].lines.push(line)
    }
  }
  const basePrice = data.totalCents ?? 0
  const payments = proposal ? paymentAmounts(basePrice, proposal.payments) : []
  const proposalSigners: QuoteSigner[] = proposal
    ? data.signers?.length
      ? data.signers
      : [...proposal.signers.map((signer) => ({ role: "Client", name: signer.name })), { role: data.orgName ?? "Builder", name: null }]
    : signers

  const lineItems = (
    <>
      <View style={[styles.breakdownHeader, proposal ? { marginTop: 10, borderColor: HAIRLINE } : { borderColor: accent }]} minPresenceAhead={48}>
        <Text style={styles.breakdownLabel}>{proposal ? (pricing === "sections" ? "Section" : "Work") : "Scope & pricing"}</Text>
        {showAmounts ? <Text style={styles.breakdownLabel}>Amount</Text> : null}
      </View>
      {pricing === "sections" ? sections.map((section, idx) => (
        <View key={`section-${idx}`} style={styles.itemRow} wrap={false}>
          <View style={styles.itemLeft}>
            <Text style={styles.itemDesc}>{section.name}</Text>
            <Text style={styles.itemNotes}>
              {section.lines.map((line) => `${line.description}${line.metadata?.is_allowance === true ? " (allowance)" : ""}`).join(" · ")}
            </Text>
          </View>
          <Text style={styles.itemAmount}>{formatCurrency(section.lines.reduce((sum, line) => sum + lineTotalCents(line), 0))}</Text>
        </View>
      )) : mainLines.map((line, idx) =>
        line.item_type === "group" ? (
          <View key={`group-${idx}`} style={styles.sectionRow} minPresenceAhead={36}>
            <Text style={[styles.sectionText, { color: accent }]}>{line.description}</Text>
          </View>
        ) : (
          <View key={`line-${line.id ?? idx}`} style={styles.itemRow} wrap={false}>
            <View style={styles.itemLeft}>
              <Text style={styles.itemDesc}>
                {line.description}
                {line.metadata?.is_allowance === true ? "  (Allowance)" : ""}
              </Text>
              {line.metadata?.notes && !proposal ? <Text style={styles.itemNotes}>{line.metadata.notes}</Text> : null}
              {showUnitLine ? <Text style={styles.itemUnitLine}>{unitLineText(line)}</Text> : null}
            </View>
            {showAmounts ? <Text style={styles.itemAmount}>{formatCurrency(lineTotalCents(line))}</Text> : null}
          </View>
        ),
      )}
    </>
  )
  const optionRows = optionalLines.map((line, idx) => {
    const isAccepted = isAcceptedOptional(line)
    return (
      <View key={`opt-${line.id ?? idx}`} style={styles.optionalRow} wrap={false}>
        <View style={styles.itemLeft}>
          <Text style={styles.itemDesc}>{line.description}</Text>
          {line.metadata?.notes ? <Text style={styles.itemNotes}>{line.metadata.notes}</Text> : null}
        </View>
        {isAccepted ? (
          <Text style={[styles.optionalAmount, { color: accent }]}>
            Included{showAmounts ? ` · ${formatCurrency(lineTotalCents(line))}` : ""}
          </Text>
        ) : showAmounts ? (
          <Text style={[styles.optionalAmount, { color: MUTED }]}>+ {formatCurrency(lineTotalCents(line))}</Text>
        ) : null}
      </View>
    )
  })
  const optionsList = (
    <View style={styles.optionalSection}>
      <View style={[styles.breakdownHeader, { marginTop: 0, borderColor: HAIRLINE }]}>
        <Text style={styles.breakdownLabel}>Optional add-ons</Text>
      </View>
      {optionRows}
    </View>
  )
  const totalsBlock = (
    <View style={styles.totals} wrap={false}>
      {showAmounts && data.subtotalCents != null ? (
        <View style={styles.contingencyRow}><Text style={styles.contingencyText}>Subtotal</Text><Text>{formatCurrency(data.totalCents != null ? data.totalCents - (data.taxCents ?? 0) - (data.contingencyCents ?? 0) : data.subtotalCents)}</Text></View>
      ) : null}
      {(data.contingencyCents ?? 0) > 0 ? (
        <View style={styles.contingencyRow}><Text style={styles.contingencyText}>Contingency{data.contingencyPercent ? ` (${data.contingencyPercent}%)` : ""}</Text><Text>{formatCurrency(data.contingencyCents)}</Text></View>
      ) : null}
      {(data.taxCents ?? 0) > 0 ? (
        <View style={styles.contingencyRow}><Text style={styles.contingencyText}>Tax</Text><Text>{formatCurrency(data.taxCents)}</Text></View>
      ) : null}
      {data.totalRange ? (
        <>
          <View style={[styles.totalRow, { borderColor: accent }]}>
            <Text style={styles.totalLabel}>Expected range</Text>
            <Text style={styles.totalValue}>{formatCurrency(data.totalRange.lowCents)} – {formatCurrency(data.totalRange.highCents)}</Text>
          </View>
          <Text style={styles.contingencyText}>An estimate to plan with, not a contract. The fixed price follows once trade quotes and measurements are in.</Text>
        </>
      ) : (
        <View style={[styles.totalRow, { borderColor: accent }]}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatCurrency(data.totalCents)} USD</Text>
        </View>
      )}
    </View>
  )
  const questionsList = (data.questions ?? []).map((item, index) => (
    <View key={index} style={{ marginTop: 6 }}>
      <Text style={styles.scopeText}>{index + 1}. {item.question}</Text>
      <Text style={styles.faintText}>{item.answer ?? "Not answered yet."}</Text>
    </View>
  ))
  const signatureLines = (
    <View style={[styles.sigRow, { flexWrap: "wrap" }]}>
      {proposalSigners.map((signer, idx) => (
        <View key={`sig-${idx}`} style={styles.sigCol}>
          <View style={styles.sigImageBox}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image has no alt prop */}
            {signer.signatureImage ? <Image src={signer.signatureImage} style={styles.sigImage} /> : signer.signedAt && signer.name ? (
              // A typed signature is the signature: the signer's name, as they typed it.
              <Text style={{ fontFamily: "Times-Italic", fontSize: 16, marginBottom: 4 }}>{signer.name}</Text>
            ) : null}
          </View>
          <Text style={styles.sigLabel}>
            Signature{signer.role ? ` · ${signer.role}` : ""}
          </Text>
          {signer.name ? <Text style={styles.sigMeta}>{signer.name}</Text> : null}
          <View style={[styles.sigLine, { marginTop: 18 }]}>
            {signer.signedAt ? <Text style={styles.sigLineText}>{formatDate(signer.signedAt)}</Text> : null}
          </View>
          <Text style={styles.sigLabel}>Date</Text>
        </View>
      ))}
    </View>
  )
  // Each built-in section's content, or null when it has nothing to show. The
  // proposal decides the order, the headings and which sections are on.
  const sectionContent: Record<ProposalSectionId, ReactNode> | null = proposal ? {
    cover: proposal.cover.trim() ? <Text style={[styles.introText, { marginTop: 8 }]}>{proposal.cover}</Text> : null,
    scope: proposal.scope.length ? proposal.scope.map((paragraph, index) => (
      <View key={index} wrap={paragraph.text.length > 1200}>
        {paragraph.section ? <Text style={styles.subTitle} minPresenceAhead={24}>{paragraph.section}</Text> : null}
        {paragraph.text ? <Text style={[styles.scopeText, { marginTop: 3 }]}>{paragraph.text}</Text> : null}
        <Text style={styles.faintText}>{paragraph.lines.join(" · ")}</Text>
      </View>
    )) : null,
    price: <>{lineItems}{totalsBlock}</>,
    options: optionRows.length ? optionRows : null,
    allowances: proposal.allowances.length ? (
      <>
        {proposal.allowances.map((item, index) => (
          <View key={index} style={styles.itemRow} wrap={false}>
            <View style={styles.itemLeft}>
              <Text style={styles.itemDesc}>{item.description}</Text>
              {item.section ? <Text style={styles.itemNotes}>{item.section}</Text> : null}
            </View>
            <Text style={styles.itemAmount}>{formatCurrency(item.amount_cents)}</Text>
          </View>
        ))}
        <Text style={styles.faintText}>{proposal.allowance_policy}</Text>
      </>
    ) : null,
    inclusions: proposal.inclusions.length || proposal.exclusions.length ? (
      <View style={styles.twoCols}>
        {([["Included", proposal.inclusions], ["Not included", proposal.exclusions]] satisfies Array<[string, string[]]>).filter(([, items]) => items.length).map(([name, items]) => (
          <View key={name} style={{ flex: 1 }}>
            <Text style={[styles.blockLabel, { marginBottom: 3 }]}>{name}</Text>
            {items.map((item, index) => <Text key={index} style={styles.bullet}>• {item}</Text>)}
          </View>
        ))}
      </View>
    ) : null,
    payments: proposal.payments.length ? proposal.payments.map((payment, index) => (
      <View key={index} style={styles.itemRow}>
        <View style={styles.itemLeft}>
          <Text style={styles.itemDesc}>{payment.name}</Text>
          {payment.when ? <Text style={styles.itemNotes}>{payment.when}</Text> : null}
        </View>
        <Text style={[styles.itemAmount, { color: MUTED, width: 40 }]}>{payment.percent}%</Text>
        <Text style={[styles.itemAmount, { width: 90 }]}>{formatCurrency(payments[index])}</Text>
      </View>
    )) : null,
    schedule: proposal.start_window ? (
      <Text style={[styles.scopeText, { marginTop: 8 }]}>
        We plan to start {proposal.start_window}{proposal.duration_weeks ? ` and finish in about ${proposal.duration_weeks} weeks` : ""}.
        {proposal.kind === "agreement" ? " We confirm the start date when you sign." : ""}
      </Text>
    ) : null,
    terms: (
      <>
        {proposal.terms.trim() ? <Text style={[styles.termsText, { marginTop: 8 }]}>{proposal.terms}</Text> : null}
        <Text style={styles.faintText}>
          This proposal is valid until {formatDate(proposal.valid_until)}.
          {proposal.kind === "budget" ? " It is an estimate for your approval, not a contract. The fixed price follows once it is firm." : ""}
        </Text>
      </>
    ),
    signatures: proposal.kind === "agreement" ? signatureLines : null,
    questions: questionsList.length ? questionsList : null,
  } : null
  // Short sections stay on one page; long ones may break.
  const keepTogether = new Set<string>(["allowances", "inclusions", "payments", "schedule", "signatures", "questions"])

  return (
    <Document>
      <Page size="LETTER" style={[styles.page, { fontFamily: resolveFontFamily(data.fontFamily) }]}>
        <View style={styles.letterhead} wrap={false}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.docLabel, { color: accent }]}>{label}</Text>
            {data.projectName ? <Text style={styles.subtitle}>{data.projectName}</Text> : null}
          </View>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- PDF image */}
          {data.orgLogoUrl ? <Image src={data.orgLogoUrl} style={styles.logo} /> : null}
        </View>
        <View style={styles.metaGrid} wrap={false}>
          {[["Document number", data.number], ["Date of issue", issued], ["Valid until", validUntil]].filter(([, value]) => value).map(([name, value]) => (
            <View key={name} style={styles.metaRow}>
              <Text style={styles.metaLabel}>{name}</Text><Text style={styles.metaValue}>{value}</Text>
            </View>
          ))}
        </View>
        <View style={styles.parties} wrap={false}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>From</Text>
            <Text style={styles.partyLine}>{data.orgName ?? ""}</Text>
            {addressLines.map((line, i) => <Text key={i} style={styles.partyLine}>{line}</Text>)}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Prepared for</Text>
            <Text style={styles.partyLine}>{data.recipientName ?? "—"}</Text>
            {data.recipientEmail ? <Text style={styles.partyLine}>{data.recipientEmail}</Text> : null}
          </View>
        </View>
        <Text style={styles.title} minPresenceAhead={36}>{data.title}</Text>

        {proposal ? (
          proposal.sections.map((section) => {
            const content = isBuiltInSection(section.key) ? sectionContent?.[section.key] : section.body.trim() ? (
              <Text style={[styles.scopeText, { marginTop: 8 }]}>{section.body}</Text>
            ) : null
            return content ? (
              <View key={section.key} wrap={!keepTogether.has(section.key) && (isBuiltInSection(section.key) || section.body.length > 1200)}>
                {sectionTitle(section.title)}
                {content}
              </View>
            ) : null
          })
        ) : (
          <>
            {data.intro ? <Text style={styles.introText}>{data.intro}</Text> : null}
            {data.summary ? (
              <View style={styles.scopeBlock}>
                <Text style={styles.scopeText}>{data.summary}</Text>
              </View>
            ) : null}
            {lineItems}
            {optionalLines.length > 0 ? optionsList : null}
            {totalsBlock}
            {data.questions?.length ? (
              <View wrap={false}>
                <Text style={[styles.blockLabel, { marginTop: 20 }]}>Questions for you</Text>
                {questionsList}
              </View>
            ) : null}
            {data.inclusions ? (
              <View style={styles.termsBox} wrap={data.inclusions.length > 1200}>
                <Text style={styles.blockLabel} minPresenceAhead={28}>Included in this price</Text>
                <Text style={styles.termsText}>{data.inclusions}</Text>
              </View>
            ) : null}
            {data.exclusions ? (
              <View style={styles.termsBox} wrap={data.exclusions.length > 1200}>
                <Text style={styles.blockLabel} minPresenceAhead={28}>Not included</Text>
                <Text style={styles.termsText}>{data.exclusions}</Text>
              </View>
            ) : null}
            {data.terms ? (
              <View style={styles.termsBox} wrap={data.terms.length > 1200}>
                <Text style={styles.blockLabel} minPresenceAhead={28}>Terms &amp; conditions</Text>
                <Text style={styles.termsText}>{data.terms}</Text>
              </View>
            ) : null}
            {data.variant === "proposal" ? (
              <View style={styles.sigSection} wrap={false}>
                <Text style={styles.blockLabel} minPresenceAhead={28}>Acceptance &amp; Signatures</Text>
                {signatureLines}
              </View>
            ) : null}
          </>
        )}

        <View style={styles.footer} fixed>
          <Text>{[data.orgName, data.number].filter(Boolean).join(" · ")}</Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}

/**
 * @react-pdf/renderer mis-renders PNG logos that carry an alpha channel — the
 * image comes out ghosted/duplicated with shifted colors. Flattening the logo
 * onto a white background and re-encoding to a clean PNG renders it once,
 * correctly. Falls back to the original URL if anything goes wrong.
 */
async function flattenLogoForPdf(orgLogoUrl?: string | null): Promise<string | null> {
  if (!orgLogoUrl) return null
  try {
    let input: Buffer
    if (orgLogoUrl.startsWith("data:")) {
      input = Buffer.from(orgLogoUrl.split(",")[1] ?? "", "base64")
    } else {
      const res = await fetch(orgLogoUrl)
      if (!res.ok) return orgLogoUrl
      input = Buffer.from(await res.arrayBuffer())
    }
    const flattened = await sharp(input).flatten({ background: "#ffffff" }).png().toBuffer()
    return `data:image/png;base64,${flattened.toString("base64")}`
  } catch {
    return orgLogoUrl
  }
}

export async function renderQuotePdf(data: QuoteDocumentData): Promise<Buffer> {
  const orgLogoUrl = await flattenLogoForPdf(data.orgLogoUrl)
  const pdf = await renderToBuffer(<QuoteDocument data={{ ...data, orgLogoUrl }} />)
  return Buffer.from(pdf)
}
