import fs from "node:fs"
import path from "node:path"

import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import sharp from "sharp"

import type { AgingBucket } from "@/lib/services/reports/aging"
import type { ARAgingReport, ARAgingRow } from "@/lib/services/reports/ar-aging"

export type ArAgingPdfBranding = {
  org_name: string | null
  org_logo_url: string | null
}

/* Fonts — bundled DM Sans, with a Helvetica fallback. Mirrors project-profitability.tsx. */
let resolvedFamily = "Helvetica"
let fontsInitialized = false
function ensureFonts(): string {
  if (fontsInitialized) return resolvedFamily
  fontsInitialized = true
  try {
    const dir = path.join(process.cwd(), "lib/pdfs/fonts")
    const regular = path.join(dir, "DMSans-Regular.ttf")
    if (fs.existsSync(regular)) {
      Font.register({
        family: "DM Sans",
        fonts: [
          { src: regular, fontWeight: 400 },
          { src: path.join(dir, "DMSans-Medium.ttf"), fontWeight: 500 },
          { src: path.join(dir, "DMSans-Bold.ttf"), fontWeight: 700 },
        ],
      })
      Font.registerHyphenationCallback((word) => [word])
      resolvedFamily = "DM Sans"
    }
  } catch {
    resolvedFamily = "Helvetica"
  }
  return resolvedFamily
}

function money(cents: number) {
  const value = cents / 100
  const formatted = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return value < 0 ? `$(${formatted})` : `$${formatted}`
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

// Display order for AR aging buckets. `paid` is excluded; `no_due_date` only
// surfaces when it carries an open balance.
const AR_AGING_DISPLAY: Array<{ key: Exclude<AgingBucket, "paid">; label: string }> = [
  { key: "current", label: "Current" },
  { key: "1_30", label: "1–30 days" },
  { key: "31_60", label: "31–60 days" },
  { key: "61_90", label: "61–90 days" },
  { key: "90_plus", label: "90+ days" },
  { key: "no_due_date", label: "No due date" },
]

const INK = "#1a1a1a"
const MUTED = "#6b7280"
const RULE = "#1a1a1a"
const HAIRLINE = "#d4d4d4"

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 56, fontSize: 10, color: INK },

  header: { alignItems: "center", marginBottom: 26 },
  logo: { height: 34, maxWidth: 200, objectFit: "contain", marginBottom: 12 },
  orgName: { fontSize: 12, fontWeight: 700, marginBottom: 10 },
  reportName: { fontSize: 17, fontWeight: 700, textAlign: "center" },
  period: { fontSize: 10, color: MUTED, marginTop: 4 },

  totalHeadRow: { flexDirection: "row", justifyContent: "flex-end", paddingBottom: 5 },
  totalHead: { fontSize: 8.5, fontWeight: 700, color: MUTED, letterSpacing: 0.8 },
  topRule: { borderBottomWidth: 1, borderBottomColor: RULE },

  summaryRow: { flexDirection: "row", alignItems: "center", paddingVertical: 3 },
  summaryLabel: { flex: 1, paddingLeft: 16, color: INK },
  summaryAmount: { width: 130, textAlign: "right" },

  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 4,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: RULE,
  },
  totalLabel: { flex: 1, fontWeight: 700, fontSize: 11 },
  totalAmount: { width: 130, textAlign: "right", fontWeight: 700, fontSize: 11 },
  doubleUnderline: { borderTopWidth: 1, borderTopColor: RULE },
  doubleUnderlineLower: { borderTopWidth: 1, borderTopColor: RULE, marginTop: 1.5 },

  sectionLabel: { fontSize: 10.5, fontWeight: 700, marginTop: 16, marginBottom: 4 },

  detailHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
  },
  detailHeadText: { fontSize: 8, fontWeight: 700, color: MUTED, letterSpacing: 0.4 },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: "#eeeeee",
  },
  cInvoice: { width: 80 },
  cCustomer: { flex: 1, paddingRight: 8 },
  cDue: { width: 78, textAlign: "right" },
  cDays: { width: 50, textAlign: "right" },
  cAmount: { width: 78, textAlign: "right" },
  bucketTotalRow: { flexDirection: "row", alignItems: "center", paddingTop: 4 },
  bucketTotalLabel: { flex: 1, fontWeight: 700 },
  bucketTotalAmount: { width: 78, textAlign: "right", fontWeight: 700 },

  empty: { fontSize: 9.5, color: MUTED, marginTop: 12 },

  footer: {
    position: "absolute",
    bottom: 30,
    left: 56,
    right: 56,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 8, color: MUTED },
})

