import fs from "node:fs"
import path from "node:path"

import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import sharp from "sharp"

import { formatCell, isNumericColumn, visibleColumns } from "@/lib/reports/format"
import type { ReportColumn, ReportResult, ReportRow, ReportTable } from "@/lib/reports/types"

/**
 * One PDF renderer for the whole catalog. It reads the same `ReportResult` the
 * screen and the CSV read, so adding a report to the registry gives it a PDF for
 * free — and the PDF can never show a different number than the page did.
 */

export interface ReportPdfBranding {
  org_name: string | null
  org_logo_url: string | null
}

/* Fonts — bundled DM Sans, with a Helvetica fallback. Mirrors lib/pdfs/invoice.tsx. */
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

const INK = "#1a1a1a"
const MUTED = "#6b7280"
const RULE = "#1a1a1a"
const HAIRLINE = "#e5e5e5"

const styles = StyleSheet.create({
  page: { paddingTop: 42, paddingBottom: 48, paddingHorizontal: 34, fontSize: 8, color: INK },

  header: { marginBottom: 18 },
  logo: { height: 28, maxWidth: 170, objectFit: "contain", marginBottom: 8 },
  orgName: { fontSize: 10, fontWeight: 700, marginBottom: 6 },
  reportName: { fontSize: 15, fontWeight: 700 },
  provenance: { fontSize: 8.5, color: MUTED, marginTop: 3 },

  notice: { marginTop: 10, padding: 6, borderWidth: 0.5, borderColor: HAIRLINE, fontSize: 8, color: MUTED },

  statGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 12, borderTopWidth: 1, borderTopColor: RULE },
  stat: { width: "20%", paddingVertical: 6, paddingRight: 8 },
  statLabel: { fontSize: 6.5, fontWeight: 700, color: MUTED, letterSpacing: 0.5 },
  statValue: { fontSize: 11, fontWeight: 700, marginTop: 2 },
  statDetail: { fontSize: 7, color: MUTED, marginTop: 1 },

  tableTitle: { fontSize: 9.5, fontWeight: 700, marginTop: 16, marginBottom: 4 },
  tableDescription: { fontSize: 7.5, color: MUTED, marginBottom: 4 },

  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: RULE, paddingBottom: 3 },
  headCell: { fontSize: 6.5, fontWeight: 700, color: MUTED, letterSpacing: 0.4, paddingRight: 5 },

  row: { flexDirection: "row", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: HAIRLINE },
  groupRow: { flexDirection: "row", paddingTop: 6, paddingBottom: 2 },
  groupText: { fontSize: 7, fontWeight: 700, color: MUTED, letterSpacing: 0.4 },
  totalRow: { flexDirection: "row", paddingVertical: 4, borderTopWidth: 1, borderTopColor: RULE, marginTop: 1 },
  cell: { paddingRight: 5 },
  bold: { fontWeight: 700 },

  cap: { fontSize: 7.5, color: MUTED, marginTop: 5 },
  empty: { fontSize: 8, color: MUTED, marginTop: 10 },

  footer: {
    position: "absolute",
    bottom: 26,
    left: 34,
    right: 34,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 7, color: MUTED },
})

/**
 * Column widths are proportional to a weight per type — numbers need less room
 * than prose, and the first text column absorbs the slack.
 */
