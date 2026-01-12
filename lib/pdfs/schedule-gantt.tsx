import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import { format, differenceInDays, addDays, isSameDay, isWeekend } from "date-fns"

export type ScheduleItemData = {
  id: string
  name: string
  item_type: "task" | "milestone" | "inspection" | "phase" | "delivery" | "handoff"
  status: "planned" | "in_progress" | "at_risk" | "blocked" | "completed" | "cancelled"
  start_date: string | null
  end_date: string | null
  progress: number
  is_critical_path?: boolean
  phase?: string | null
  trade?: string | null
}

export type ScheduleGanttPdfData = {
  orgName?: string
  projectName: string
  items: ScheduleItemData[]
  generatedAt: string
  dateRange?: { start: string; end: string }
}

// Status colors for bars
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  planned: { bg: "#94a3b8", text: "#ffffff" },
  in_progress: { bg: "#3b82f6", text: "#ffffff" },
  at_risk: { bg: "#f59e0b", text: "#ffffff" },
  blocked: { bg: "#ef4444", text: "#ffffff" },
  completed: { bg: "#22c55e", text: "#ffffff" },
  cancelled: { bg: "#6b7280", text: "#ffffff" },
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  task: "Task",
  milestone: "Milestone",
  inspection: "Inspection",
  phase: "Phase",
  delivery: "Delivery",
  handoff: "Handoff",
}

const styles = StyleSheet.create({
  page: {
    padding: 24,
    fontSize: 8,
    fontFamily: "Helvetica",
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  headerLeft: {},
  headerRight: {
    alignItems: "flex-end",
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 10,
    color: "#64748b",
    marginTop: 2,
  },
  dateRange: {
    fontSize: 9,
    color: "#64748b",
  },
  // Table styles
  table: {
    width: "100%",
    marginTop: 8,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 4,
    paddingHorizontal: 4,
    minHeight: 20,
  },
  tableRowCritical: {
    backgroundColor: "#fef3c7",
  },
  colName: {
    width: "28%",
    paddingRight: 6,
  },
  colType: {
    width: "10%",
    paddingRight: 4,
  },
  colPhase: {
    width: "12%",
    paddingRight: 4,
  },
  colDates: {
    width: "18%",
    paddingRight: 4,
  },
  colStatus: {
    width: "12%",
    paddingRight: 4,
  },
  colProgress: {
    width: "20%",
  },
  headerText: {
    fontSize: 7,
    fontWeight: 700,
    color: "#475569",
    textTransform: "uppercase",
  },
  cellText: {
    fontSize: 8,
    color: "#334155",
  },
  cellTextSmall: {
    fontSize: 7,
    color: "#64748b",
  },
  // Status badge
  statusBadge: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 3,
    alignSelf: "flex-start",
  },
  statusText: {
    fontSize: 6,
    fontWeight: 600,
    textTransform: "uppercase",
  },
  // Progress bar
  progressContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: "#e2e8f0",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressText: {
    fontSize: 7,
    color: "#64748b",
    width: 24,
    textAlign: "right",
  },
  // Legend
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 7,
    color: "#64748b",
  },
  // Footer
  footer: {
    position: "absolute",
    bottom: 20,
    left: 24,
    right: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8,
  },
  footerText: {
    fontSize: 7,
    color: "#94a3b8",
  },
  // Critical path indicator
  criticalIndicator: {
    fontSize: 6,
    color: "#f59e0b",
    marginLeft: 4,
  },
  // Summary stats
  summaryRow: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  summaryItem: {
    alignItems: "center",
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#0f172a",
  },
  summaryLabel: {
    fontSize: 7,
    color: "#64748b",
    marginTop: 2,
  },
})

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "No dates"
  const startDate = new Date(start)
  const endDate = end ? new Date(end) : null

  if (!endDate || isSameDay(startDate, endDate)) {
    return format(startDate, "MMM d, yyyy")
  }

  // Same month
  if (format(startDate, "MMM yyyy") === format(endDate, "MMM yyyy")) {
    return `${format(startDate, "MMM d")} - ${format(endDate, "d, yyyy")}`
  }

  return `${format(startDate, "MMM d")} - ${format(endDate, "MMM d, yyyy")}`
}

function calculateStats(items: ScheduleItemData[]) {
  const total = items.length
  const completed = items.filter(i => i.status === "completed").length
  const atRisk = items.filter(i => i.status === "at_risk" || i.status === "blocked").length
  const inProgress = items.filter(i => i.status === "in_progress").length
  const onCriticalPath = items.filter(i => i.is_critical_path).length
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0

  return { total, completed, atRisk, inProgress, onCriticalPath, completionRate }
}

