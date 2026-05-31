import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
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

export type QuoteLine = {
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
  documentLabel?: string | null
  title: string
  number?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  projectName?: string | null
  summary?: string | null
  terms?: string | null
  subtotalCents?: number | null
  taxCents?: number | null
  totalCents?: number | null
  validUntil?: string | null
  /** Signature lines (proposal variant). Builder places real e-sign fields over these. */
  signers?: QuoteSigner[]
  lines: QuoteLine[]
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#1a1a1a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  brandBlock: { flexDirection: "column", maxWidth: 280 },
  logo: { maxWidth: 150, maxHeight: 48, marginBottom: 8, objectFit: "contain" },
  orgName: { fontSize: 13, fontWeight: "bold" },
  orgMeta: { fontSize: 9, color: "#6b6b6b", marginTop: 2 },
  docMetaBlock: { flexDirection: "column", alignItems: "flex-end" },
  docLabel: { fontSize: 9, color: "#6b6b6b", textTransform: "uppercase", letterSpacing: 1 },
  docTitle: { fontSize: 16, fontWeight: "bold", marginTop: 2, textAlign: "right", maxWidth: 220 },
  docNumber: { fontSize: 9, color: "#6b6b6b", marginTop: 4 },
  metaGrid: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20, gap: 16 },
  metaCol: { flexDirection: "column", flexGrow: 1 },
  label: { fontSize: 8, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  value: { fontSize: 10 },
  section: { marginTop: 16 },
  summaryText: { fontSize: 10, lineHeight: 1.5, color: "#333" },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1.5,
    borderColor: "#1a1a1a",
    paddingBottom: 6,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: "#ececec",
  },
  groupRow: { flexDirection: "row", paddingVertical: 6, marginTop: 4 },
  groupText: { fontSize: 10, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 0.5, color: "#444" },
  cellDesc: { flexGrow: 1, paddingRight: 8 },
  cellQty: { width: 60, textAlign: "right" },
  cellUnit: { width: 80, textAlign: "right" },
  cellCost: { width: 90, textAlign: "right" },
  headerText: { fontSize: 8, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: 0.5 },
  totals: { marginTop: 14, alignSelf: "flex-end", width: 240 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  totalLabel: { color: "#6b6b6b" },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 1.5,
    borderColor: "#1a1a1a",
  },
  grandLabel: { fontSize: 12, fontWeight: "bold" },
  grandValue: { fontSize: 12, fontWeight: "bold" },
  termsBox: { marginTop: 20, paddingTop: 12, borderTopWidth: 1, borderColor: "#ececec" },
  termsText: { fontSize: 9, lineHeight: 1.5, color: "#444" },
  sigSection: { marginTop: 36 },
  sigRow: { flexDirection: "row", gap: 32, marginTop: 24 },
  sigCol: { flexGrow: 1, flexBasis: 0 },
  sigLine: { borderBottomWidth: 1, borderColor: "#1a1a1a", height: 28, justifyContent: "flex-end" },
  sigImageBox: { borderBottomWidth: 1, borderColor: "#1a1a1a", height: 56, justifyContent: "flex-end" },
  sigImage: { maxHeight: 52, objectFit: "contain", marginBottom: 2 },
  sigLabel: { fontSize: 8, color: "#6b6b6b", marginTop: 4 },
  sigMeta: { fontSize: 9, marginTop: 2 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: "#9a9a9a",
    borderTopWidth: 1,
    borderColor: "#ececec",
    paddingTop: 6,
  },
})

