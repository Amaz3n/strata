import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

/**
 * AIA-style payment application for SOV progress billing: page 1 is the
 * Application for Payment (G702-equivalent) with the 9-line computation,
 * retainage breakdown, CO summary, and signature blocks (including the
 * Architect's Certificate section); following pages are the Continuation
 * Sheet (G703-equivalent) with stored materials and per-line retainage.
 * Same data as the AIA forms, own layout — not a licensed AIA form.
 */

export type SovPayAppPdfLine = {
  itemNo: string
  description: string
  scheduledValueCents: number
  previousCents: number
  thisPeriodCents: number
  storedMaterialsCents: number
  retainageCents: number
}

export type SovPayAppPdfData = {
  applicationNumber: number
  applicationDateIso: string
  periodStartIso?: string | null
  periodToIso: string
  projectName: string
  propertyDescription?: string | null
  ownerName: string
  contractorName: string
  contractDateIso?: string | null
  invoiceNumber?: string | null
  isRetainageRelease: boolean
  /** How many times the owner returned it; 0 for the first submission. */
  revision: number
  /** Who submitted it and when, printed on the contractor's signature line. */
  submittedBy?: { name: string; at: string } | null
  /** The owner's or architect's certificate, once given. */
  certification?: {
    signerName: string
    certifiedAt: string
    certifiedAmountCents: number
    requestedAmountCents?: number
    deferredAmountCents?: number
    note?: string | null
  } | null
  // Frozen G702 summary (from the posted application):
  originalContractSumCents: number
  changeOrderSumCents: number
  contractSumToDateCents: number
  totalCompletedStoredCents: number
  retainageCents: number
  retainageOnCompletedWorkCents: number
  retainageOnStoredMaterialsCents: number
  totalEarnedLessRetainageCents: number
  previousCertificatesCents: number
  currentPaymentDueCents: number
  balanceToFinishCents: number
  changeOrders: Array<{ title: string; amountCents: number }>
  lines: SovPayAppPdfLine[]
}

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })
}

function fdate(value?: string | null) {
  if (!value) return "—"
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) })
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: "Helvetica" },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  subtitle: { fontSize: 9, color: "#555", marginTop: 2 },
  headerGrid: { flexDirection: "row", marginTop: 14, gap: 24 },
  headerCol: { flex: 1 },
  headerLabel: { color: "#555", marginTop: 6 },
  headerValue: { fontFamily: "Helvetica-Bold", marginTop: 1 },
  section: { marginTop: 16 },
  sectionTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 8 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3.5, borderBottomWidth: 0.5, borderBottomColor: "#ddd" },
  sumIndentRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, paddingLeft: 14 },
  sumLabel: { color: "#333" },
  sumIndentLabel: { color: "#666" },
  sumValue: { fontFamily: "Helvetica-Bold" },
  sumTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderBottomWidth: 1.5, borderBottomColor: "#111", marginTop: 2 },
  cert: { marginTop: 14, fontSize: 8.5, color: "#333", lineHeight: 1.5 },
  signatureRow: { flexDirection: "row", gap: 32, marginTop: 20 },
  signatureLine: { flex: 1, borderTopWidth: 1, borderTopColor: "#111", paddingTop: 4 },
  small: { fontSize: 7.5, color: "#777", marginTop: 16 },
  // tables
  table: { marginTop: 10 },
  th: { flexDirection: "row", borderBottomWidth: 1.5, borderBottomColor: "#111", paddingBottom: 4, fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ddd", paddingVertical: 4 },
  trTotal: { flexDirection: "row", borderTopWidth: 1.5, borderTopColor: "#111", paddingVertical: 5, fontFamily: "Helvetica-Bold" },
  cItem: { width: "4%" },
  cDesc: { width: "20%", paddingRight: 4 },
  cNum: { width: "9.5%", textAlign: "right" },
  signed: { fontFamily: "Helvetica-Oblique", fontSize: 10 },
  signedMeta: { color: "#555", fontSize: 7.5, marginTop: 1 },
  coTitle: { width: "70%", paddingRight: 6 },
  coAmount: { width: "30%", textAlign: "right" },
})

