import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

import type { ProfitabilitySection, ProjectProfitabilityReport } from "@/lib/services/reports/project-profitability"

function formatCurrency(cents: number) {
  const dollars = cents / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
}

function formatRange(report: ProjectProfitabilityReport) {
  if (!report.from && !report.to) return "All dates"
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  if (report.from && report.to) return `${fmt(report.from)} – ${fmt(report.to)}`
  if (report.from) return `From ${fmt(report.from)}`
  return `Through ${fmt(report.to as string)}`
}

const ink = "#0f172a"
const muted = "#64748b"
const line = "#e2e8f0"
const positive = "#047857"
const negative = "#b91c1c"

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 48, paddingHorizontal: 44, fontSize: 10, fontFamily: "Helvetica", color: ink },
  brandRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  org: { fontSize: 11, fontWeight: 700, color: ink },
  title: { fontSize: 20, fontWeight: 700, marginTop: 18 },
  subtitle: { marginTop: 3, color: muted, fontSize: 10 },
  meta: { color: muted, fontSize: 9, textAlign: "right" },
  kpis: { flexDirection: "row", gap: 10, marginTop: 22 },
  kpi: { flex: 1, borderWidth: 1, borderColor: line, borderRadius: 6, padding: 10 },
  kpiLabel: { fontSize: 8, color: muted, textTransform: "uppercase", letterSpacing: 0.4 },
  kpiValue: { fontSize: 15, fontWeight: 700, marginTop: 4 },
  kpiSub: { fontSize: 8, color: muted, marginTop: 2 },
  table: { marginTop: 24 },
  sectionHeader: { flexDirection: "row", backgroundColor: "#f1f5f9", paddingVertical: 5, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: line, marginTop: 14 },
  sectionTitle: { flex: 1, fontWeight: 700, fontSize: 10 },
  row: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: line },
  cellLabel: { flex: 1, color: ink },
  cellNum: { width: 90, textAlign: "right" },
  cellNumSmall: { width: 70, textAlign: "right", color: muted, fontSize: 9 },
  totalRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 1.5, borderBottomColor: ink },
  totalLabel: { flex: 1, fontWeight: 700 },
  totalNum: { width: 90, textAlign: "right", fontWeight: 700 },
  totalNumSmall: { width: 70, textAlign: "right", fontWeight: 700, fontSize: 9 },
  resultRow: { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, backgroundColor: "#f8fafc", marginTop: 2 },
  resultLabel: { flex: 1, fontWeight: 700, fontSize: 11 },
  resultNum: { width: 90, textAlign: "right", fontWeight: 700, fontSize: 11 },
  colHead: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: line },
  colHeadLabel: { flex: 1, fontSize: 8, color: muted, textTransform: "uppercase", letterSpacing: 0.4 },
  colHeadNum: { width: 90, textAlign: "right", fontSize: 8, color: muted, textTransform: "uppercase", letterSpacing: 0.4 },
  colHeadNumSmall: { width: 70, textAlign: "right", fontSize: 8, color: muted, textTransform: "uppercase", letterSpacing: 0.4 },
  footer: { position: "absolute", bottom: 24, left: 44, right: 44, flexDirection: "row", justifyContent: "space-between", color: muted, fontSize: 8 },
})

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  )
}

