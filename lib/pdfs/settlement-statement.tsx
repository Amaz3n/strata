import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

export type SettlementStatementLine = { description: string; amountCents: number }

export type SettlementStatementData = {
  builderName: string
  builderAddressLines: string[]
  buyerName: string
  /** Email and phone lines printed under the buyer's name. May be empty. */
  buyerLines: string[]
  /** Street address, "Lot 12 · Willow Creek", plan name. */
  propertyLines: string[]
  agreementNumber?: string | null
  agreementDate?: string | null
  /** Scheduled date while the closing is open, the actual date once it settled. */
  closingDate?: string | null
  status: "preview" | "final"
  purchasePrice: SettlementStatementLine[]
  changeOrders: SettlementStatementLine[]
  adjustments: SettlementStatementLine[]
  finalPriceCents: number
  deposits: Array<{ label: string; amountCents: number; receivedAt?: string | null }>
  depositsAppliedCents: number
  balanceDueCents: number
  payment?: { method: string; reference?: string | null; receivedAt?: string | null; amountCents: number } | null
  generatedAt: string
}

/**
 * The settlement statement a buyer signs at the closing table: how the price
 * was built, what changed after the agreement, what the table adds, what has
 * already been paid, and the one number they have to wire. It is the same
 * composition the closing invoice bills and the closing workbench shows —
 * `buildSettlementStatementLines` is the single source for all three.
 */

