import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

type EstimateLine = {
  description: string
  quantity?: number | null
  unit?: string | null
  unit_cost_cents?: number | null
  markup_pct?: number | null
  cost_code_id?: string | null
  metadata?: Record<string, any> | null
}

type EstimatePdfData = {
  orgName?: string
  estimateTitle: string
  estimateNumber?: string
  recipientName?: string
  summary?: string | null
  terms?: string | null
  subtotalCents?: number | null
  taxCents?: number | null
  totalCents?: number | null
  validUntil?: string | null
  lines: EstimateLine[]
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica" },
  header: { marginBottom: 16 },
  title: { fontSize: 18, fontWeight: "bold" },
  subTitle: { fontSize: 10, color: "#5b5b5b", marginTop: 4 },
  section: { marginTop: 12 },
  label: { fontSize: 9, color: "#6b6b6b", marginBottom: 4 },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#e5e5e5",
    paddingBottom: 6,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderColor: "#f0f0f0",
  },
  cellDesc: { flexGrow: 1 },
  cellQty: { width: 50, textAlign: "right" },
  cellCost: { width: 80, textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", width: 200 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  totalLabel: { color: "#6b6b6b" },
  totalValue: { fontWeight: "bold" },
})

function formatCurrency(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function EstimateDocument({ data }: { data: EstimatePdfData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>{data.estimateTitle}</Text>
          <Text style={styles.subTitle}>
            {data.orgName ? `${data.orgName} · ` : ""}Estimate
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Client</Text>
          <Text>{data.recipientName ?? "—"}</Text>
        </View>

        {data.summary && (
          <View style={styles.section}>
            <Text style={styles.label}>Summary</Text>
            <Text>{data.summary}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.label}>Line Items</Text>
          <View style={styles.tableHeader}>
            <Text style={styles.cellDesc}>Description</Text>
            <Text style={styles.cellQty}>Qty</Text>
            <Text style={styles.cellCost}>Line Total</Text>
          </View>
          {data.lines.map((line, idx) => {
            const qty = line.quantity ?? 1
            const unitCost = line.unit_cost_cents ?? 0
            const lineTotal = Math.round(qty * unitCost)
            return (
              <View key={`${line.description}-${idx}`} style={styles.row}>
                <Text style={styles.cellDesc}>{line.description}</Text>
                <Text style={styles.cellQty}>{qty}</Text>
                <Text style={styles.cellCost}>{formatCurrency(lineTotal)}</Text>
              </View>
            )
          })}
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
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCurrency(data.totalCents)}</Text>
          </View>
        </View>

        {data.terms && (
          <View style={styles.section}>
            <Text style={styles.label}>Terms</Text>
            <Text>{data.terms}</Text>
          </View>
        )}
      </Page>
    </Document>
  )
}

export async function renderEstimatePdf(data: EstimatePdfData) {
  const pdf = await renderToBuffer(<EstimateDocument data={data} />)
  return Buffer.from(pdf)
}