function formatCurrency(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value?: string | null) {
  if (!value) return null
  // If it's a YYYY-MM-DD date string, format it timezone-safely in UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
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
  const signers = data.signers && data.signers.length > 0 ? data.signers : [{ role: "client", name: data.recipientName }]

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerRow}>
          <View style={styles.brandBlock}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image has no alt prop */}
            {data.orgLogoUrl ? <Image src={data.orgLogoUrl} style={styles.logo} /> : null}
            {data.orgName ? <Text style={styles.orgName}>{data.orgName}</Text> : null}
            {data.orgAddress ? <Text style={styles.orgMeta}>{data.orgAddress}</Text> : null}
          </View>
          <View style={styles.docMetaBlock}>
            <Text style={styles.docLabel}>{label}</Text>
            <Text style={styles.docTitle}>{data.title}</Text>
            {data.number ? <Text style={styles.docNumber}>#{data.number}</Text> : null}
          </View>
        </View>

        <View style={styles.metaGrid}>
          <View style={styles.metaCol}>
            <Text style={styles.label}>Prepared for</Text>
            <Text style={styles.value}>{data.recipientName ?? "—"}</Text>
            {data.recipientEmail ? <Text style={styles.orgMeta}>{data.recipientEmail}</Text> : null}
          </View>
          {data.projectName ? (
            <View style={styles.metaCol}>
              <Text style={styles.label}>Project</Text>
              <Text style={styles.value}>{data.projectName}</Text>
            </View>
          ) : null}
          {validUntil ? (
            <View style={styles.metaCol}>
              <Text style={styles.label}>Valid until</Text>
              <Text style={styles.value}>{validUntil}</Text>
            </View>
          ) : null}
        </View>

        {data.summary ? (
          <View style={styles.section}>
            <Text style={styles.label}>Summary</Text>
            <Text style={styles.summaryText}>{data.summary}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.tableHeader}>
            <Text style={[styles.cellDesc, styles.headerText]}>Description</Text>
            <Text style={[styles.cellQty, styles.headerText]}>Qty</Text>
            <Text style={[styles.cellUnit, styles.headerText]}>Unit</Text>
            <Text style={[styles.cellCost, styles.headerText]}>Amount</Text>
          </View>
          {data.lines.map((line, idx) =>
            line.item_type === "group" ? (
              <View key={`group-${idx}`} style={styles.groupRow}>
                <Text style={styles.groupText}>{line.description}</Text>
              </View>
            ) : (
              <View key={`line-${idx}`} style={styles.row} wrap={false}>
                <Text style={styles.cellDesc}>{line.description}</Text>
                <Text style={styles.cellQty}>{line.quantity ?? 1}</Text>
                <Text style={styles.cellUnit}>{formatCurrency(line.unit_cost_cents)}</Text>
                <Text style={styles.cellCost}>{formatCurrency(lineTotalCents(line))}</Text>
              </View>
            ),
          )}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text>{formatCurrency(data.subtotalCents)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Tax</Text>
            <Text>{formatCurrency(data.taxCents)}</Text>
          </View>
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>Total</Text>
            <Text style={styles.grandValue}>{formatCurrency(data.totalCents)}</Text>
          </View>
        </View>

        {data.terms ? (
          <View style={styles.termsBox} wrap={false}>
            <Text style={styles.label}>Terms &amp; Conditions</Text>
            <Text style={styles.termsText}>{data.terms}</Text>
          </View>
        ) : null}

        {data.variant === "proposal" ? (
          <View style={styles.sigSection} wrap={false}>
            <Text style={styles.label}>Acceptance &amp; Signatures</Text>
            <View style={styles.sigRow}>
              {signers.map((signer, idx) => (
                <View key={`sig-${idx}`} style={styles.sigCol}>
                  <View style={styles.sigImageBox}>
                    {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image has no alt prop */}
                    {signer.signatureImage ? <Image src={signer.signatureImage} style={styles.sigImage} /> : null}
                  </View>
                  <Text style={styles.sigLabel}>
                    Signature{signer.role ? ` · ${signer.role}` : ""}
                  </Text>
                  {signer.name ? <Text style={styles.sigMeta}>{signer.name}</Text> : null}
                  <View style={[styles.sigLine, { marginTop: 18 }]} />
                  <Text style={styles.sigLabel}>Date</Text>
                  {signer.signedAt ? <Text style={styles.sigMeta}>{formatDate(signer.signedAt)}</Text> : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>{data.orgName ?? ""}</Text>
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
