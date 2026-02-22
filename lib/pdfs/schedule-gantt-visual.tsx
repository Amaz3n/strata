import { Document, Page, StyleSheet, Text, View, renderToBuffer, Svg, Rect, Polygon, Image } from "@react-pdf/renderer"
import {
  addDays,
  differenceInDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
} from "date-fns"

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
  orgLogoUrl?: string
  orgLogoAspectRatio?: number
  projectName: string
  items: ScheduleItemData[]
  generatedAt: string
  dateRange?: { start: string; end: string }
}

type TimelineColumn = {
  date: Date
  endDate: Date
  label: string
  subLabel?: string
  width: number
  isWeekend?: boolean
}

type StatusVisualStyle = {
  bar: string
  badgeBg: string
  badgeText: string
  legend: string
}

const ARC_COLORS = {
  background: "#ffffff",
  paper: "#ffffff",
  border: "#d3dae8",
  borderMuted: "#e7ecf5",
  text: "#11254a",
  muted: "#5b6b89",
  primary: "#3b5bcc",
  weekend: "#f9fbff",
  criticalTint: "#fff5ed",
}

const STATUS_VISUALS: Record<ScheduleItemData["status"], StatusVisualStyle> = {
  planned: {
    bar: "#7b8da9",
    badgeBg: "#eef2f8",
    badgeText: "#4a5d7c",
    legend: "#7b8da9",
  },
  in_progress: {
    bar: "#3b82f6",
    badgeBg: "#e8f1ff",
    badgeText: "#1d4ed8",
    legend: "#3b82f6",
  },
  at_risk: {
    bar: "#f59e0b",
    badgeBg: "#fff4de",
    badgeText: "#b45309",
    legend: "#f59e0b",
  },
  blocked: {
    bar: "#ef4444",
    badgeBg: "#ffe8e8",
    badgeText: "#b91c1c",
    legend: "#ef4444",
  },
  completed: {
    bar: "#22c55e",
    badgeBg: "#e9f9ef",
    badgeText: "#166534",
    legend: "#22c55e",
  },
  cancelled: {
    bar: "#6b7280",
    badgeBg: "#f3f4f6",
    badgeText: "#374151",
    legend: "#6b7280",
  },
}

const PHASE_COLORS: Record<string, string> = {
  pre_construction: "#7c3aed",
  site_work: "#f97316",
  foundation: "#0ea5e9",
  framing: "#eab308",
  roofing: "#10b981",
  mep_rough: "#6366f1",
  insulation: "#ec4899",
  drywall: "#14b8a6",
  finishes: "#a855f7",
  mep_trim: "#3b82f6",
  landscaping: "#22c55e",
  punch_list: "#f43f5e",
  closeout: "#64748b",
}

const ITEM_TYPE_LABELS: Record<ScheduleItemData["item_type"], string> = {
  task: "Task",
  milestone: "Milestone",
  inspection: "Inspection",
  phase: "Phase",
  delivery: "Delivery",
  handoff: "Handoff",
}

const PAGE_WIDTH = 792
const PAGE_HEIGHT = 612
const MARGIN = 24
const HEADER_HEIGHT = 66
const SUMMARY_HEIGHT = 62
const TIMELINE_HEADER_HEIGHT = 44
const ROW_HEIGHT = 26
const NAME_COL_WIDTH = 236
const FOOTER_HEIGHT = 52
const CHROME_VERTICAL_GAP = 30
const CHART_GUTTER = 10
const GANTT_WIDTH = PAGE_WIDTH - (MARGIN * 2) - NAME_COL_WIDTH - CHART_GUTTER

