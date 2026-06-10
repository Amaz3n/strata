import fs from "node:fs"
import path from "node:path"

import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import sharp from "sharp"

import type { ProfitabilitySection, ProjectProfitabilityReport } from "@/lib/services/reports/project-profitability"

/* Fonts — bundled DM Sans, with a Helvetica fallback. */
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

/* Amounts: line items plain, totals prefixed with $ — matching a QBO P&L. */
function plain(cents: number) {
  const value = cents / 100
  const formatted = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return value < 0 ? `(${formatted})` : formatted
}
function money(cents: number) {
  const value = cents / 100
  const formatted = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return value < 0 ? `$(${formatted})` : `$${formatted}`
}

function periodLabel(report: ProjectProfitabilityReport) {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  if (!report.from && !report.to) return "Project to date"
  if (report.from && report.to) return `${fmt(report.from)} – ${fmt(report.to)}`
  if (report.from) return `Since ${fmt(report.from)}`
  return `Through ${fmt(report.to as string)}`
}

const INK = "#1a1a1a"
const MUTED = "#6b7280"
const RULE = "#1a1a1a"
const HAIRLINE = "#d4d4d4"

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 56, fontSize: 10, color: INK },

  header: { alignItems: "center", marginBottom: 26 },
  logo: { height: 34, maxWidth: 200, objectFit: "contain", marginBottom: 12 },
  orgName: { fontSize: 12, fontWeight: 700, marginBottom: 10 },
  projectName: { fontSize: 17, fontWeight: 700, textAlign: "center" },
  reportType: { fontSize: 11, color: MUTED, marginTop: 4 },
  period: { fontSize: 10, color: MUTED, marginTop: 2 },

  totalHeadRow: { flexDirection: "row", justifyContent: "flex-end", paddingBottom: 5 },
  totalHead: { fontSize: 8.5, fontWeight: 700, color: MUTED, letterSpacing: 0.8 },
  topRule: { borderBottomWidth: 1, borderBottomColor: RULE },

  sectionLabel: { fontSize: 10.5, fontWeight: 500, marginTop: 12, marginBottom: 2 },

  row: { flexDirection: "row", alignItems: "center", paddingVertical: 3 },
  itemLabel: { flex: 1, paddingLeft: 16, color: INK },
  amount: { width: 130, textAlign: "right" },

  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 4,
    paddingBottom: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
  },
  totalLabel: { flex: 1, fontWeight: 700 },
  totalAmount: { width: 130, textAlign: "right", fontWeight: 700 },

  grossRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: RULE,
  },
  netRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: RULE,
  },
  emphLabel: { flex: 1, fontWeight: 700, fontSize: 11 },
  emphAmount: { width: 130, textAlign: "right", fontWeight: 700, fontSize: 11 },
  // Accounting grand-total: tight double underline beneath Net Income.
  doubleUnderline: { borderTopWidth: 1, borderTopColor: RULE },
  doubleUnderlineLower: { borderTopWidth: 1, borderTopColor: RULE, marginTop: 1.5 },

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

function Section({ section }: { section: ProfitabilitySection }) {
  return (
    <View wrap={false}>
      <Text style={styles.sectionLabel}>{section.label}</Text>
      {section.lines.map((line) => (
        <View key={line.key} style={styles.row}>
          <Text style={styles.itemLabel}>{line.label}</Text>
          <Text style={styles.amount}>{plain(line.amount_cents)}</Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total for {section.label}</Text>
        <Text style={styles.totalAmount}>{money(section.total_cents)}</Text>
      </View>
    </View>
  )
}

function ProfitabilityDocument({
  report,
  logo,
  family,
}: {
  report: ProjectProfitabilityReport
  logo: string | null
  family: string
}) {
  const generated = new Date(report.generated_at).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })

  return (
    <Document title={`Project Profitability — ${report.project_name}`}>
      <Page size="LETTER" style={[styles.page, { fontFamily: family }]}>
        <View style={styles.header}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image has no alt prop
            <Image src={logo} style={styles.logo} />
          ) : report.org_name ? (
            <Text style={styles.orgName}>{report.org_name}</Text>
          ) : null}
          <Text style={styles.projectName}>{report.project_name}</Text>
          <Text style={styles.reportType}>Project profitability</Text>
          <Text style={styles.period}>{periodLabel(report)}</Text>
        </View>

        <View style={styles.totalHeadRow}>
          <Text style={styles.totalHead}>TOTAL</Text>
        </View>
        <View style={styles.topRule} />

        <Section section={report.income} />
        <Section section={report.cost_of_work} />

        <View style={styles.grossRow}>
          <Text style={styles.emphLabel}>Gross Profit</Text>
          <Text style={styles.emphAmount}>{money(report.gross_profit_cents)}</Text>
        </View>

        <View style={styles.netRow}>
          <Text style={styles.emphLabel}>Net Income</Text>
          <Text style={styles.emphAmount}>{money(report.net_profit_cents)}</Text>
        </View>
        <View style={styles.doubleUnderline} />
        <View style={styles.doubleUnderlineLower} />

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {report.basis === "cash" ? "Cash" : "Accrual"} basis · {generated}
          </Text>
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

export async function renderProjectProfitabilityPdf(report: ProjectProfitabilityReport): Promise<Buffer> {
  const family = ensureFonts()
  const logo = await flattenLogoForPdf(report.org_logo_url)
  const pdf = await renderToBuffer(<ProfitabilityDocument report={report} logo={logo} family={family} />)
  return Buffer.from(pdf)
}