function DetailSection({ label, rows, totalCents }: { label: string; rows: ARAgingRow[]; totalCents: number }) {
  return (
    <View wrap={false}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.detailHead}>
        <Text style={[styles.detailHeadText, styles.cInvoice]}>INVOICE</Text>
        <Text style={[styles.detailHeadText, styles.cCustomer]}>CUSTOMER</Text>
        <Text style={[styles.detailHeadText, styles.cDue]}>DUE</Text>
        <Text style={[styles.detailHeadText, styles.cDays]}>DAYS</Text>
        <Text style={[styles.detailHeadText, styles.cAmount]}>OPEN</Text>
      </View>
      {rows.map((row) => (
        <View key={row.invoice_id} style={styles.detailRow}>
          <Text style={styles.cInvoice}>{row.invoice_number ?? row.title ?? "—"}</Text>
          <Text style={styles.cCustomer}>{row.customer_name ?? row.project_name ?? "—"}</Text>
          <Text style={styles.cDue}>{formatDate(row.due_date)}</Text>
          <Text style={styles.cDays}>{row.days_past_due > 0 ? row.days_past_due : "—"}</Text>
          <Text style={styles.cAmount}>{money(row.open_balance_cents)}</Text>
        </View>
      ))}
      <View style={styles.bucketTotalRow}>
        <Text style={styles.bucketTotalLabel}>Total {label}</Text>
        <Text style={styles.bucketTotalAmount}>{money(totalCents)}</Text>
      </View>
    </View>
  )
}

function ArAgingDocument({
  report,
  branding,
  projectName,
  logo,
  family,
}: {
  report: ARAgingReport
  branding: ArAgingPdfBranding
  projectName: string | null
  logo: string | null
  family: string
}) {
  const generated = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })

  const openRows = report.rows.filter((row) => row.bucket !== "paid" && row.open_balance_cents > 0)
  const visibleBuckets = AR_AGING_DISPLAY.filter(
    (entry) => entry.key !== "no_due_date" || report.totals[entry.key] > 0,
  )

  return (
    <Document title={`Accounts Receivable Aging${projectName ? ` — ${projectName}` : ""}`}>
      <Page size="LETTER" style={[styles.page, { fontFamily: family }]}>
        <View style={styles.header}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image has no alt prop
            <Image src={logo} style={styles.logo} />
          ) : branding.org_name ? (
            <Text style={styles.orgName}>{branding.org_name}</Text>
          ) : null}
          <Text style={styles.reportName}>Accounts Receivable Aging{projectName ? ` — ${projectName}` : ""}</Text>
          <Text style={styles.period}>As of {formatDate(report.as_of)}</Text>
        </View>

        <View style={styles.totalHeadRow}>
          <Text style={styles.totalHead}>OPEN BALANCE</Text>
        </View>
        <View style={styles.topRule} />

        {visibleBuckets.map((entry) => (
          <View key={entry.key} style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{entry.label}</Text>
            <Text style={styles.summaryAmount}>{money(report.totals[entry.key])}</Text>
          </View>
        ))}

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total open</Text>
          <Text style={styles.totalAmount}>{money(report.totals.total_open_cents)}</Text>
        </View>
        <View style={styles.doubleUnderline} />
        <View style={styles.doubleUnderlineLower} />

        {openRows.length === 0 ? (
          <Text style={styles.empty}>No open receivables for this scope.</Text>
        ) : (
          visibleBuckets
            .map((entry) => {
              const rows = openRows.filter((row) => row.bucket === entry.key)
              if (rows.length === 0) return null
              return (
                <DetailSection
                  key={entry.key}
                  label={entry.label}
                  rows={rows.slice().sort((a, b) => b.open_balance_cents - a.open_balance_cents)}
                  totalCents={report.totals[entry.key]}
                />
              )
            })
            .filter(Boolean)
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Accrual basis · {generated}</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

/**
 * @react-pdf mis-renders PNG logos with an alpha channel (ghosting/duplication).
 * Flatten onto white and re-encode to a clean PNG. Returns null on any failure.
 */
async function flattenLogoForPdf(logoUrl?: string | null): Promise<string | null> {
  if (!logoUrl) return null
  try {
    let input: Buffer
    if (logoUrl.startsWith("data:")) {
      input = Buffer.from(logoUrl.split(",")[1] ?? "", "base64")
    } else {
      const res = await fetch(logoUrl)
      if (!res.ok) return null
      if ((res.headers.get("content-type") ?? "").includes("svg")) return null
      input = Buffer.from(await res.arrayBuffer())
    }
    const flattened = await sharp(input).flatten({ background: "#ffffff" }).png().toBuffer()
    return `data:image/png;base64,${flattened.toString("base64")}`
  } catch {
    return null
  }
}

export async function renderArAgingPdf({
  report,
  branding,
  projectName = null,
}: {
  report: ARAgingReport
  branding: ArAgingPdfBranding
  projectName?: string | null
}): Promise<Buffer> {
  const family = ensureFonts()
  const logo = await flattenLogoForPdf(branding.org_logo_url)
  const pdf = await renderToBuffer(
    <ArAgingDocument report={report} branding={branding} projectName={projectName} logo={logo} family={family} />,
  )
  return Buffer.from(pdf)
}