const palette = {
  bg: "#FFFFFF",
  text: "#111111",
  muted: "#6B7280",
  line: "#E5E7EB",
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
  previewStamp: {
    borderWidth: 1,
    borderColor: palette.muted,
    color: palette.muted,
    paddingVertical: 4,
    paddingHorizontal: 10,
    fontSize: 9,
    fontWeight: "bold",
    letterSpacing: 1.4,
  },
  metaBlock: {
    marginTop: 22,
  },
  metaRow: {
    flexDirection: "row",
    marginBottom: 5,
  },
  metaLabel: {
    width: 118,
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
  sectionTitle: {
    marginTop: 26,
    fontSize: 11,
    fontWeight: "bold",
  },
  tableHeader: {
    marginTop: 10,
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
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  td: {
    fontSize: 10,
  },
  subtotalRow: {
    flexDirection: "row",
    paddingTop: 7,
  },
  subtotalLabel: {
    flex: 3,
    fontSize: 9.5,
    color: palette.muted,
  },
  subtotalValue: {
    flex: 1,
    fontSize: 10,
    textAlign: "right",
  },
  totalRow: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: palette.text,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  totalLabel: {
    fontSize: 10.5,
    fontWeight: "bold",
  },
  totalValue: {
    fontSize: 10.5,
    fontWeight: "bold",
  },
  balanceBlock: {
    marginTop: 22,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: palette.text,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: "bold",
  },
  balanceValue: {
    fontSize: 18,
    fontWeight: "bold",
    letterSpacing: -0.2,
  },
  paymentBlock: {
    marginTop: 20,
  },
  emptyText: {
    marginTop: 10,
    fontSize: 9.5,
    color: palette.muted,
  },
  signatures: {
    marginTop: 34,
    flexDirection: "row",
    gap: 32,
  },
  signature: {
    flex: 1,
  },
  signatureLine: {
    borderBottomWidth: 1,
    borderBottomColor: palette.text,
    height: 28,
  },
  signatureDateLine: {
    marginTop: 16,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    height: 20,
  },
  signatureLabel: {
    marginTop: 5,
    fontSize: 9,
    color: palette.muted,
  },
  footer: {
    marginTop: "auto",
    paddingTop: 20,
    fontSize: 9,
    color: palette.muted,
  },
})

function money(cents: number) {
  const formatted = (Math.abs(cents) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return cents < 0 ? `(${formatted})` : formatted
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

function cleanLines(lines: string[]) {
  return lines
    .flatMap((line) => String(line ?? "").split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
}

function sumCents(lines: SettlementStatementLine[]) {
  return lines.reduce((total, line) => total + line.amountCents, 0)
}

function LineTable({ lines, subtotalLabel }: { lines: SettlementStatementLine[]; subtotalLabel: string }) {
  return (
    <View>
      <View style={styles.tableHeader}>
        <Text style={[styles.th, { flex: 3 }]}>Description</Text>
        <Text style={[styles.th, { flex: 1, textAlign: "right" }]}>Amount</Text>
      </View>
      {lines.map((line, index) => (
        <View key={`line-${index}`} style={styles.row}>
          <Text style={[styles.td, { flex: 3 }]}>{line.description}</Text>
          <Text style={[styles.td, { flex: 1, textAlign: "right" }]}>{money(line.amountCents)}</Text>
        </View>
      ))}
      <View style={styles.subtotalRow}>
        <Text style={styles.subtotalLabel}>{subtotalLabel}</Text>
        <Text style={styles.subtotalValue}>{money(sumCents(lines))}</Text>
      </View>
    </View>
  )
}

function SettlementStatementDocument({ data }: { data: SettlementStatementData }) {
  const builderLines = cleanLines([data.builderName, ...data.builderAddressLines])
  const buyerLines = cleanLines([data.buyerName, ...data.buyerLines])
  const propertyLines = cleanLines(data.propertyLines)

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Settlement statement</Text>
            <Text style={styles.subtitle}>
              {data.status === "preview"
                ? "Estimated figures. Not a final settlement — amounts may change before closing."
                : "Final settlement as recorded at closing."}
            </Text>
          </View>
          {data.status === "preview" ? <Text style={styles.previewStamp}>PREVIEW</Text> : null}
        </View>

        <View style={styles.metaBlock}>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Purchase agreement</Text>
            <Text style={styles.metaValue}>{data.agreementNumber?.trim() || "-"}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Agreement date</Text>
            <Text style={styles.metaValue}>{formatDate(data.agreementDate)}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Closing date</Text>
            <Text style={styles.metaValue}>{formatDate(data.closingDate)}</Text>
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Seller</Text>
            {builderLines.map((line, index) => (
              <Text key={`builder-${index}`} style={styles.partyLine}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Buyer</Text>
            {buyerLines.length > 0 ? (
              buyerLines.map((line, index) => (
                <Text key={`buyer-${index}`} style={styles.partyLine}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={styles.partyLine}>-</Text>
            )}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Property</Text>
            {propertyLines.length > 0 ? (
              propertyLines.map((line, index) => (
                <Text key={`property-${index}`} style={styles.partyLine}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={styles.partyLine}>-</Text>
            )}
          </View>
        </View>

        <Text style={styles.sectionTitle}>Purchase price</Text>
        <LineTable lines={data.purchasePrice} subtotalLabel="Agreement subtotal" />

        {data.changeOrders.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Change orders</Text>
            <LineTable lines={data.changeOrders} subtotalLabel="Approved change orders" />
          </>
        ) : null}

        {data.adjustments.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Settlement adjustments</Text>
            <LineTable lines={data.adjustments} subtotalLabel="Adjustments" />
          </>
        ) : null}

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Final price</Text>
          <Text style={styles.totalValue}>{money(data.finalPriceCents)}</Text>
        </View>

        <Text style={styles.sectionTitle}>Deposits credited</Text>
        {data.deposits.length > 0 ? (
          <View>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, { flex: 2.2 }]}>Deposit</Text>
              <Text style={[styles.th, { flex: 1 }]}>Received</Text>
              <Text style={[styles.th, { flex: 1, textAlign: "right" }]}>Amount</Text>
            </View>
            {data.deposits.map((deposit, index) => (
              <View key={`deposit-${index}`} style={styles.row}>
                <Text style={[styles.td, { flex: 2.2 }]}>{deposit.label}</Text>
                <Text style={[styles.td, { flex: 1 }]}>{formatDate(deposit.receivedAt)}</Text>
                <Text style={[styles.td, { flex: 1, textAlign: "right" }]}>{money(deposit.amountCents)}</Text>
              </View>
            ))}
            <View style={styles.subtotalRow}>
              <Text style={styles.subtotalLabel}>Total deposits credited</Text>
              <Text style={styles.subtotalValue}>{money(data.depositsAppliedCents)}</Text>
            </View>
          </View>
        ) : (
          <Text style={styles.emptyText}>No deposits have been receipted against this home.</Text>
        )}

        <View style={styles.balanceBlock}>
          <Text style={styles.balanceLabel}>Balance due at closing</Text>
          <Text style={styles.balanceValue}>{money(data.balanceDueCents)}</Text>
        </View>

        {data.payment ? (
          <View style={styles.paymentBlock}>
            <Text style={styles.sectionTitle}>Payment received</Text>
            <View style={{ marginTop: 8 }}>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Method</Text>
                <Text style={styles.metaValue}>{data.payment.method || "-"}</Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Reference</Text>
                <Text style={styles.metaValue}>{data.payment.reference?.trim() || "-"}</Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Received</Text>
                <Text style={styles.metaValue}>{formatDate(data.payment.receivedAt)}</Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Amount</Text>
                <Text style={styles.metaValue}>{money(data.payment.amountCents)}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <View style={styles.signatures}>
          <View style={styles.signature}>
            <View style={styles.signatureLine} />
            <Text style={styles.signatureLabel}>Buyer — {data.buyerName || "signature"}</Text>
            <View style={styles.signatureDateLine} />
            <Text style={styles.signatureLabel}>Date</Text>
          </View>
          <View style={styles.signature}>
            <View style={styles.signatureLine} />
            <Text style={styles.signatureLabel}>Builder — {data.builderName || "signature"}</Text>
            <View style={styles.signatureDateLine} />
            <Text style={styles.signatureLabel}>Date</Text>
          </View>
        </View>

        <Text style={styles.footer}>Generated by Arc · {formatDate(data.generatedAt)}</Text>
      </Page>
    </Document>
  )
}

export async function renderSettlementStatementPdf(data: SettlementStatementData): Promise<Buffer> {
  const pdf = await renderToBuffer(<SettlementStatementDocument data={data} />)
  return Buffer.from(pdf)
}
