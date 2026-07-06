import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

export type LienWaiverPdfData = {
  waiverType: "conditional_progress" | "unconditional_progress" | "conditional_final" | "unconditional_final"
  status: "pending_payment" | "released" | "void"
  claimantName: string
  customerName: string
  propertyDescription: string
  invoiceNumber: string
  projectName?: string | null
  amountCents: number
  throughDate?: string | null
  releasedAt?: string | null
  issuedAt: string
}

const TITLES: Record<LienWaiverPdfData["waiverType"], string> = {
  conditional_progress: "Conditional Waiver and Release of Lien Upon Progress Payment",
  unconditional_progress: "Unconditional Waiver and Release of Lien Upon Progress Payment",
  conditional_final: "Conditional Waiver and Release of Lien Upon Final Payment",
  unconditional_final: "Unconditional Waiver and Release of Lien Upon Final Payment",
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

function bodyText(data: LienWaiverPdfData): string {
  const amount = formatCurrency(data.amountCents)
  const through = formatDate(data.throughDate)
  const isConditional = data.waiverType.startsWith("conditional")
  const isFinal = data.waiverType.endsWith("final")

  const scope = isFinal
    ? "all liens, lien rights, and rights to claim a lien for labor, services, or materials furnished"
    : `its lien and right to claim a lien for labor, services, or materials furnished through ${through}`

  if (isConditional) {
    return (
      `Upon receipt by the undersigned of payment in the sum of ${amount} payable to ${data.claimantName}, ` +
      `and when the payment has been properly endorsed and has been paid by the bank on which it is drawn, ` +
      `this document shall become effective to waive and release ${scope} to ${data.customerName} ` +
      `on the property described below. This waiver and release is conditioned upon actual receipt of payment ` +
      `and is effective only to the extent of the payment actually received. Before any recipient of this document ` +
      `relies on it, the recipient should verify evidence of payment to the undersigned.`
    )
  }
  return (
    `The undersigned has been paid and has received payment in the sum of ${amount} for labor, services, ` +
    `or materials furnished to ${data.customerName} on the property described below, and does hereby waive ` +
    `and release ${scope}. This waiver and release is unconditional${isFinal ? " and constitutes a final release with respect to the property described below" : ""}.`
  )
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, fontFamily: "Helvetica", lineHeight: 1.5 },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", textAlign: "center", marginBottom: 4 },
  statusLine: { textAlign: "center", fontSize: 10, color: "#555", marginBottom: 20 },
  body: { marginTop: 8, marginBottom: 16, textAlign: "justify" },
  fieldRow: { flexDirection: "row", marginTop: 6 },
  fieldLabel: { width: 140, color: "#555" },
  fieldValue: { flex: 1, fontFamily: "Helvetica-Bold" },
  signature: { marginTop: 40 },
  signatureLine: { borderTopWidth: 1, borderTopColor: "#111", width: 260, marginTop: 36, paddingTop: 4 },
  small: { fontSize: 8, color: "#777", marginTop: 32 },
  released: { marginTop: 16, padding: 10, borderWidth: 1, borderColor: "#16a34a", color: "#166534", fontSize: 10 },
  pending: { marginTop: 16, padding: 10, borderWidth: 1, borderColor: "#d97706", color: "#92400e", fontSize: 10 },
})

function LienWaiverDocument({ data }: { data: LienWaiverPdfData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.title}>{TITLES[data.waiverType]}</Text>
        <Text style={styles.statusLine}>
          Invoice {data.invoiceNumber}
          {data.projectName ? ` • ${data.projectName}` : ""} • Issued {formatDate(data.issuedAt)}
        </Text>

        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Claimant / Lienor</Text>
          <Text style={styles.fieldValue}>{data.claimantName}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Customer / Owner</Text>
          <Text style={styles.fieldValue}>{data.customerName}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Property</Text>
          <Text style={styles.fieldValue}>{data.propertyDescription}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Payment amount</Text>
          <Text style={styles.fieldValue}>{formatCurrency(data.amountCents)}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Through date</Text>
          <Text style={styles.fieldValue}>{formatDate(data.throughDate)}</Text>
        </View>

        <Text style={styles.body}>{bodyText(data)}</Text>

        {data.status === "released" ? (
          <Text style={styles.released}>
            Payment received — this waiver was released on {formatDate(data.releasedAt)}.
          </Text>
        ) : data.waiverType.startsWith("conditional") ? (
          <Text style={styles.pending}>
            Payment not yet received — this conditional waiver becomes effective upon receipt of the payment described above.
          </Text>
        ) : null}

        <View style={styles.signature}>
          <View style={styles.signatureLine}>
            <Text>{data.claimantName}</Text>
            <Text style={{ color: "#555", fontSize: 9 }}>Authorized representative</Text>
          </View>
          <View style={{ ...styles.signatureLine, width: 160 }}>
            <Text>{formatDate(data.releasedAt ?? data.issuedAt)}</Text>
            <Text style={{ color: "#555", fontSize: 9 }}>Date</Text>
          </View>
        </View>

        <Text style={styles.small}>
          Generated by Arc for {data.claimantName}. Some states require specific statutory waiver forms — review with your
          attorney before relying on this document. This waiver does not cover retainage, disputed claims, or amounts beyond
          the payment described above unless expressly stated.
        </Text>
      </Page>
    </Document>
  )
}

export async function renderLienWaiverPdf(data: LienWaiverPdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<LienWaiverDocument data={data} />)
  return Buffer.from(pdf)
}
