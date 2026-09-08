import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

import type { WaiverForm } from "@/lib/lien-waivers/forms"

/**
 * The payables-side waiver document.
 *
 * `lib/pdfs/lien-waiver.tsx` renders the receivables waiver the builder gives
 * its own client (`invoice_lien_waivers`). This one renders what a sub signs in
 * the portal against a payable, and unlike that one it prints a state's
 * prescribed statutory form when there is one — which is the whole reason a
 * lender or title company will accept it.
 */
export type PayablesLienWaiverPdfData = {
  form: WaiverForm
  claimantName: string
  customerName: string
  ownerName?: string | null
  propertyDescription: string
  projectName?: string | null
  billNumber?: string | null
  amountCents: number
  throughDate?: string | null
  /** The claimant's own carve-outs. The statutory paragraphs reference these. */
  exceptions?: string[]
  /** Absent for an unsigned copy — nothing that looks executed is printed then. */
  signerName?: string | null
  signerTitle?: string | null
  signatureText?: string | null
  signedAt?: string | null
  consentStatement?: string | null
  /** Audit trail. The waiver row's id, and the portal token when portal-signed. */
  waiverId: string
  portalTokenId?: string | null
}

function formatCurrency(cents: number) {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0
  return (safe / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
}

function formatTimestamp(value?: string | null) {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.toISOString().replace("T", " ").slice(0, 19)} UTC`
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, fontFamily: "Helvetica", lineHeight: 1.5 },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", textAlign: "center", marginBottom: 4 },
  citation: { textAlign: "center", fontSize: 9, color: "#555", marginBottom: 4 },
  statusLine: { textAlign: "center", fontSize: 10, color: "#555", marginBottom: 18 },
  notice: { marginBottom: 16, padding: 10, borderWidth: 1, borderColor: "#111", fontSize: 9, fontFamily: "Helvetica-Bold", lineHeight: 1.4 },
  fieldRow: { flexDirection: "row", marginTop: 6 },
  fieldLabel: { width: 140, color: "#555" },
  fieldValue: { flex: 1, fontFamily: "Helvetica-Bold" },
  bodyBlock: { marginTop: 16 },
  paragraph: { marginBottom: 8, textAlign: "justify" },
  sectionHeading: { marginTop: 14, marginBottom: 6, fontSize: 11, fontFamily: "Helvetica-Bold" },
  exception: { marginBottom: 3, paddingLeft: 10 },
  signature: { marginTop: 28 },
  signatureMark: { fontFamily: "Helvetica-Oblique", fontSize: 14, paddingBottom: 4 },
  rule: { borderTopWidth: 1, borderTopColor: "#111", width: 280, paddingTop: 4 },
  signatureMeta: { fontSize: 9, color: "#555" },
  blankBlock: { borderTopWidth: 1, borderTopColor: "#111", width: 280, marginTop: 34, paddingTop: 4 },
  notary: { marginTop: 26, padding: 10, borderWidth: 1, borderColor: "#777", fontSize: 9, lineHeight: 1.5 },
  footer: { marginTop: 28, fontSize: 8, color: "#777", lineHeight: 1.4 },
  audit: { marginTop: 10, fontSize: 7, color: "#999" },
})

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  )
}

function PayablesLienWaiverDocument({ data }: { data: PayablesLienWaiverPdfData }) {
  const { form } = data
  const exceptions = (data.exceptions ?? []).map((entry) => entry.trim()).filter(Boolean)
  const signed = Boolean(data.signerName && data.signerName.trim())
  const signatureMark = (data.signatureText ?? data.signerName ?? "").trim()

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.title}>{form.title}</Text>
        {form.statutoryCitation ? <Text style={styles.citation}>{form.statutoryCitation}</Text> : null}
        <Text style={styles.statusLine}>
          {data.billNumber ? `Invoice ${data.billNumber}` : "Payable"}
          {data.projectName ? ` • ${data.projectName}` : ""}
        </Text>

        {form.noticeBanner ? <Text style={styles.notice}>{form.noticeBanner}</Text> : null}

        <MetaRow label="Claimant / Lienor" value={data.claimantName} />
        <MetaRow label="Customer" value={data.customerName} />
        {data.ownerName ? <MetaRow label="Owner" value={data.ownerName} /> : null}
        <MetaRow label="Property" value={data.propertyDescription} />
        <MetaRow label="Payment amount" value={formatCurrency(data.amountCents)} />
        <MetaRow label="Through date" value={formatDate(data.throughDate)} />

        <View style={styles.bodyBlock}>
          {form.body.map((paragraph, index) => (
            <Text key={index} style={styles.paragraph}>
              {paragraph}
            </Text>
          ))}
        </View>

        {exceptions.length > 0 ? (
          <View>
            <Text style={styles.sectionHeading}>Exceptions</Text>
            {exceptions.map((entry, index) => (
              <Text key={index} style={styles.exception}>
                • {entry}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.signature} wrap={false}>
          {signed ? (
            <>
              <Text style={styles.signatureMark}>{signatureMark}</Text>
              <View style={styles.rule} />
              <Text style={styles.signatureMeta}>{data.signerName}</Text>
              <Text style={styles.signatureMeta}>{data.signerTitle ?? "Authorized representative"}</Text>
              <Text style={styles.signatureMeta}>Signed {formatTimestamp(data.signedAt)}</Text>
              <Text style={styles.signatureMeta}>{data.claimantName}</Text>
              {data.consentStatement ? (
                <Text style={{ ...styles.signatureMeta, marginTop: 8 }}>{data.consentStatement}</Text>
              ) : null}
            </>
          ) : (
            form.signatureBlocks.map((block, index) => (
              <View key={index} style={styles.blankBlock}>
                <Text style={styles.signatureMeta}>
                  {block.label}
                  {block.hint ? ` — ${block.hint}` : ""}
                </Text>
              </View>
            ))
          )}
        </View>

        {form.requiresNotary ? (
          <View style={styles.notary}>
            <Text>Notary acknowledgment</Text>
            <Text>
              State of ____________________ County of ____________________. Subscribed and sworn to (or affirmed) before
              me on this ______ day of ____________________, 20____, by ____________________, proved to me on the basis
              of satisfactory evidence to be the person who appeared before me.
            </Text>
            <Text>Notary signature ____________________ My commission expires ______________</Text>
          </View>
        ) : null}

        <Text style={styles.footer}>
          {form.statutory
            ? `Generated by Arc using the ${form.jurisdiction} statutory waiver form (${form.statutoryCitation}). Arc is not a law firm; confirm the current statutory text with counsel before relying on this document.`
            : "Generated by Arc. This is Arc's general waiver wording, not a state-prescribed statutory form. Some states require a specific form — confirm the current statutory text with counsel before relying on this document."}
        </Text>
        <Text style={styles.audit}>
          Waiver {data.waiverId}
          {data.portalTokenId ? ` • Portal access ${data.portalTokenId}` : ""}
          {signed ? " • Signed electronically" : ""}
        </Text>
      </Page>
    </Document>
  )
}

export async function renderPayablesLienWaiverPdf(data: PayablesLienWaiverPdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<PayablesLienWaiverDocument data={data} />)
  return Buffer.from(pdf)
}