function columnWidths(columns: ReportColumn[]): string[] {
  const weights = columns.map((column, index) => {
    if (isNumericColumn(column)) return 1
    if (column.type === "date") return 0.9
    if (column.type === "status") return 0.9
    return index === 0 ? 2 : 1.4
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => `${((weight / total) * 100).toFixed(3)}%`)
}

function Cells({ row, columns, widths, bold }: { row: ReportRow; columns: ReportColumn[]; widths: string[]; bold?: boolean }) {
  return (
    <>
      {columns.map((column, index) => (
        <Text
          key={column.key}
          style={[
            styles.cell,
            { width: widths[index], textAlign: isNumericColumn(column) ? "right" : "left" },
            ...(bold ? [styles.bold] : []),
          ]}
        >
          {formatCell(row.cells[column.key] ?? null, column.type)}
        </Text>
      ))}
    </>
  )
}

function TableBlock({ table }: { table: ReportTable }) {
  const columns = visibleColumns(table.columns)
  const widths = columnWidths(columns)

  return (
    <View>
      {table.title ? <Text style={styles.tableTitle}>{table.title}</Text> : null}
      {table.description ? <Text style={styles.tableDescription}>{table.description}</Text> : null}

      <View style={styles.headRow} fixed>
        {columns.map((column, index) => (
          <Text
            key={column.key}
            style={[styles.headCell, { width: widths[index], textAlign: isNumericColumn(column) ? "right" : "left" }]}
          >
            {column.header.toUpperCase()}
          </Text>
        ))}
      </View>

      {table.rows.length === 0 ? (
        <Text style={styles.empty}>{table.emptyMessage ?? "No rows for this report."}</Text>
      ) : (
        table.rows.map((row) =>
          row.emphasis === "group" ? (
            <View key={row.key} style={styles.groupRow} wrap={false}>
              <Text style={styles.groupText}>
                {formatCell(row.cells[columns[0].key] ?? null, "text").toUpperCase()}
              </Text>
            </View>
          ) : (
            <View
              key={row.key}
              style={row.emphasis === "total" ? styles.totalRow : styles.row}
              wrap={false}
            >
              <Cells row={row} columns={columns} widths={widths} bold={row.emphasis !== undefined} />
            </View>
          ),
        )
      )}

      {table.totals && table.rows.length > 0 ? (
        <View style={styles.totalRow} wrap={false}>
          <Cells row={{ key: "totals", cells: table.totals }} columns={columns} widths={widths} bold />
        </View>
      ) : null}

      {table.cap ? (
        <Text style={styles.cap}>
          Showing {table.cap.shown.toLocaleString()} of {table.cap.total.toLocaleString()} rows.
        </Text>
      ) : null}
    </View>
  )
}

function ReportDocument({
  title,
  provenance,
  result,
  branding,
  logo,
  family,
  generatedAt,
}: {
  title: string
  provenance: string
  result: ReportResult
  branding: ReportPdfBranding
  logo: string | null
  family: string
  generatedAt: string
}) {
  const landscape = result.tables.some((table) => visibleColumns(table.columns).length > 6)

  return (
    <Document title={title} author={branding.org_name ?? "Arc"}>
      <Page size="LETTER" orientation={landscape ? "landscape" : "portrait"} style={[styles.page, { fontFamily: family }]}>
        <View style={styles.header}>
          {logo ? <Image src={logo} style={styles.logo} /> : null}
          {branding.org_name ? <Text style={styles.orgName}>{branding.org_name}</Text> : null}
          <Text style={styles.reportName}>{title}</Text>
          <Text style={styles.provenance}>{provenance}</Text>
        </View>

        {result.notice ? <Text style={styles.notice}>{result.notice.message}</Text> : null}

        {result.stats && result.stats.length > 0 ? (
          <View style={styles.statGrid}>
            {result.stats.map((stat) => (
              <View key={stat.key} style={styles.stat}>
                <Text style={styles.statLabel}>{stat.label.toUpperCase()}</Text>
                <Text style={styles.statValue}>{stat.value}</Text>
                {stat.detail ? <Text style={styles.statDetail}>{stat.detail}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}

        {result.tables.map((table) => (
          <TableBlock key={table.key} table={table} />
        ))}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Generated {generatedAt}</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`} />
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

export async function renderReportPdf({
  title,
  provenance,
  result,
  branding,
}: {
  title: string
  provenance: string
  result: ReportResult
  branding: ReportPdfBranding
}): Promise<Buffer> {
  const family = ensureFonts()
  const logo = await flattenLogoForPdf(branding.org_logo_url)
  const generatedAt = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  const pdf = await renderToBuffer(
    <ReportDocument
      title={title}
      provenance={provenance}
      result={result}
      branding={branding}
      logo={logo}
      family={family}
      generatedAt={generatedAt}
    />,
  )
  return Buffer.from(pdf)
}
