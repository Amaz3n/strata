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
  /** Ways the customer can pay online, as printed labels. Empty hides the line. */
  paymentMethods?: string[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  /** What is still owed. Defaults to the total. */
  amountDueCents?: number
  taxRate?: number
  discountCents?: number
  discountPercent?: number
  lines: InvoicePdfLine[]
}

/**
 * The Arc invoice. One page, quiet, read top to bottom the way a bookkeeper
 * reads one: who, what, how much, how to pay. `components/invoices/
 * arc-invoice-document.tsx` is the same layout in HTML for the portal and the
 * composer's live preview; the two move together.
 */

const palette = {
  bg: "#FFFFFF",
  text: "#111111",
  muted: "#6B7280",
  line: "#E5E7EB",
  soft: "#F3F4F6",
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 40,
    paddingHorizontal: 48,
    backgroundColor: palette.bg,
    color: palette.text,
    fontFamily: "Helvetica",
    fontSize: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    letterSpacing: -0.2,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 10.5,
    color: palette.muted,
    lineHeight: 1.4,
  },
  logo: {
    maxWidth: 160,
    maxHeight: 56,
    objectFit: "contain",
  },
  metaBlock: {
    marginTop: 22,
  },
  metaRow: {
    flexDirection: "row",
    marginBottom: 5,
  },
  metaLabel: {
    width: 96,
    fontSize: 9.5,
    color: palette.muted,
  },
  metaValue: {
    fontSize: 10,
  },
  parties: {
    marginTop: 26,
    flexDirection: "row",
    gap: 32,
  },
  party: {
    flex: 1,
  },
  partyLabel: {
    fontSize: 9.5,
    color: palette.muted,
    marginBottom: 5,
  },
  partyLine: {
    fontSize: 10,
    lineHeight: 1.4,
    marginBottom: 1,
  },
  headline: {
    marginTop: 34,
    fontSize: 16,
    fontWeight: "bold",
    letterSpacing: -0.1,
  },
  table: {
    marginTop: 14,
  },
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 7,
    borderBottomWidth: 1,
    borderBottomColor: palette.text,
  },
  th: {
    fontSize: 9,
    color: palette.muted,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  td: {
    fontSize: 10,
  },
  totalsWrap: {
    width: 240,
    marginLeft: "auto",
    marginTop: 16,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  totalLabel: {
    fontSize: 9.5,
    color: palette.muted,
  },
  totalValue: {
    fontSize: 10,
  },
  amountDue: {
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: palette.text,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  amountDueLabel: {
    fontSize: 10,
    fontWeight: "bold",
  },
  amountDueValue: {
    fontSize: 11,
    fontWeight: "bold",
  },
  footer: {
    marginTop: "auto",
    paddingTop: 20,
  },
  footerBlock: {
    marginBottom: 14,
  },
  footerLabel: {
    fontSize: 9.5,
    fontWeight: "bold",
    marginBottom: 5,
  },
  footerText: {
    fontSize: 9.5,
    lineHeight: 1.5,
    color: palette.text,
  },
  payRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  payButton: {
    borderWidth: 1,
    borderColor: palette.text,
    paddingVertical: 6,
    paddingHorizontal: 14,
    fontSize: 9.5,
    fontWeight: "bold",
    color: palette.text,
    textDecoration: "none",
  },
  payMethods: {
    fontSize: 9,
    color: palette.muted,
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
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

function InvoicePdfDocument({ data }: { data: InvoicePdfData }) {
  const fromLines = cleanLines(data.fromLines)
  const billToLines = cleanLines(data.billToLines)
  const amountDue = data.amountDueCents ?? data.totalCents
  const subtitle = data.projectName?.trim() || ""
  const notes = data.notes?.trim() ?? ""
  const methods = (data.paymentMethods ?? []).filter(Boolean)

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Invoice</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {data.logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.logoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.metaBlock}>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Invoice number</Text>
            <Text style={styles.metaValue}>{data.invoiceNumber || "-"}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Date of issue</Text>
            <Text style={styles.metaValue}>{formatDate(data.issueDate)}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Date due</Text>
            <Text style={styles.metaValue}>{formatDate(data.dueDate)}</Text>
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>From</Text>
            {fromLines.map((line, idx) => (
              <Text key={`from-${idx}`} style={styles.partyLine}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Bill to</Text>
            {billToLines.map((line, idx) => (
              <Text key={`to-${idx}`} style={styles.partyLine}>
                {line}
              </Text>
            ))}
          </View>
        </View>

        <Text style={styles.headline}>
          {money(amountDue)} due {data.dueDate ? formatDate(data.dueDate) : "on receipt"}
        </Text>

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, { flex: 2.4 }]}>Description</Text>
            <Text style={[styles.th, { flex: 0.5, textAlign: "right" }]}>Qty</Text>
            <Text style={[styles.th, { flex: 0.9, textAlign: "right" }]}>Unit price</Text>
            <Text style={[styles.th, { flex: 0.9, textAlign: "right" }]}>Amount</Text>
          </View>
          {data.lines.map((line, idx) => (
            <View key={`line-${idx}`} style={styles.row}>
              <Text style={[styles.td, { flex: 2.4 }]}>{line.description || "-"}</Text>
              <Text style={[styles.td, { flex: 0.5, textAlign: "right" }]}>{line.quantity}</Text>
              <Text style={[styles.td, { flex: 0.9, textAlign: "right" }]}>{money(line.unitCostCents)}</Text>
              <Text style={[styles.td, { flex: 0.9, textAlign: "right" }]}>{money(line.lineTotalCents)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsWrap}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>{money(data.subtotalCents)}</Text>
          </View>
          {data.discountCents && data.discountCents > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                Discount{typeof data.discountPercent === "number" ? ` (${data.discountPercent}%)` : ""}
              </Text>
              <Text style={styles.totalValue}>-{money(data.discountCents)}</Text>
            </View>
          ) : null}
          {data.taxCents > 0 || (typeof data.taxRate === "number" && data.taxRate > 0) ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tax{typeof data.taxRate === "number" ? ` (${data.taxRate}%)` : ""}</Text>
              <Text style={styles.totalValue}>{money(data.taxCents)}</Text>
            </View>
          ) : null}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{money(data.totalCents)}</Text>
          </View>
          <View style={styles.amountDue}>
            <Text style={styles.amountDueLabel}>Amount due</Text>
            <Text style={styles.amountDueValue}>{money(amountDue)} USD</Text>
          </View>
        </View>

        <View style={styles.footer}>
          {notes ? (
            <View style={styles.footerBlock}>
              <Text style={styles.footerLabel}>Payment details</Text>
              <Text style={styles.footerText}>{notes}</Text>
            </View>
          ) : null}
          {data.payUrl ? (
            <View style={styles.payRow}>
              <Link src={data.payUrl} style={styles.payButton}>
                Pay online
              </Link>
              {methods.length > 0 ? <Text style={styles.payMethods}>{methods.join(" · ")}</Text> : null}
            </View>
          ) : null}
        </View>
      </Page>
    </Document>
  )
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<InvoicePdfDocument data={data} />)
  return Buffer.from(pdf)
}
