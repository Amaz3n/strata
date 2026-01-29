import { Document, Page, StyleSheet, Text, View, renderToBuffer, Svg, Rect, Polygon, Line } from "@react-pdf/renderer"
import { format, differenceInDays, addDays, startOfDay, eachDayOfInterval, eachWeekOfInterval, eachMonthOfInterval, startOfWeek, startOfMonth, endOfMonth } from "date-fns"

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

export type ScheduleGanttVisualPdfData = {
  orgName?: string
  projectName: string
  items: ScheduleItemData[]
  generatedAt: string
  dateRange?: { start: string; end: string }
}

// Status colors
const STATUS_COLORS: Record<string, { bg: string; progress: string }> = {
  planned: { bg: "#94a3b8", progress: "#64748b" },
  in_progress: { bg: "#3b82f6", progress: "#1d4ed8" },
  at_risk: { bg: "#f59e0b", progress: "#d97706" },
  blocked: { bg: "#ef4444", progress: "#dc2626" },
  completed: { bg: "#22c55e", progress: "#16a34a" },
  cancelled: { bg: "#6b7280", progress: "#4b5563" },
}

// Layout constants
const PAGE_WIDTH = 792 // Letter landscape
const PAGE_HEIGHT = 612
const MARGIN = 24
const HEADER_HEIGHT = 50
const TIMELINE_HEADER_HEIGHT = 40
const ROW_HEIGHT = 24
const NAME_COL_WIDTH = 180
const GANTT_WIDTH = PAGE_WIDTH - (MARGIN * 2) - NAME_COL_WIDTH - 10
const FOOTER_HEIGHT = 60

const styles = StyleSheet.create({
  page: {
    padding: MARGIN,
    fontSize: 8,
    fontFamily: "Helvetica",
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  headerLeft: {},
  headerRight: {
    alignItems: "flex-end",
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 9,
    color: "#64748b",
    marginTop: 2,
  },
  dateRange: {
    fontSize: 8,
    color: "#64748b",
  },
  // Gantt container
  ganttContainer: {
    flexDirection: "row",
    flex: 1,
  },
  // Left side - task names
  namesColumn: {
    width: NAME_COL_WIDTH,
    borderRightWidth: 1,
    borderRightColor: "#e2e8f0",
  },
  namesHeader: {
    height: TIMELINE_HEADER_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: 8,
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  namesHeaderText: {
    fontSize: 8,
    fontWeight: 700,
    color: "#475569",
  },
  nameRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: "#f1f5f9",
  },
  nameRowCritical: {
    backgroundColor: "#fef9c3",
  },
  nameText: {
    fontSize: 7,
    color: "#334155",
    flex: 1,
  },
  nameTextTruncate: {
    maxWidth: NAME_COL_WIDTH - 20,
  },
  criticalBadge: {
    fontSize: 5,
    color: "#f59e0b",
    marginLeft: 4,
  },
  // Right side - timeline
  timelineColumn: {
    flex: 1,
  },
  timelineHeader: {
    height: TIMELINE_HEADER_HEIGHT,
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  timelineHeaderCell: {
    justifyContent: "center",
    alignItems: "center",
    borderRightWidth: 0.5,
    borderRightColor: "#e2e8f0",
  },
  timelineHeaderText: {
    fontSize: 6,
    color: "#64748b",
  },
  timelineHeaderTextBold: {
    fontSize: 7,
    fontWeight: 700,
    color: "#475569",
  },
  // Gantt rows
  ganttRow: {
    height: ROW_HEIGHT,
    position: "relative",
    borderBottomWidth: 0.5,
    borderBottomColor: "#f1f5f9",
  },
  ganttRowCritical: {
    backgroundColor: "#fef9c3",
  },
  // Legend & Footer
  footer: {
    position: "absolute",
    bottom: MARGIN,
    left: MARGIN,
    right: MARGIN,
    height: FOOTER_HEIGHT - 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 8,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendText: {
    fontSize: 6,
    color: "#64748b",
  },
  footerText: {
    fontSize: 6,
    color: "#94a3b8",
    textAlign: "right",
  },
  // Grid lines
  gridLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0.5,
    backgroundColor: "#f1f5f9",
  },
  todayLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "#ef4444",
  },
})

function calculateTimelineColumns(startDate: Date, endDate: Date, availableWidth: number) {
  const totalDays = differenceInDays(endDate, startDate) + 1

  // Determine granularity based on date range
  let columns: { date: Date; label: string; subLabel?: string; width: number }[] = []

  if (totalDays <= 14) {
    // Daily view
    const days = eachDayOfInterval({ start: startDate, end: endDate })
    const dayWidth = availableWidth / days.length
    columns = days.map(day => ({
      date: day,
      label: format(day, "d"),
      subLabel: format(day, "EEE"),
      width: dayWidth,
    }))
  } else if (totalDays <= 60) {
    // Weekly view
    const weeks = eachWeekOfInterval({ start: startDate, end: endDate }, { weekStartsOn: 1 })
    const weekWidth = availableWidth / weeks.length
    columns = weeks.map(week => ({
      date: week,
      label: format(week, "MMM d"),
      width: weekWidth,
    }))
  } else {
    // Monthly view
    const months = eachMonthOfInterval({ start: startDate, end: endDate })
    const monthWidth = availableWidth / months.length
    columns = months.map(month => ({
      date: month,
      label: format(month, "MMM"),
      subLabel: format(month, "yyyy"),
      width: monthWidth,
    }))
  }

  return { columns, totalDays }
}

function getBarPosition(
  itemStart: Date,
  itemEnd: Date,
  timelineStart: Date,
  totalDays: number,
  availableWidth: number
) {
  const startOffset = differenceInDays(itemStart, timelineStart)
  const duration = differenceInDays(itemEnd, itemStart) + 1

  const pixelsPerDay = availableWidth / totalDays
  const left = Math.max(0, startOffset * pixelsPerDay)
  const width = Math.min(duration * pixelsPerDay, availableWidth - left)

  return { left, width: Math.max(width, 4) } // Minimum 4px width
}

// Task bar component using SVG
function TaskBar({
  x,
  width,
  status,
  progress,
  isMilestone,
  rowHeight
}: {
  x: number
  width: number
  status: string
  progress: number
  isMilestone: boolean
  rowHeight: number
}) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.planned
  const barHeight = 12
  const y = (rowHeight - barHeight) / 2

  if (isMilestone) {
    // Diamond shape for milestones
    const size = 10
    const centerY = rowHeight / 2
    return (
      <Svg width={width + 20} height={rowHeight} style={{ position: "absolute", left: x - 10, top: 0 }}>
        <Polygon
          points={`${size/2 + 10},${centerY - size/2} ${size + 10},${centerY} ${size/2 + 10},${centerY + size/2} ${10},${centerY}`}
          fill={colors.bg}
        />
      </Svg>
    )
  }

  const progressWidth = (width * progress) / 100

  return (
    <Svg width={width} height={rowHeight} style={{ position: "absolute", left: x, top: 0 }}>
      {/* Background bar */}
      <Rect x={0} y={y} width={width} height={barHeight} rx={2} fill={colors.bg} />
      {/* Progress fill */}
      {progress > 0 && (
        <Rect x={0} y={y} width={progressWidth} height={barHeight} rx={2} fill={colors.progress} />
      )}
    </Svg>
  )
}