function CostSection({ section }: { section: ProfitabilitySection }) {
  const hasBudget = section.budget_total_cents != null
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{section.label}</Text>
      </View>
      {hasBudget ? (
        <View style={styles.colHead}>
          <Text style={styles.colHeadLabel}>Category</Text>
          <Text style={styles.colHeadNumSmall}>Budget</Text>
          <Text style={styles.colHeadNumSmall}>Variance</Text>
          <Text style={styles.colHeadNum}>Actual</Text>
        </View>
      ) : null}
      {section.lines.map((l) => (
        <View key={l.key} style={styles.row}>
          <Text style={styles.cellLabel}>{l.label}</Text>
          {hasBudget ? (
            <>
              <Text style={styles.cellNumSmall}>{l.budget_cents != null ? formatCurrency(l.budget_cents) : "—"}</Text>
              <Text style={[styles.cellNumSmall, { color: (l.variance_cents ?? 0) >= 0 ? positive : negative }]}>
                {l.variance_cents != null ? formatCurrency(l.variance_cents) : "—"}
              </Text>
            </>
          ) : null}
          <Text style={styles.cellNum}>{formatCurrency(l.amount_cents)}</Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total {section.label.toLowerCase()}</Text>
        {hasBudget ? (
          <>
            <Text style={styles.totalNumSmall}>{formatCurrency(section.budget_total_cents ?? 0)}</Text>
            <Text style={[styles.totalNumSmall, { color: (section.variance_total_cents ?? 0) >= 0 ? positive : negative }]}>
              {formatCurrency(section.variance_total_cents ?? 0)}
            </Text>
          </>
        ) : null}
        <Text style={styles.totalNum}>{formatCurrency(section.total_cents)}</Text>
      </View>
    </View>
  )
}

function IncomeSection({ section }: { section: ProfitabilitySection }) {
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{section.label}</Text>
      </View>
      {section.lines.length === 0 ? (
        <View style={styles.row}>
          <Text style={[styles.cellLabel, { color: muted }]}>No billings in this period</Text>
          <Text style={styles.cellNum}>{formatCurrency(0)}</Text>
        </View>
      ) : (
        section.lines.map((l) => (
          <View key={l.key} style={styles.row}>
            <Text style={styles.cellLabel}>{l.label}</Text>
            <Text style={styles.cellNum}>{formatCurrency(l.amount_cents)}</Text>
          </View>
        ))
      )}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total {section.label.toLowerCase()}</Text>
        <Text style={styles.totalNum}>{formatCurrency(section.total_cents)}</Text>
      </View>
    </View>
  )
}

function ProfitabilityDocument({ report }: { report: ProjectProfitabilityReport }) {
  const margin = report.net_margin_percent
  const budgetedMargin = report.budgeted_margin_percent
  return (
    <Document title={`Project Profitability — ${report.project_name}`}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.brandRow}>
          <Text style={styles.org}>{report.org_name ?? "Arc"}</Text>
          <Text style={styles.meta}>
            {report.basis === "cash" ? "Cash basis" : "Accrual basis"}
            {"\n"}
            {new Date(report.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          </Text>
        </View>

        <Text style={styles.title}>Project Profitability</Text>
        <Text style={styles.subtitle}>{report.project_name}</Text>
        <Text style={styles.subtitle}>
          {formatRange(report)} · Costs {report.group_by === "account" ? "by QuickBooks account" : "by cost code"}
        </Text>

        <View style={styles.kpis}>
          <Kpi label="Net profit" value={formatCurrency(report.net_profit_cents)} sub={`${margin}% margin`} />
          <Kpi label="Income" value={formatCurrency(report.total_income_cents)} sub={report.percent_billed != null ? `${report.percent_billed}% of contract` : undefined} />
          <Kpi label="Cost of work" value={formatCurrency(report.total_cost_cents)} sub={report.percent_budget_spent != null ? `${report.percent_budget_spent}% of budget` : undefined} />
          <Kpi
            label="Margin vs. plan"
            value={budgetedMargin != null ? `${margin}% / ${budgetedMargin}%` : `${margin}%`}
            sub={budgetedMargin != null ? "actual / budgeted" : "actual"}
          />
        </View>

        <View style={styles.table}>
          <IncomeSection section={report.income} />
          <CostSection section={report.cost_of_work} />

          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Gross profit</Text>
            <Text style={[styles.resultNum, { color: report.gross_profit_cents >= 0 ? positive : negative }]}>
              {formatCurrency(report.gross_profit_cents)}
            </Text>
          </View>
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Net profit ({margin}% margin)</Text>
            <Text style={[styles.resultNum, { color: report.net_profit_cents >= 0 ? positive : negative }]}>
              {formatCurrency(report.net_profit_cents)}
            </Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>Generated by Arc</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderProjectProfitabilityPdf(report: ProjectProfitabilityReport): Promise<Buffer> {
  const pdf = await renderToBuffer(<ProfitabilityDocument report={report} />)
  return Buffer.from(pdf)
}