function ApplicationPage({ data }: { data: SovPayAppPdfData }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.title}>Application for Payment</Text>
      <Text style={styles.subtitle}>
        {data.isRetainageRelease ? "Retainage release" : "Progress billing"} application and certificate summary
        {data.revision > 0 ? ` • Revision ${data.revision}` : ""} • Generated by Arc
      </Text>

      <View style={styles.headerGrid}>
        <View style={styles.headerCol}>
          <Text style={styles.headerLabel}>To (Owner)</Text>
          <Text style={styles.headerValue}>{data.ownerName}</Text>
          <Text style={styles.headerLabel}>From (Contractor)</Text>
          <Text style={styles.headerValue}>{data.contractorName}</Text>
          <Text style={styles.headerLabel}>Project</Text>
          <Text style={styles.headerValue}>{data.projectName}</Text>
          {data.propertyDescription ? <Text style={{ color: "#555" }}>{data.propertyDescription}</Text> : null}
        </View>
        <View style={styles.headerCol}>
          <Text style={styles.headerLabel}>Application No.</Text>
          <Text style={styles.headerValue}>{data.applicationNumber}</Text>
          <Text style={styles.headerLabel}>Application date</Text>
          <Text style={styles.headerValue}>{fdate(data.applicationDateIso)}</Text>
          <Text style={styles.headerLabel}>Period</Text>
          <Text style={styles.headerValue}>
            {data.periodStartIso ? `${fdate(data.periodStartIso)} — ` : "To "}
            {fdate(data.periodToIso)}
          </Text>
          {data.invoiceNumber ? (
            <>
              <Text style={styles.headerLabel}>Invoice</Text>
              <Text style={styles.headerValue}>{data.invoiceNumber}</Text>
            </>
          ) : null}
          {data.contractDateIso ? (
            <>
              <Text style={styles.headerLabel}>Contract date</Text>
              <Text style={styles.headerValue}>{fdate(data.contractDateIso)}</Text>
            </>
          ) : null}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Contractor&apos;s Application for Payment</Text>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>1. Original contract sum</Text>
          <Text style={styles.sumValue}>{money(data.originalContractSumCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>2. Net change by change orders</Text>
          <Text style={styles.sumValue}>{money(data.changeOrderSumCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>3. Contract sum to date (1 + 2)</Text>
          <Text style={styles.sumValue}>{money(data.contractSumToDateCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>4. Total completed and stored to date</Text>
          <Text style={styles.sumValue}>{money(data.totalCompletedStoredCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>5. Retainage</Text>
          <Text style={styles.sumValue}>{money(data.retainageCents)}</Text>
        </View>
        <View style={styles.sumIndentRow}>
          <Text style={styles.sumIndentLabel}>a. On completed work</Text>
          <Text>{money(data.retainageOnCompletedWorkCents)}</Text>
        </View>
        <View style={styles.sumIndentRow}>
          <Text style={styles.sumIndentLabel}>b. On stored materials</Text>
          <Text>{money(data.retainageOnStoredMaterialsCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>6. Total earned less retainage (4 − 5)</Text>
          <Text style={styles.sumValue}>{money(data.totalEarnedLessRetainageCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>7. Less previous certificates for payment</Text>
          <Text style={styles.sumValue}>{money(data.previousCertificatesCents)}</Text>
        </View>
        <View style={styles.sumTotalRow}>
          <Text>8. Current payment due</Text>
          <Text>{money(data.currentPaymentDueCents)}</Text>
        </View>
        <View style={styles.sumRow}>
          <Text style={styles.sumLabel}>9. Balance to finish, including retainage (3 − 6)</Text>
          <Text style={styles.sumValue}>{money(data.balanceToFinishCents)}</Text>
        </View>
      </View>

      {data.changeOrders.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Change Order Summary</Text>
          <View style={styles.th}>
            <Text style={styles.coTitle}>Approved change orders</Text>
            <Text style={styles.coAmount}>Amount</Text>
          </View>
          {data.changeOrders.map((co, index) => (
            <View key={index} style={styles.tr}>
              <Text style={styles.coTitle}>{co.title}</Text>
              <Text style={styles.coAmount}>{money(co.amountCents)}</Text>
            </View>
          ))}
          <View style={styles.trTotal}>
            <Text style={styles.coTitle}>Net change by change orders</Text>
            <Text style={styles.coAmount}>{money(data.changeOrderSumCents)}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.cert}>
        The undersigned Contractor certifies that to the best of the Contractor&apos;s knowledge, information and belief the
        Work covered by this Application for Payment has been completed in accordance with the Contract Documents, that all
        amounts have been paid by the Contractor for Work for which previous Certificates for Payment were issued and
        payments received from the Owner, and that current payment shown herein is now due.
      </Text>
      <View style={styles.signatureRow}>
        <View style={styles.signatureLine}>
          {data.submittedBy ? (
            <>
              <Text style={styles.signed}>{data.submittedBy.name}</Text>
              <Text style={styles.signedMeta}>
                Signed electronically for {data.contractorName} on {fdate(data.submittedBy.at)}
              </Text>
            </>
          ) : (
            <Text>{data.contractorName}</Text>
          )}
          <Text style={{ color: "#555" }}>Contractor — authorized signature / date</Text>
        </View>
      </View>

      <Text style={[styles.cert, { marginTop: 18, fontFamily: "Helvetica-Bold", fontSize: 9.5, color: "#111" }]}>
        Owner&apos;s / Architect&apos;s Certificate for Payment
      </Text>
      <Text style={styles.cert}>
        In accordance with the Contract Documents, based on on-site observations and the data comprising this application,
        the undersigned certifies to the Owner that to the best of their knowledge, information and belief the Work has
        progressed as indicated, the quality of the Work is in accordance with the Contract Documents, and the Contractor
        is entitled to payment of the AMOUNT CERTIFIED.
      </Text>
      <View style={styles.signatureRow}>
        <View style={styles.signatureLine}>
          {data.certification ? (
            <>
              <Text>Amount certified: {money(data.certification.certifiedAmountCents)}</Text>
              {data.certification.deferredAmountCents ? (
                <Text style={{ color: "#555" }}>
                  Applied for {money(data.certification.requestedAmountCents ?? data.currentPaymentDueCents)}; deferred {money(data.certification.deferredAmountCents)}
                </Text>
              ) : null}
              {data.certification.note ? <Text style={{ color: "#555" }}>{data.certification.note}</Text> : null}
            </>
          ) : (
            <>
              <Text>Amount certified: $______________________</Text>
              <Text style={{ color: "#555" }}>
                (Attach explanation if amount certified differs from the amount applied for.)
              </Text>
            </>
          )}
        </View>
        <View style={styles.signatureLine}>
          {data.certification ? (
            <>
              <Text style={styles.signed}>{data.certification.signerName}</Text>
              <Text style={styles.signedMeta}>Certified electronically on {fdate(data.certification.certifiedAt)}</Text>
            </>
          ) : (
            <Text> </Text>
          )}
          <Text style={{ color: "#555" }}>Owner / Architect — signature / date</Text>
        </View>
      </View>

      <Text style={styles.small}>
        Continuation sheet attached. This document presents the same data as AIA G702/G703 in Arc&apos;s own layout; it is
        not a licensed AIA form.
      </Text>
    </Page>
  )
}

function ContinuationPage({ data }: { data: SovPayAppPdfData }) {
  const totals = data.lines.reduce(
    (acc, line) => {
      acc.scheduled += line.scheduledValueCents
      acc.previous += line.previousCents
      acc.thisPeriod += line.thisPeriodCents
      acc.stored += line.storedMaterialsCents
      acc.retainage += line.retainageCents
      return acc
    },
    { scheduled: 0, previous: 0, thisPeriod: 0, stored: 0, retainage: 0 },
  )
  const totalCompleted = totals.previous + totals.thisPeriod + totals.stored

  return (
    <Page size="LETTER" orientation="landscape" style={styles.page} wrap>
      <Text style={styles.title}>Continuation Sheet</Text>
      <Text style={styles.subtitle}>
        Schedule of values detail • Application {data.applicationNumber} • {fdate(data.applicationDateIso)} • {data.projectName}
      </Text>

      <View style={styles.table}>
        <View style={styles.th} fixed>
          <Text style={styles.cItem}>No.</Text>
          <Text style={styles.cDesc}>Description of work</Text>
          <Text style={styles.cNum}>Scheduled value</Text>
          <Text style={styles.cNum}>From previous application</Text>
          <Text style={styles.cNum}>This period</Text>
          <Text style={styles.cNum}>Materials presently stored</Text>
          <Text style={styles.cNum}>Total completed &amp; stored</Text>
          <Text style={styles.cNum}>%</Text>
          <Text style={styles.cNum}>Balance to finish</Text>
          <Text style={styles.cNum}>Retainage</Text>
        </View>
        {data.lines.map((line) => {
          const completed = line.previousCents + line.thisPeriodCents + line.storedMaterialsCents
          const pct = line.scheduledValueCents > 0 ? (completed / line.scheduledValueCents) * 100 : 0
          return (
            <View key={line.itemNo} style={styles.tr} wrap={false}>
              <Text style={styles.cItem}>{line.itemNo}</Text>
              <Text style={styles.cDesc}>{line.description}</Text>
              <Text style={styles.cNum}>{money(line.scheduledValueCents)}</Text>
              <Text style={styles.cNum}>{money(line.previousCents)}</Text>
              <Text style={styles.cNum}>{money(line.thisPeriodCents)}</Text>
              <Text style={styles.cNum}>{money(line.storedMaterialsCents)}</Text>
              <Text style={styles.cNum}>{money(completed)}</Text>
              <Text style={styles.cNum}>{pct.toFixed(0)}%</Text>
              <Text style={styles.cNum}>{money(line.scheduledValueCents - completed)}</Text>
              <Text style={styles.cNum}>{money(line.retainageCents)}</Text>
            </View>
          )
        })}
        <View style={styles.trTotal}>
          <Text style={styles.cItem}> </Text>
          <Text style={styles.cDesc}>Grand total</Text>
          <Text style={styles.cNum}>{money(totals.scheduled)}</Text>
          <Text style={styles.cNum}>{money(totals.previous)}</Text>
          <Text style={styles.cNum}>{money(totals.thisPeriod)}</Text>
          <Text style={styles.cNum}>{money(totals.stored)}</Text>
          <Text style={styles.cNum}>{money(totalCompleted)}</Text>
          <Text style={styles.cNum}>
            {totals.scheduled > 0 ? ((totalCompleted / totals.scheduled) * 100).toFixed(0) : "0"}%
          </Text>
          <Text style={styles.cNum}>{money(totals.scheduled - totalCompleted)}</Text>
          <Text style={styles.cNum}>{money(totals.retainage)}</Text>
        </View>
      </View>

      <Text style={styles.small}>
        Retainage is the amount withheld by this application on each line. Rates follow the contract&apos;s retainage
        schedule and per-line overrides; retainage held to date is on the application summary page.
      </Text>
    </Page>
  )
}

export async function renderSovPayApplicationPdf(data: SovPayAppPdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(
    <Document>
      <ApplicationPage data={data} />
      {data.lines.length > 0 ? <ContinuationPage data={data} /> : null}
    </Document>,
  )
  return Buffer.from(pdf)
}