function ScheduleGanttVisualDocument({ data }: { data: ScheduleGanttVisualPdfData }) {
  // Filter items with dates and sort
  const itemsWithDates = data.items
    .filter(item => item.start_date)
    .sort((a, b) => {
      // Critical path first
      if (a.is_critical_path && !b.is_critical_path) return -1
      if (!a.is_critical_path && b.is_critical_path) return 1
      // Then by start date
      return new Date(a.start_date!).getTime() - new Date(b.start_date!).getTime()
    })

  // Calculate date range
  let minDate: Date
  let maxDate: Date

  if (data.dateRange) {
    minDate = startOfDay(new Date(data.dateRange.start))
    maxDate = startOfDay(new Date(data.dateRange.end))
  } else {
    const dates = itemsWithDates.flatMap(item => [
      item.start_date ? new Date(item.start_date) : null,
      item.end_date ? new Date(item.end_date) : null,
    ]).filter(Boolean) as Date[]

    minDate = dates.length > 0 ? startOfDay(new Date(Math.min(...dates.map(d => d.getTime())))) : new Date()
    maxDate = dates.length > 0 ? startOfDay(new Date(Math.max(...dates.map(d => d.getTime())))) : addDays(new Date(), 30)
  }

  // Add padding to date range
  minDate = addDays(minDate, -2)
  maxDate = addDays(maxDate, 2)

  const { columns, totalDays } = calculateTimelineColumns(minDate, maxDate, GANTT_WIDTH)

  // Calculate how many items fit per page
  const availableHeight = PAGE_HEIGHT - (MARGIN * 2) - HEADER_HEIGHT - TIMELINE_HEADER_HEIGHT - FOOTER_HEIGHT
  const itemsPerPage = Math.floor(availableHeight / ROW_HEIGHT)

  // Split items into pages
  const pages: ScheduleItemData[][] = []
  for (let i = 0; i < itemsWithDates.length; i += itemsPerPage) {
    pages.push(itemsWithDates.slice(i, i + itemsPerPage))
  }

  // If no items, still show one empty page
  if (pages.length === 0) {
    pages.push([])
  }

  const today = startOfDay(new Date())
  const todayPosition = differenceInDays(today, minDate) * (GANTT_WIDTH / totalDays)
  const showTodayLine = today >= minDate && today <= maxDate

  return (
    <Document>
      {pages.map((pageItems, pageIndex) => (
        <Page key={pageIndex} size="LETTER" orientation="landscape" style={styles.page}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.title}>{data.projectName} - Schedule</Text>
              {data.orgName && <Text style={styles.subtitle}>{data.orgName}</Text>}
            </View>
            <View style={styles.headerRight}>
              <Text style={styles.dateRange}>
                {format(minDate, "MMM d, yyyy")} - {format(maxDate, "MMM d, yyyy")}
              </Text>
              <Text style={styles.subtitle}>
                {data.items.length} items | Page {pageIndex + 1} of {pages.length}
              </Text>
            </View>
          </View>

          {/* Gantt Chart */}
          <View style={styles.ganttContainer}>
            {/* Names Column */}
            <View style={styles.namesColumn}>
              <View style={styles.namesHeader}>
                <Text style={styles.namesHeaderText}>Task</Text>
              </View>
              {pageItems.map((item) => (
                <View
                  key={item.id}
                  style={[
                    styles.nameRow,
                    item.is_critical_path ? styles.nameRowCritical : {},
                  ]}
                >
                  {/* @ts-ignore */}
                  <Text style={[styles.nameText, styles.nameTextTruncate]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.is_critical_path && (
                    <Text style={styles.criticalBadge}>CP</Text>
                  )}
                </View>
              ))}
            </View>

            {/* Timeline Column */}
            <View style={styles.timelineColumn}>
              {/* Timeline Header */}
              <View style={styles.timelineHeader}>
                {columns.map((col, idx) => (
                  <View
                    key={idx}
                    style={[styles.timelineHeaderCell, { width: col.width }]}
                  >
                    <Text style={styles.timelineHeaderTextBold}>{col.label}</Text>
                    {col.subLabel && (
                      <Text style={styles.timelineHeaderText}>{col.subLabel}</Text>
                    )}
                  </View>
                ))}
              </View>

              {/* Gantt Rows */}
              {pageItems.map((item) => {
                const itemStart = item.start_date ? startOfDay(new Date(item.start_date)) : null
                const itemEnd = item.end_date ? startOfDay(new Date(item.end_date)) : itemStart

                if (!itemStart || !itemEnd) return (
                  <View key={item.id} style={styles.ganttRow} />
                )

                const { left, width } = getBarPosition(itemStart, itemEnd, minDate, totalDays, GANTT_WIDTH)
                const isMilestone = item.item_type === "milestone"

                return (
                  <View
                    key={item.id}
                    style={[
                      styles.ganttRow,
                      item.is_critical_path ? styles.ganttRowCritical : {},
                    ]}
                  >
                    {/* Grid lines */}
                    {columns.map((col, idx) => {
                      let xPos = 0
                      for (let i = 0; i < idx; i++) {
                        xPos += columns[i].width
                      }
                      return (
                        <View
                          key={idx}
                          style={[styles.gridLine, { left: xPos }]}
                        />
                      )
                    })}

                    {/* Today line */}
                    {showTodayLine && (
                      <View style={[styles.todayLine, { left: todayPosition }]} />
                    )}

                    {/* Task bar */}
                    <TaskBar
                      x={left}
                      width={width}
                      status={item.status}
                      progress={item.progress}
                      isMilestone={isMilestone}
                      rowHeight={ROW_HEIGHT}
                    />
                  </View>
                )
              })}
            </View>
          </View>

          {/* Footer with Legend */}
          <View style={styles.footer}>
            <View style={styles.legend}>
              {Object.entries(STATUS_COLORS).map(([status, colors]) => (
                <View key={status} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.bg }]} />
                  <Text style={styles.legendText}>{status.replace(/_/g, " ")}</Text>
                </View>
              ))}
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#fef9c3", borderWidth: 1, borderColor: "#f59e0b" }]} />
                <Text style={styles.legendText}>Critical Path</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={{ width: 8, height: 1, backgroundColor: "#ef4444" }} />
                <Text style={styles.legendText}>Today</Text>
              </View>
            </View>
            <Text style={styles.footerText}>Generated by Arc | {data.generatedAt}</Text>
          </View>
        </Page>
      ))}
    </Document>
  )
}

export async function renderScheduleGanttVisualPdf(data: ScheduleGanttVisualPdfData): Promise<Buffer> {
  const pdf = await renderToBuffer(<ScheduleGanttVisualDocument data={data} />)
  return Buffer.from(pdf)
}
