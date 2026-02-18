import { Document, Image, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

export type InvoicePdfLine = {
  description: string
  quantity: number
  unit: string
  unitCostCents: number
  lineTotalCents: number
}

export type InvoicePdfData = {
  invoiceNumber: string
  title?: string
  logoUrl?: string
  issueDate?: string
  dueDate?: string
  fromLines: string[]
  billToLines: string[]
  projectName?: string
  notes?: string
  payUrl?: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  taxRate?: number
  lines: InvoicePdfLine[]
}

const palette = {
  bg: "#FFFFFF",
  text: "#111827",
  muted: "#6B7280",
  line: "#E5E7EB",
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 34,
    paddingHorizontal: 42,
    backgroundColor: palette.bg,
    color: palette.text,
    fontFamily: "Helvetica",
    fontSize: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  headingWrap: {
    width: "58%",
    minHeight: 82,
    justifyContent: "flex-end",
  },
  title: {
    fontFamily: "Times-Roman",
    fontSize: 34,
    color: "#111111",
    letterSpacing: 0.15,
  },
  subtitle: {
    marginTop: 6,
    fontSize: 11,
    color: palette.muted,
    lineHeight: 1.35,
  },
  logoWrap: {
    width: 220,
    height: 82,
    alignItems: "flex-end",
    justifyContent: "flex-end",
  },
  logo: {
    maxWidth: 220,
    maxHeight: 82,
    objectFit: "contain",
  },
  section: {
    marginTop: 20,
  },
  sectionLg: {
    marginTop: 26,
  },
  twoCol: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
  },
  col: {
    width: "47%",
  },
  colRight: {
    width: "47%",
    alignItems: "flex-end",
  },
  label: {
    fontSize: 9.5,
    color: palette.muted,
    marginBottom: 6,
  },
  value: {
    fontSize: 10.5,
    color: palette.text,
    lineHeight: 1.35,
    marginBottom: 3,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
  },
  metaCell: {
    flex: 1,
  },
  metaCellRight: {
    flex: 1,
    alignItems: "flex-end",
  },
  metaValue: {
    fontSize: 11,
    color: palette.text,
  },
  table: {
    marginTop: 10,
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 2,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  th: {
    fontSize: 9.5,
    color: palette.muted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  td: {
    fontSize: 10.8,
    color: palette.text,
  },
  totalsWrap: {
    width: 260,
    marginLeft: "auto",
    marginTop: 12,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  totalLabel: {
    fontSize: 10,
    color: palette.muted,
  },
  totalValue: {
    fontSize: 11,
    color: palette.text,
  },
  grandTotal: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  grandTotalLabel: {
    fontSize: 11,
    color: palette.muted,
  },
  grandTotalValue: {
    fontSize: 13,
    fontWeight: 700,
    color: palette.text,
  },
  footerDividerTop: {
    marginTop: 24,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  paymentRow: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
  },
  paymentDetailsWrap: {
    flex: 1,
  },
  notesText: {
    marginTop: 2,
    fontSize: 10.5,
    color: palette.text,
    lineHeight: 1.45,
  },
  payButton: {
    borderWidth: 1,
    borderColor: "#93C5FD",
    backgroundColor: "#EFF6FF",
    borderRadius: 6,
    paddingHorizontal: 0,
    paddingVertical: 6,
    color: "#1D4ED8",
    fontSize: 10.25,
    fontWeight: 600,
    textDecoration: "none",
    width: 112,
    textAlign: "center",
  },
  footerDividerBottom: {
    marginTop: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
})

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function cleanLines(lines: string[]) {
  const cleaned = lines
    .flatMap((line) => String(line ?? "").split(/\n|,/g))
    .map((line) => line.trim())
    .filter(Boolean)
  return cleaned.length > 0 ? cleaned : ["-"]
}

function formatDate(value?: string) {
  if (!value) return "-"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function InvoicePdfDocument({ data }: { data: InvoicePdfData }) {
  const fromLines = cleanLines(data.fromLines)
  const billToLines = cleanLines(data.billToLines)
  const notesText = data.notes?.trim() || "-"

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.headingWrap}>
            <Text style={styles.title}>Invoice</Text>
            {data.projectName ? <Text style={styles.subtitle}>{data.projectName}</Text> : null}
          </View>
          <View style={styles.logoWrap}>
            {data.logoUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={data.logoUrl} style={styles.logo} />
            ) : null}
          </View>
        </View>

        <View style={styles.sectionLg}>
          <View style={styles.twoCol}>
            <View style={styles.col}>
              <Text style={styles.label}>From</Text>
              {fromLines.map((line, idx) => (
                <Text key={`from-${idx}`} style={styles.value}>
                  {line}
                </Text>
              ))}
            </View>
            <View style={styles.colRight}>
              <Text style={styles.label}>To</Text>
              {billToLines.map((line, idx) => (
                <Text key={`to-${idx}`} style={styles.value}>
                  {line}
                </Text>
              ))}
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.metaRow}>
            <View style={styles.metaCell}>
              <Text style={styles.label}>Invoice #</Text>
              <Text style={styles.metaValue}>{data.invoiceNumber || "-"}</Text>
            </View>
            <View style={styles.metaCell}>
              <Text style={styles.label}>Issue date</Text>
              <Text style={styles.metaValue}>{formatDate(data.issueDate)}</Text>
            </View>
            <View style={styles.metaCellRight}>
              <Text style={styles.label}>Due date</Text>
              <Text style={styles.metaValue}>{formatDate(data.dueDate)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.sectionLg}>
          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, { flex: 2.25 }]}>Description</Text>
              <Text style={[styles.th, { flex: 0.55, textAlign: "right" }]}>Qty</Text>
              <Text style={[styles.th, { flex: 0.85, textAlign: "right" }]}>Rate</Text>
              <Text style={[styles.th, { flex: 0.9, textAlign: "right" }]}>Amount</Text>
            </View>

            {data.lines.map((line, idx) => (
              <View key={`line-${idx}`} style={styles.row}>
                <Text style={[styles.td, { flex: 2.25 }]}>{line.description || "-"}</Text>
                <Text style={[styles.td, { flex: 0.55, textAlign: "right" }]}>{line.quantity}</Text>
                <Text style={[styles.td, { flex: 0.85, textAlign: "right" }]}>{money(line.unitCostCents)}</Text>
                <Text style={[styles.td, { flex: 0.9, textAlign: "right" }]}>{money(line.lineTotalCents)}</Text>
              </View>
            ))}
          </View>

          <View style={styles.totalsWrap}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{money(data.subtotalCents)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tax{typeof data.taxRate === "number" ? ` (${data.taxRate}%)` : ""}</Text>
              <Text style={styles.totalValue}>{money(data.taxCents)}</Text>
            </View>
            <View style={styles.grandTotal}>
              <Text style={styles.grandTotalLabel}>Total</Text>
              <Text style={styles.grandTotalValue}>{money(data.totalCents)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.footerDividerTop} />
          <View style={styles.paymentRow}>
            <View style={styles.paymentDetailsWrap}>
              <Text style={styles.label}>Payment details</Text>
              <Text style={styles.notesText}>{notesText}</Text>
            </View>
            {data.payUrl ? (
              <Link src={data.payUrl} style={styles.payButton}>
                Pay online
              </Link>
            ) : null}
          </View>
          <View style={styles.footerDividerBottom} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<InvoicePdfDocument data={data} />)
  return Buffer.from(pdf)
}