const styles = StyleSheet.create({
  page: {
    padding: MARGIN,
    fontSize: 8,
    fontFamily: "Helvetica",
    backgroundColor: ARC_COLORS.background,
  },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  headerLeft: {
    justifyContent: "flex-start",
  },
  brandPill: {
    alignSelf: "flex-start",
    backgroundColor: "#edf3ff",
    borderWidth: 1,
    borderColor: "#c9d7f8",
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 5,
  },
  brandPillText: {
    fontSize: 6,
    fontWeight: 700,
    color: "#1f3d99",
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: ARC_COLORS.text,
  },
  subtitle: {
    fontSize: 7,
    color: ARC_COLORS.muted,
    marginTop: 3,
  },
  headerRight: {
    width: 154,
    alignItems: "flex-end",
  },
  logoBox: {
    width: 154,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  logoBoxSquare: {
    width: 44,
    height: 44,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  logoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  logoFallbackText: {
    fontSize: 8,
    fontWeight: 700,
    color: ARC_COLORS.muted,
    textAlign: "center",
  },
  summaryRow: {
    height: SUMMARY_HEIGHT,
    flexDirection: "row",
    marginBottom: 10,
  },
  summaryCard: {
    position: "relative",
    flex: 1,
    marginRight: 6,
    borderWidth: 1,
    borderColor: ARC_COLORS.border,
    backgroundColor: ARC_COLORS.paper,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
  },
  summaryCardLast: {
    marginRight: 0,
  },
  summaryTone: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
  },
  summaryLabel: {
    fontSize: 6,
    color: "#4e5f7f",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: 700,
    color: ARC_COLORS.text,
    marginTop: 3,
  },
  summaryHelper: {
    fontSize: 6.1,
    color: ARC_COLORS.muted,
    marginTop: 2,
  },
  chartShell: {
    borderWidth: 1,
    borderColor: ARC_COLORS.border,
    backgroundColor: ARC_COLORS.paper,
    overflow: "hidden",
  },
  ganttContainer: {
    flexDirection: "row",
  },
  namesColumn: {
    width: NAME_COL_WIDTH,
    borderRightWidth: 1,
    borderRightColor: ARC_COLORS.border,
  },
  namesHeader: {
    height: TIMELINE_HEADER_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: ARC_COLORS.border,
    backgroundColor: "#f4f7fd",
  },
  namesHeaderMain: {
    fontSize: 8,
    fontWeight: 700,
    color: "#1f3d99",
  },
  namesHeaderSub: {
    fontSize: 6,
    color: "#5f6f8f",
    marginTop: 2,
  },
  nameRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: ARC_COLORS.borderMuted,
  },
  nameRowAlt: {
    backgroundColor: "#fcfdff",
  },
  nameRowCritical: {
    backgroundColor: ARC_COLORS.criticalTint,
  },
  nameLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  nameAccent: {
    width: 3,
    height: 14,
    marginRight: 7,
  },
  nameTextWrap: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  nameText: {
    fontSize: 7.6,
    color: "#1b2f57",
    fontWeight: 600,
  },
  nameMeta: {
    fontSize: 6.2,
    color: "#657897",
    marginTop: 1,
  },
  rowTags: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 6,
  },
  criticalTag: {
    backgroundColor: "#fff4e8",
    borderWidth: 1,
    borderColor: "#f7bb8a",
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginRight: 4,
  },
  criticalTagText: {
    fontSize: 5.5,
    color: "#c05621",
    fontWeight: 700,
  },
  statusTag: {
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  statusTagText: {
    fontSize: 5.5,
    fontWeight: 700,
  },
  emptyNameRow: {
    height: ROW_HEIGHT * 3,
    justifyContent: "center",
    alignItems: "center",
    borderBottomWidth: 0.5,
    borderBottomColor: ARC_COLORS.borderMuted,
  },
  emptyText: {
    fontSize: 7,
    color: ARC_COLORS.muted,
  },
  timelineColumn: {
    flex: 1,
  },
  timelineHeader: {
    height: TIMELINE_HEADER_HEIGHT,
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: ARC_COLORS.border,
    backgroundColor: "#f6f8fd",
  },
  timelineHeaderCell: {
    justifyContent: "center",
    alignItems: "center",
    borderRightWidth: 0.5,
    borderRightColor: "#dbe3f1",
    paddingTop: 2,
  },
  timelineHeaderCellWeekend: {
    backgroundColor: "#f9fbff",
  },
  timelineHeaderLabel: {
    fontSize: 7.2,
    color: "#223f8e",
    fontWeight: 700,
  },
  timelineHeaderSubLabel: {
    fontSize: 6,
    color: "#6a7ea8",
    marginTop: 1,
  },
  timelineRow: {
    height: ROW_HEIGHT,
    position: "relative",
    borderBottomWidth: 0.5,
    borderBottomColor: ARC_COLORS.borderMuted,
    overflow: "hidden",
  },
  timelineRowAlt: {
    backgroundColor: "#fcfdff",
  },
  timelineRowCritical: {
    backgroundColor: ARC_COLORS.criticalTint,
  },
  weekendBand: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: ARC_COLORS.weekend,
  },
  gridLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0.5,
    backgroundColor: "#e0e7f3",
  },
  barLabelWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
    overflow: "hidden",
  },
  barLabel: {
    fontSize: 6.2,
    color: "#ffffff",
    fontWeight: 700,
  },
  barProgressBadge: {
    position: "absolute",
    top: 7,
    width: 24,
    height: 12,
    backgroundColor: "rgba(17, 24, 39, 0.24)",
    justifyContent: "center",
    alignItems: "center",
  },
  barProgressBadgeText: {
    fontSize: 5.4,
    color: "#ffffff",
    fontWeight: 700,
  },
  emptyTimelineRow: {
    height: ROW_HEIGHT * 3,
    borderBottomWidth: 0.5,
    borderBottomColor: ARC_COLORS.borderMuted,
  },
  footer: {
    position: "absolute",
    left: MARGIN,
    right: MARGIN,
    bottom: MARGIN,
    height: FOOTER_HEIGHT,
    paddingTop: 7,
    borderTopWidth: 1,
    borderTopColor: ARC_COLORS.border,
  },
  footerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerBottom: {
    marginTop: 9,
    alignItems: "center",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 8,
  },
  legendSwatch: {
    width: 8,
    height: 8,
    marginRight: 4,
  },
  legendText: {
    fontSize: 6.1,
    color: ARC_COLORS.muted,
  },
  pageText: {
    fontSize: 7,
    color: "#213d88",
    fontWeight: 700,
  },
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toTitleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