function ScheduleGanttDocument({ data }: { data: ScheduleGanttPdfData }) {
  const stats = calculateStats(data.items)

  // Sort items: in_progress first, then by start_date
  const sortedItems = [...data.items].sort((a, b) => {
    // Critical path items first
    if (a.is_critical_path && !b.is_critical_path) return -1
    if (!a.is_critical_path && b.is_critical_path) return 1

    // Then by status priority
    const statusOrder = { in_progress: 0, at_risk: 1, blocked: 2, planned: 3, completed: 4, cancelled: 5 }
    const statusDiff = (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3)
    if (statusDiff !== 0) return statusDiff

    // Then by start date
    if (!a.start_date && !b.start_date) return 0
    if (!a.start_date) return 1
    if (!b.start_date) return -1
    return new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  })

  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>{data.projectName} - Schedule</Text>
            {data.orgName && <Text style={styles.subtitle}>{data.orgName}</Text>}
          </View>
          <View style={styles.headerRight}>
            {data.dateRange && (
              <Text style={styles.dateRange}>
                {format(new Date(data.dateRange.start), "MMM d, yyyy")} - {format(new Date(data.dateRange.end), "MMM d, yyyy")}
              </Text>
            )}
            <Text style={styles.subtitle}>{data.items.length} items</Text>
          </View>
        </View>

        {/* Summary Stats */}
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{stats.total}</Text>
            <Text style={styles.summaryLabel}>Total Items</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{stats.inProgress}</Text>
            <Text style={styles.summaryLabel}>In Progress</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={stats.atRisk > 0 ? [styles.summaryValue, { color: "#f59e0b" }] : styles.summaryValue}>{stats.atRisk}</Text>
            <Text style={styles.summaryLabel}>At Risk</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: "#22c55e" }]}>{stats.completed}</Text>
            <Text style={styles.summaryLabel}>Completed</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: "#22c55e" }]}>{stats.completionRate}%</Text>
            <Text style={styles.summaryLabel}>Completion</Text>
          </View>
          {stats.onCriticalPath > 0 && (
            <View style={styles.summaryItem}>
              <Text style={[styles.summaryValue, { color: "#f59e0b" }]}>{stats.onCriticalPath}</Text>
              <Text style={styles.summaryLabel}>Critical Path</Text>
            </View>
          )}
        </View>

        {/* Table */}
        <View style={styles.table}>
          {/* Table Header */}
          <View style={styles.tableHeader}>
            <View style={styles.colName}>
              <Text style={styles.headerText}>Item</Text>
            </View>
            <View style={styles.colType}>
              <Text style={styles.headerText}>Type</Text>
            </View>
            <View style={styles.colPhase}>
              <Text style={styles.headerText}>Phase</Text>
            </View>
            <View style={styles.colDates}>
              <Text style={styles.headerText}>Dates</Text>
            </View>
            <View style={styles.colStatus}>
              <Text style={styles.headerText}>Status</Text>
            </View>
            <View style={styles.colProgress}>
              <Text style={styles.headerText}>Progress</Text>
            </View>
          </View>

          {/* Table Rows */}
          {sortedItems.map((item, index) => {
            const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.planned

            // Build merged styles
            const rowStyle = {
              ...styles.tableRow,
              ...(item.is_critical_path ? styles.tableRowCritical : {}),
              ...(index % 2 === 1 ? { backgroundColor: "#fafafa" } : {}),
            }

            return (
              <View
                key={item.id}
                style={rowStyle}
              >
                <View style={styles.colName}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Text style={styles.cellText}>{item.name}</Text>
                    {item.is_critical_path && (
                      <Text style={styles.criticalIndicator}>CP</Text>
                    )}
                  </View>
                  {item.trade && (
                    <Text style={styles.cellTextSmall}>{item.trade.replace(/_/g, " ")}</Text>
                  )}
                </View>
                <View style={styles.colType}>
                  <Text style={styles.cellText}>{ITEM_TYPE_LABELS[item.item_type] || item.item_type}</Text>
                </View>
                <View style={styles.colPhase}>
                  <Text style={styles.cellText}>
                    {item.phase ? item.phase.replace(/_/g, " ") : "-"}
                  </Text>
                </View>
                <View style={styles.colDates}>
                  <Text style={styles.cellText}>
                    {formatDateRange(item.start_date, item.end_date)}
                  </Text>
                </View>
                <View style={styles.colStatus}>
                  <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
                    <Text style={[styles.statusText, { color: statusColor.text }]}>
                      {item.status.replace(/_/g, " ")}
                    </Text>
                  </View>
                </View>
                <View style={styles.colProgress}>
                  <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${item.progress}%`,
                            backgroundColor: item.status === "completed" ? "#22c55e" : "#3b82f6"
                          }
                        ]}
                      />
                    </View>
                    <Text style={styles.progressText}>{item.progress}%</Text>
                  </View>
                </View>
              </View>
            )
          })}
        </View>

        {/* Legend */}
        <View style={styles.legend}>
          {Object.entries(STATUS_COLORS).map(([status, color]) => (
            <View key={status} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: color.bg }]} />
              <Text style={styles.legendText}>{status.replace(/_/g, " ")}</Text>
            </View>
          ))}
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#f59e0b" }]} />
            <Text style={styles.legendText}>Critical Path</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Generated by Strata</Text>
          <Text style={styles.footerText}>{data.generatedAt}</Text>
        </View>
      </Page>
    </Document>
  )
}

export async function renderScheduleGanttPdf(data: ScheduleGanttPdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<ScheduleGanttDocument data={data} />)
  return Buffer.from(pdf)
}
