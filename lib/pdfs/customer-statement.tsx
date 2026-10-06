import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import type { PartyReceivablesSummary } from "@/lib/services/financial-parties"

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: "#111111" },
  title: { fontSize: 22, marginBottom: 12 },
  muted: { color: "#666666", marginBottom: 5 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#dddddd", paddingVertical: 9 },
  invoice: { width: "40%", paddingRight: 10 },
  date: { width: "20%" },
  money: { width: "20%", textAlign: "right" },
  total: { marginTop: 20, textAlign: "right", fontSize: 14 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, color: "#666666", fontSize: 8 },
})
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
export async function renderCustomerStatementPdf(input: { company: string; customer: string; asOf: string; invoices: PartyReceivablesSummary["open_invoices"] }) {
  return renderToBuffer(<Document title={`Statement — ${input.customer}`}>
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.muted}>{input.company}</Text>
      <Text style={styles.title}>Customer statement</Text>
      <Text>{input.customer}</Text>
      <Text style={styles.muted}>Open invoices as of {input.asOf}</Text>
      <View style={[styles.row, { marginTop: 20 }]} fixed><Text style={styles.invoice}>Invoice / project</Text><Text style={styles.date}>Due date</Text><Text style={styles.money}>Invoice total</Text><Text style={styles.money}>Outstanding</Text></View>
      {input.invoices.map(invoice => <View key={invoice.id} style={styles.row} wrap={false}>
        <View style={styles.invoice}><Text>{invoice.number}</Text><Text style={{ color: "#666666", fontSize: 9, marginTop: 4 }}>{invoice.project_name}</Text></View>
        <Text style={styles.date}>{invoice.due_date ?? "—"}</Text><Text style={styles.money}>{money(invoice.total_cents)}</Text><Text style={styles.money}>{money(invoice.balance_cents)}</Text>
      </View>)}
      {!input.invoices.length ? <Text style={{ marginTop: 20 }}>No outstanding invoices.</Text> : null}
      <Text style={styles.total}>Amount due {money(input.invoices.reduce((sum, invoice) => sum + invoice.balance_cents, 0))}</Text>
      <Text style={[styles.muted, { marginTop: 18 }]}>Balances include payments and credits applied to each invoice. Unapplied customer deposits are not deducted.</Text>
      <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => `${input.asOf} · Page ${pageNumber} of ${totalPages}`} />
    </Page>
  </Document>)
}
