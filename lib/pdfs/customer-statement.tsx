import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import type { CustomerStatement } from "@/lib/services/financial-parties"

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: "#111111" },
  title: { fontSize: 22, marginBottom: 12 },
  muted: { color: "#666666", marginBottom: 5 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#dddddd", paddingVertical: 9 },
  invoice: { width: "32%", paddingRight: 10 },
  date: { width: "14%" },
  money: { width: "20%", textAlign: "right" },
  aging: { flexDirection: "row", marginTop: 20, borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: "#dddddd", paddingVertical: 8 },
  agingCell: { flex: 1, textAlign: "right" },
  total: { marginTop: 20, textAlign: "right", fontSize: 14 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, color: "#666666", fontSize: 8 },
})
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
const AGING = [["current", "Current"], ["1_30", "1–30 days"], ["31_60", "31–60 days"], ["61_90", "61–90 days"], ["90_plus", "Over 90 days"]] as const

export async function renderCustomerStatementPdf(input: { company: string; customer: string; statement: CustomerStatement }) {
  const { statement } = input
  return renderToBuffer(<Document title={`Statement — ${input.customer}`}>
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.muted}>{input.company}</Text>
      <Text style={styles.title}>Customer statement</Text>
      <Text>{input.customer}</Text>
      <Text style={styles.muted}>Open invoices as of {statement.as_of}{statement.as_closed ? ` · as closed ${statement.as_closed.slice(0, 10)}` : ""}</Text>
      <View style={[styles.row, { marginTop: 20 }]} fixed><Text style={styles.invoice}>Invoice / project</Text><Text style={styles.date}>Issued</Text><Text style={styles.date}>Due</Text><Text style={styles.money}>Invoice total</Text><Text style={styles.money}>Outstanding</Text></View>
      {statement.invoices.map(invoice => <View key={invoice.id} style={styles.row} wrap={false}>
        <View style={styles.invoice}><Text>{invoice.number}</Text><Text style={{ color: "#666666", fontSize: 9, marginTop: 4 }}>{invoice.project_name}</Text></View>
        <Text style={styles.date}>{invoice.issue_date ?? "—"}</Text><Text style={styles.date}>{invoice.due_date ?? "—"}</Text><Text style={styles.money}>{money(invoice.total_cents)}</Text><Text style={styles.money}>{money(invoice.balance_cents)}</Text>
      </View>)}
      {!statement.invoices.length ? <Text style={{ marginTop: 20 }}>No outstanding invoices.</Text> : null}
      {statement.invoices.length ? <View style={styles.aging} wrap={false}>
        {AGING.map(([bucket, label]) => <View key={bucket} style={{ flex: 1 }}><Text style={[styles.agingCell, { color: "#666666", fontSize: 8 }]}>{label}</Text><Text style={[styles.agingCell, { marginTop: 4 }]}>{money(statement.aging[bucket])}</Text></View>)}
      </View> : null}
      <Text style={styles.total}>Amount due {money(statement.balance_cents)}</Text>
      <Text style={[styles.muted, { marginTop: 18 }]}>Balances include payments and credits applied to each invoice through {statement.as_of}. Unapplied customer deposits are not deducted.{statement.aging.no_due_date ? ` ${money(statement.aging.no_due_date)} has no due date.` : ""}</Text>
      <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => `${statement.as_of} · Page ${pageNumber} of ${totalPages}`} />
    </Page>
  </Document>)
}