function compactOrgName(value?: string): string {
  if (!value) return "ARC"
  if (value.length <= 26) return value
  return `${value.slice(0, 26)}…`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "")
  const expanded = normalized.length === 3
    ? normalized.split("").map((char) => `${char}${char}`).join("")
    : normalized

  const r = Number.parseInt(expanded.slice(0, 2), 16)
  const g = Number.parseInt(expanded.slice(2, 4), 16)
  const b = Number.parseInt(expanded.slice(4, 6), 16)

  return { r, g, b }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`
}

function darken(hex: string, amount = 0.2): string {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

function lighten(hex: string, amount = 0.2): string {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(
    r + (255 - r) * amount,
    g + (255 - g) * amount,
    b + (255 - b) * amount,
  )
}

function getBarColor(item: ScheduleItemData): string {
  if (item.phase && PHASE_COLORS[item.phase]) {
    return PHASE_COLORS[item.phase]
  }
  const statusVisual = STATUS_VISUALS[item.status] || STATUS_VISUALS.planned
  return statusVisual.bar
}

function calculateTimelineColumns(startDate: Date, endDate: Date, availableWidth: number): { columns: TimelineColumn[]; totalDays: number } {
  const totalDays = differenceInDays(endDate, startDate) + 1

  if (totalDays <= 21) {
    const days = eachDayOfInterval({ start: startDate, end: endDate })
    const dayWidth = availableWidth / Math.max(days.length, 1)

    return {
      totalDays,
      columns: days.map((day) => ({
        date: day,
        endDate: day,
        label: format(day, "d"),
        subLabel: format(day, "EEE"),
        width: dayWidth,
        isWeekend: day.getDay() === 0 || day.getDay() === 6,
      })),
    }
  }

  if (totalDays <= 120) {
    const weeks = eachWeekOfInterval({ start: startDate, end: endDate }, { weekStartsOn: 1 })
    const weekWidth = availableWidth / Math.max(weeks.length, 1)

    return {
      totalDays,
      columns: weeks.map((week) => ({
        date: week,
        endDate: endOfWeek(week, { weekStartsOn: 1 }),
        label: format(week, "MMM d"),
        subLabel: "Week",
        width: weekWidth,
      })),
    }
  }

  const months = eachMonthOfInterval({ start: startDate, end: endDate })
  const monthWidth = availableWidth / Math.max(months.length, 1)

  return {
    totalDays,
    columns: months.map((month) => ({
      date: month,
      endDate: endOfMonth(month),
      label: format(month, "MMM"),
      subLabel: format(month, "yyyy"),
      width: monthWidth,
    })),
  }
}

function getBarPosition(
  itemStart: Date,
  itemEnd: Date,
  timelineStart: Date,
  totalDays: number,
  availableWidth: number,
) {
  const startOffset = differenceInDays(itemStart, timelineStart)
  const duration = differenceInDays(itemEnd, itemStart) + 1
  const pixelsPerDay = availableWidth / totalDays

  const left = Math.max(0, startOffset * pixelsPerDay)
  const width = Math.min(duration * pixelsPerDay, availableWidth - left)

  return { left, width: Math.max(width, 8) }
}

function calculateStats(items: ScheduleItemData[]) {
  const total = items.length
  const completed = items.filter((item) => item.status === "completed").length
  const inProgress = items.filter((item) => item.status === "in_progress").length
  const atRiskCount = items.filter((item) => item.status === "at_risk").length
  const blockedCount = items.filter((item) => item.status === "blocked").length
  const critical = items.filter((item) => item.is_critical_path).length
  const milestones = items.filter((item) => item.item_type === "milestone").length
  const active = items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0
  const today = startOfDay(new Date())
  const upcomingMilestones = items.filter((item) => {
    if (item.item_type !== "milestone" || item.status === "completed") return false
    if (!item.start_date) return false
    return startOfDay(new Date(item.start_date)) >= today
  }).length

  return {
    total,
    completed,
    inProgress,
    atRiskCount,
    blockedCount,
    critical,
    milestones,
    active,
    completionRate,
    upcomingMilestones,
  }
}

function SummaryCard({
  label,
  value,
  helper,
  tone,
  isLast = false,
}: {
  label: string
  value: string | number
  helper: string
  tone: string
  isLast?: boolean
}) {
  return (
    <View style={[styles.summaryCard, ...(isLast ? [styles.summaryCardLast] : [])]}>
      <View style={[styles.summaryTone, { backgroundColor: tone }]} />
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, { color: darken(tone, 0.24) }]}>{value}</Text>
      <Text style={styles.summaryHelper}>{helper}</Text>
    </View>
  )
}

function TaskBar({
  x,
  width,
  progress,
  barColor,
  isMilestone,
  isCritical,
  rowHeight,
}: {
  x: number
  width: number
  progress: number
  barColor: string
  isMilestone: boolean
  isCritical: boolean
  rowHeight: number
}) {
  const progressClamped = clamp(progress || 0, 0, 100)

  if (isMilestone) {
    const centerX = x + width / 2
    const centerY = rowHeight / 2
    const radius = 6

    return (
      <Svg width={24} height={rowHeight} style={{ position: "absolute", left: centerX - 12, top: 0 }}>
        <Polygon
          points={`${12},${centerY - radius + 1} ${12 + radius},${centerY + 1} ${12},${centerY + radius + 1} ${12 - radius},${centerY + 1}`}
          fill={darken(barColor, 0.35)}
          opacity={0.25}
        />
        <Polygon
          points={`${12},${centerY - radius} ${12 + radius},${centerY} ${12},${centerY + radius} ${12 - radius},${centerY}`}
          fill={barColor}
          stroke={isCritical ? "#ea580c" : darken(barColor, 0.2)}
          strokeWidth={isCritical ? 1.2 : 0.6}
        />
        <Polygon
          points={`${12},${centerY - (radius - 2)} ${12 + (radius - 2)},${centerY} ${12},${centerY + (radius - 2)} ${12 - (radius - 2)},${centerY}`}
          fill={lighten(barColor, 0.26)}
          opacity={0.7}
        />
      </Svg>
    )
  }

  const barHeight = 14
  const y = (rowHeight - barHeight) / 2
  const progressWidth = (width * progressClamped) / 100
  const shadowColor = "#111827"
  const progressColor = darken(barColor, 0.22)
  const topHighlight = lighten(barColor, 0.23)

  return (
    <Svg width={Math.max(width + 2, 8)} height={rowHeight} style={{ position: "absolute", left: x, top: 0 }}>
      <Rect
        x={1}
        y={y + 1}
        width={Math.max(width, 3)}
        height={barHeight}
        fill={shadowColor}
        opacity={0.13}
      />
      <Rect x={0} y={y} width={Math.max(width, 3)} height={barHeight} fill={barColor} />
      <Rect
        x={0}
        y={y}
        width={Math.max(width, 3)}
        height={Math.max(4, barHeight * 0.46)}
        fill={topHighlight}
        opacity={0.65}
      />
      {progressClamped > 0 && (
        <Rect x={0} y={y} width={Math.max(progressWidth, 2)} height={barHeight} fill={progressColor} />
      )}
      {isCritical && (
        <Rect
          x={0.5}
          y={y + 0.5}
          width={Math.max(width - 1, 2)}
          height={barHeight - 1}
          fill="none"
          stroke="#ea580c"
          strokeWidth={1}
        />
      )}
    </Svg>
  )
}

function ScheduleGanttVisualDocument({ data }: { data: ScheduleGanttVisualPdfData }) {
  const itemsWithDates = data.items
    .filter((item) => item.start_date)
    .sort((a, b) => {
      if (a.is_critical_path && !b.is_critical_path) return -1
      if (!a.is_critical_path && b.is_critical_path) return 1
      return new Date(a.start_date!).getTime() - new Date(b.start_date!).getTime()
    })

  let scheduleWindowStart: Date
  let scheduleWindowEnd: Date

  if (data.dateRange) {
    scheduleWindowStart = startOfDay(new Date(data.dateRange.start))
    scheduleWindowEnd = startOfDay(new Date(data.dateRange.end))
  } else {
    const dates = itemsWithDates.flatMap((item) => [
      item.start_date ? new Date(item.start_date) : null,
      item.end_date ? new Date(item.end_date) : null,
    ]).filter(Boolean) as Date[]

    scheduleWindowStart = dates.length > 0 ? startOfDay(new Date(Math.min(...dates.map((date) => date.getTime())))) : startOfDay(new Date())
    scheduleWindowEnd = dates.length > 0 ? startOfDay(new Date(Math.max(...dates.map((date) => date.getTime())))) : addDays(startOfDay(new Date()), 30)
  }

  const timelineStart = addDays(scheduleWindowStart, -3)
  const timelineEnd = addDays(scheduleWindowEnd, 4)
  const { columns, totalDays } = calculateTimelineColumns(timelineStart, timelineEnd, GANTT_WIDTH)
  const columnOffsets: number[] = []
  let runningOffset = 0
  for (const col of columns) {
    columnOffsets.push(runningOffset)
    runningOffset += col.width
  }

  const availableRowsHeight =
    PAGE_HEIGHT - (MARGIN * 2) - HEADER_HEIGHT - SUMMARY_HEIGHT - TIMELINE_HEADER_HEIGHT - FOOTER_HEIGHT - CHROME_VERTICAL_GAP
  const itemsPerPage = Math.max(1, Math.floor(availableRowsHeight / ROW_HEIGHT))

  const pages: ScheduleItemData[][] = []
  for (let index = 0; index < itemsWithDates.length; index += itemsPerPage) {
    pages.push(itemsWithDates.slice(index, index + itemsPerPage))
  }
  if (pages.length === 0) pages.push([])

  const stats = calculateStats(itemsWithDates)
  const statusEntries = Object.entries(STATUS_VISUALS) as Array<[ScheduleItemData["status"], StatusVisualStyle]>
  const isSquareLogo =
    typeof data.orgLogoAspectRatio === "number" &&
    data.orgLogoAspectRatio >= 0.9 &&
    data.orgLogoAspectRatio <= 1.15

  return (
    <Document>
      {pages.map((pageItems, pageIndex) => (
        <Page key={pageIndex} size="LETTER" orientation="landscape" style={styles.page}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.brandPill}>
                <Text style={styles.brandPillText}>SCHEDULE</Text>
              </View>
              <Text style={styles.title}>{data.projectName}</Text>
              <Text style={styles.subtitle}>Generated {data.generatedAt}</Text>
            </View>

            <View style={styles.headerRight}>
              <View style={[styles.logoBox, ...(isSquareLogo ? [styles.logoBoxSquare] : [])]}>
                {data.orgLogoUrl ? (
                  <Image src={data.orgLogoUrl} style={styles.logoImage} /> // eslint-disable-line jsx-a11y/alt-text
                ) : (
                  <Text style={styles.logoFallbackText}>{compactOrgName(data.orgName)}</Text>
                )}
              </View>
            </View>
          </View>

          <View style={styles.summaryRow}>
            <SummaryCard
              label="Completion"
              value={`${stats.completionRate}%`}
              helper={`${stats.completed}/${Math.max(stats.total, 0)} complete`}
              tone="#22c55e"
            />
            <SummaryCard
              label="Active Work"
              value={stats.active}
              helper={`${stats.inProgress} in progress`}
              tone={ARC_COLORS.primary}
            />
            <SummaryCard
              label="Risk Flags"
              value={stats.atRiskCount + stats.blockedCount}
              helper={`${stats.atRiskCount} at risk • ${stats.blockedCount} blocked`}
              tone="#f59e0b"
            />
            <SummaryCard
              label="Critical Path"
              value={stats.critical}
              helper={`${Math.round((stats.critical / Math.max(stats.total, 1)) * 100)}% of schedule`}
              tone="#ea580c"
            />
            <SummaryCard
              label="Milestones"
              value={stats.milestones}
              helper={`${stats.upcomingMilestones} upcoming`}
              tone="#3b82f6"
              isLast
            />
          </View>

          <View style={styles.chartShell}>
            <View style={styles.ganttContainer}>
              <View style={styles.namesColumn}>
                <View style={styles.namesHeader}>
                  <Text style={styles.namesHeaderMain}>Work Item</Text>
                  <Text style={styles.namesHeaderSub}>Type • Trade • Status</Text>
                </View>

                {pageItems.length === 0 ? (
                  <View style={styles.emptyNameRow}>
                    <Text style={styles.emptyText}>No scheduled items with dates.</Text>
                  </View>
                ) : (
                  pageItems.map((item, rowIndex) => {
                    const statusVisual = STATUS_VISUALS[item.status] || STATUS_VISUALS.planned
                    const rowStyle = [
                      styles.nameRow,
                      ...(rowIndex % 2 === 1 ? [styles.nameRowAlt] : []),
                      ...(item.is_critical_path ? [styles.nameRowCritical] : []),
                    ]
                    const barColor = getBarColor(item)
                    const typeLabel = ITEM_TYPE_LABELS[item.item_type] || toTitleCase(item.item_type)
                    const tradeLabel = item.trade ? item.trade.replace(/_/g, " ") : null
                    const metaLabel = tradeLabel ? `${typeLabel} • ${tradeLabel}` : typeLabel

                    return (
                      <View key={item.id} style={rowStyle}>
                        <View style={styles.nameLeft}>
                          <View style={[styles.nameAccent, { backgroundColor: barColor }]} />
                          <View style={styles.nameTextWrap}>
                            <Text style={styles.nameText}>{item.name}</Text>
                            <Text style={styles.nameMeta}>{metaLabel}</Text>
                          </View>
                        </View>

                        <View style={styles.rowTags}>
                          {item.is_critical_path && (
                            <View style={styles.criticalTag}>
                              <Text style={styles.criticalTagText}>CP</Text>
                            </View>
                          )}
                          <View style={[styles.statusTag, { backgroundColor: statusVisual.badgeBg }]}>
                            <Text style={[styles.statusTagText, { color: statusVisual.badgeText }]}>
                              {toTitleCase(item.status)}
                            </Text>
                          </View>
                        </View>
                      </View>
                    )
                  })
                )}
              </View>

              <View style={styles.timelineColumn}>
                <View style={styles.timelineHeader}>
                  {columns.map((col, colIndex) => (
                    <View
                      key={`${format(col.date, "yyyy-MM-dd")}-${colIndex}`}
                      style={[
                        styles.timelineHeaderCell,
                        { width: col.width },
                        ...(col.isWeekend ? [styles.timelineHeaderCellWeekend] : []),
                      ]}
                    >
                      <Text style={styles.timelineHeaderLabel}>{col.label}</Text>
                      {col.subLabel && <Text style={styles.timelineHeaderSubLabel}>{col.subLabel}</Text>}
                    </View>
                  ))}
                </View>

                {pageItems.length === 0 ? (
                  <View style={styles.emptyTimelineRow} />
                ) : (
                  pageItems.map((item, rowIndex) => {
                    const rowStyle = [
                      styles.timelineRow,
                      ...(rowIndex % 2 === 1 ? [styles.timelineRowAlt] : []),
                      ...(item.is_critical_path ? [styles.timelineRowCritical] : []),
                    ]

                    const itemStart = item.start_date ? startOfDay(new Date(item.start_date)) : null
                    const itemEndBase = item.end_date ? startOfDay(new Date(item.end_date)) : itemStart
                    const itemEnd = itemStart && itemEndBase && itemEndBase < itemStart ? itemStart : itemEndBase

                    if (!itemStart || !itemEnd) {
                      return (
                        <View key={item.id} style={rowStyle}>
                          {columnOffsets.map((x, colIndex) => (
                            <View key={`${item.id}-grid-${colIndex}`} style={[styles.gridLine, { left: x }]} />
                          ))}
                        </View>
                      )
                    }

                    const position = getBarPosition(itemStart, itemEnd, timelineStart, totalDays, GANTT_WIDTH)
                    const isMilestone = item.item_type === "milestone"
                    const renderedWidth = isMilestone ? Math.max(position.width, 14) : position.width
                    const barColor = getBarColor(item)
                    const progressValue = clamp(item.progress || 0, 0, 100)
                    const showLabel = !isMilestone && renderedWidth > 78
                    const showProgressBadge = !isMilestone && progressValue > 0 && progressValue < 100 && renderedWidth > 118

                    return (
                      <View key={item.id} style={rowStyle}>
                        {columns.map((col, colIndex) => col.isWeekend ? (
                          <View
                            key={`${item.id}-weekend-${colIndex}`}
                            style={[styles.weekendBand, { left: columnOffsets[colIndex], width: col.width }]}
                          />
                        ) : null)}

                        {columnOffsets.map((x, colIndex) => (
                          <View key={`${item.id}-grid-${colIndex}`} style={[styles.gridLine, { left: x }]} />
                        ))}

                        <TaskBar
                          x={position.left}
                          width={renderedWidth}
                          progress={progressValue}
                          barColor={barColor}
                          isMilestone={isMilestone}
                          isCritical={Boolean(item.is_critical_path)}
                          rowHeight={ROW_HEIGHT}
                        />

                        {showLabel && (
                          <View style={[styles.barLabelWrap, { left: position.left + 8, width: Math.max(renderedWidth - 16, 12) }]}>
                            <Text style={styles.barLabel}>{item.name}</Text>
                          </View>
                        )}

                        {showProgressBadge && (
                          <View style={[styles.barProgressBadge, { left: position.left + renderedWidth - 28 }]}>
                            <Text style={styles.barProgressBadgeText}>{Math.round(progressValue)}%</Text>
                          </View>
                        )}
                      </View>
                    )
                  })
                )}
              </View>
            </View>
          </View>

          <View style={styles.footer}>
            <View style={styles.footerTop}>
              <View style={styles.legend}>
                {statusEntries.map(([status, statusVisual]) => (
                  <View key={status} style={styles.legendItem}>
                    <View style={[styles.legendSwatch, { backgroundColor: statusVisual.legend }]} />
                    <Text style={styles.legendText}>{toTitleCase(status)}</Text>
                  </View>
                ))}
                <View style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: "#fff4e8", borderWidth: 1, borderColor: "#f7bb8a" }]} />
                  <Text style={styles.legendText}>Critical Path</Text>
                </View>
              </View>
            </View>

            <View style={styles.footerBottom}>
              <Text style={styles.pageText}>Page {pageIndex + 1} of {pages.length}</Text>
            </View>
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
