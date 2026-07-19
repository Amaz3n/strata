import { Briefcase, Flag, Hammer, LayoutDashboard, Wallet } from "@/components/icons"
import type { LucideIcon } from "@/components/icons"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import type { Project, ProjectNavigationItem } from "@/lib/types"
import {
  getProjectPosture,
  type ProductTier,
  type ProjectPosture,
} from "@/lib/product-tier"

export type ProjectSection =
  | "overview"
  | "documents"
  | "drawings"
  | "bids"
  | "signatures"
  | "schedule"
  | "daily-logs"
  | "photos"
  | "tasks"
  | "time"
  | "punch"
  | "rfis"
  | "submittals"
  | "specs"
  | "meetings"
  | "transmittals"
  | "inspections"
  | "safety"
  | "decisions"
  | "selections"
  | "financials"
  | "financials-review"
  | "financials-tm-tickets"
  | "financials-waivers"
  | "budget"
  | "commitments"
  | "payables"
  | "receivables"
  | "invoices"
  | "expenses"
  | "change-orders"
  | "reports"
  | "closeout"
  | "closing"
  | "warranty"
  | "cost-inbox"

export type ProjectNavSubItem = {
  title: string
  url: string
  isActive?: boolean
  badge?: number
  requiredAny?: string[]
  postures?: ProjectPosture[]
  moduleKey?: string
}

export type ProjectNavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: number
  disabled?: boolean
  requiredAny?: string[]
  postures?: ProjectPosture[]
  moduleKey?: string
  items?: ProjectNavSubItem[]
}

export type ProjectNavGroup = {
  label?: string
  items: ProjectNavItem[]
}

const FINANCIAL_SECTIONS = new Set<ProjectSection>([
  "financials",
  "financials-review",
  "financials-tm-tickets",
  "financials-waivers",
  "budget",
  "commitments",
  "payables",
  "receivables",
  "invoices",
  "expenses",
  "change-orders",
  "reports",
  "cost-inbox",
])

export const BUILD_SECTIONS = new Set<ProjectSection>([
  "schedule",
  "daily-logs",
  "photos",
  "tasks",
  "time",
  "punch",
  "rfis",
  "submittals",
  "meetings",
  "transmittals",
  "inspections",
  "safety",
  "decisions",
  "selections",
])

export const PLAN_SECTIONS = new Set<ProjectSection>(["documents", "drawings", "specs", "bids", "signatures"])

export function getProjectIdFromPath(pathname: string): string | null {
  const segments = pathname.split("?")[0]?.split("/").filter(Boolean) ?? []
  if (segments[0] !== "projects" || !segments[1]) return null
  return decodeURIComponent(segments[1])
}

export function getProjectSection(pathname: string): ProjectSection {
  const segments = pathname.split("?")[0]?.split("/").filter(Boolean) ?? []
  if (segments[0] !== "projects" || !segments[1]) return "overview"

  const segment = segments[2]
  const subSegment = segments[3]

  if (!segment) return "overview"
  if (segment === "financials") {
    switch (subSegment) {
      case "review":
        return "financials-review"
      case "tm-tickets":
        return "financials-tm-tickets"
      case "waivers":
        return "financials-waivers"
      case "close":
        return "receivables"
      case "budget":
        return "budget"
      case "payables":
        return "payables"
      case "receivables":
        return "receivables"
      default:
        return "financials"
    }
  }

  switch (segment) {
    case "documents":
    case "drawings":
    case "bids":
    case "signatures":
    case "schedule":
    case "daily-logs":
    case "photos":
    case "tasks":
    case "time":
    case "punch":
    case "rfis":
    case "submittals":
    case "specs":
    case "meetings":
    case "transmittals":
    case "inspections":
    case "safety":
    case "decisions":
    case "selections":
    case "budget":
    case "commitments":
    case "payables":
    case "invoices":
    case "expenses":
    case "reports":
    case "closeout":
    case "closing":
    case "warranty":
    case "cost-inbox":
      return segment
    case "change-orders":
      return "change-orders"
    default:
      return "overview"
  }
}

export function getFinancialLandingUrl(projectId: string) {
  return `/projects/${projectId}/financials/receivables`
}

function visibleBadge(count?: number) {
  return count && count > 0 ? count : undefined
}

function buildFinancialSubs(
  projectId: string,
  section: ProjectSection,
  project?: Project | ProjectNavigationItem,
  reviewBadgeCount?: number,
): ProjectNavSubItem[] {
  const base = `/projects/${projectId}`
  const url = (suffix = "") => `${base}${suffix}`
  const config = project
    ? getProjectFinancialFeatureConfig(
        project as Project,
        "billing_contract" in project ? project.billing_contract : null,
      )
    : null

  return [
    config?.showInbox === false
      ? null
      : {
          title: "Review",
          url: url("/financials/review"),
          isActive: section === "financials-review" || section === "cost-inbox",
          badge: visibleBadge(reviewBadgeCount),
          requiredAny: ["invoice.write", "bill.approve"],
        },
    config?.billingModel === "time_and_materials"
      ? {
          title: "T&M Tickets",
          url: url("/financials/tm-tickets"),
          isActive: section === "financials-tm-tickets",
          requiredAny: ["invoice.write"],
        }
      : null,
    {
      title: "Budget",
      url: url("/financials/budget"),
      isActive: section === "budget" || section === "commitments",
      requiredAny: ["budget.read", "commitment.read"],
    },
    {
      title: "Receivables",
      url: url("/financials/receivables"),
      isActive: section === "receivables" || section === "invoices",
      requiredAny: ["invoice.read", "payment.read", "draw.read"],
    },
    {
      title: "Payables",
      url: url("/financials/payables"),
      isActive: section === "payables",
      requiredAny: ["bill.read", "commitment.read"],
    },
    {
      title: "Lien Waivers",
      url: url("/financials/waivers"),
      isActive: section === "financials-waivers",
      requiredAny: ["bill.read", "commitment.read"],
    },
    {
      title: "Expenses",
      url: url("/expenses"),
      isActive: section === "expenses",
      requiredAny: ["invoice.read", "invoice.write", "bill.read"],
    },
    {
      title: "Change Orders",
      url: url("/change-orders"),
      isActive: section === "change-orders",
      requiredAny: ["change_order.read"],
    },
    {
      title: "Reports",
      url: url("/reports"),
      isActive: section === "reports",
      requiredAny: ["report.read", "budget.read", "invoice.read"],
    },
  ].filter(Boolean) as ProjectNavSubItem[]
}

export function buildProjectNavGroups({
  projectId,
  section,
  project,
  reviewBadgeCount,
  orgTier = "residential",
}: {
  projectId: string
  section: ProjectSection
  project?: Project | ProjectNavigationItem
  reviewBadgeCount?: number
  orgTier?: ProductTier
}): ProjectNavGroup[] {
  const base = `/projects/${projectId}`
  const url = (suffix = "") => `${base}${suffix}`
  const config = project
    ? getProjectFinancialFeatureConfig(
        project as Project,
        "billing_contract" in project ? project.billing_contract : null,
      )
    : null
  const posture = getProjectPosture(project?.property_type, orgTier)
  const moduleOverrides = project?.module_overrides ?? {}

  const planSubs: ProjectNavSubItem[] = [
    {
      title: "Documents",
      moduleKey: "documents",
      url: url("/documents"),
      isActive: section === "documents",
      requiredAny: ["docs.read"],
    },
    {
      title: "Drawings",
      moduleKey: "drawings",
      url: url("/drawings"),
      isActive: section === "drawings",
      requiredAny: ["drawing.read", "docs.read"],
    },
    {
      title: "Specifications",
      moduleKey: "specs",
      url: url("/specs"),
      isActive: section === "specs",
      requiredAny: ["docs.read"],
      postures: ["commercial"],
    },
    {
      title: "Bids",
      moduleKey: "bids",
      url: url("/bids"),
      isActive: section === "bids",
      requiredAny: ["bid.read", "bid.write"],
    },
    {
      title: "Signatures",
      moduleKey: "signatures",
      url: url("/signatures"),
      isActive: section === "signatures",
      requiredAny: ["signature.read", "signature.send"],
    },
  ]
  const buildSubs: ProjectNavSubItem[] = [
    {
      title: "Schedule",
      moduleKey: "schedule",
      url: url("/schedule"),
      isActive: section === "schedule",
      requiredAny: ["schedule.read"],
    },
    {
      title: "Daily Logs",
      moduleKey: "daily_logs",
      url: url("/daily-logs"),
      isActive: section === "daily-logs",
      requiredAny: ["daily_log.read"],
    },
    {
      title: "Photos",
      moduleKey: "photos",
      url: url("/photos"),
      isActive: section === "photos",
      requiredAny: ["docs.read"],
    },
    config?.showTime === false
      ? null
      : {
          title: "Time",
          moduleKey: "time",
          url: url("/time"),
          isActive: section === "time",
          requiredAny: ["time.read", "time.write"],
        },
    {
      title: "Punch",
      moduleKey: "punch",
      url: url("/punch"),
      isActive: section === "punch",
      requiredAny: ["punch.read", "punch.write"],
    },
    {
      title: "RFIs",
      moduleKey: "rfis",
      url: url("/rfis"),
      isActive: section === "rfis",
      requiredAny: ["rfi.read"],
    },
    {
      title: "Submittals",
      moduleKey: "submittals",
      url: url("/submittals"),
      isActive: section === "submittals",
      requiredAny: ["submittal.read"],
    },
    {
      title: "Meeting Minutes",
      moduleKey: "meetings",
      postures: ["commercial"],
      url: url("/meetings"),
      isActive: section === "meetings",
      requiredAny: ["project.read", "meeting.write"],
    },
    {
      title: "Transmittals",
      moduleKey: "transmittals",
      postures: ["commercial"],
      url: url("/transmittals"),
      isActive: section === "transmittals",
      requiredAny: ["project.read", "transmittal.write"],
    },
    {
      title: "Inspections",
      moduleKey: "inspections",
      postures: ["commercial"],
      url: url("/inspections"),
      isActive: section === "inspections",
      requiredAny: ["project.read", "inspection.write"],
    },
    {
      title: "Safety",
      moduleKey: "safety",
      postures: ["commercial"],
      url: url("/safety"),
      isActive: section === "safety",
      requiredAny: ["project.read", "safety.write"],
    },
    {
      title: "Selections",
      moduleKey: "selections",
      postures: ["production"],
      url: url("/selections"),
      isActive: section === "selections",
      requiredAny: ["selections.read", "selections.write"],
    },
    {
      title: "Decisions",
      moduleKey: "decisions",
      url: url("/decisions"),
      isActive: section === "decisions",
      requiredAny: ["decision.read", "decision.write"],
    },
  ].filter(Boolean) as ProjectNavSubItem[]
  const financialSubs = buildFinancialSubs(projectId, section, project, reviewBadgeCount)
  const closeSubs: ProjectNavSubItem[] = [
    {
      title: "Closing",
      moduleKey: "closing",
      postures: ["production"],
      url: url("/closing"),
      isActive: section === "closing",
      requiredAny: ["sales.read", "closing.manage"],
    },
    {
      title: "Closeout",
      moduleKey: "closeout",
      url: url("/closeout"),
      isActive: section === "closeout",
      requiredAny: ["closeout.read", "closeout.write"],
    },
    {
      title: "Warranty",
      moduleKey: "warranty",
      url: url("/warranty"),
      isActive: section === "warranty",
      requiredAny: ["warranty.read", "warranty.write"],
    },
  ]

  const groups: ProjectNavGroup[] = [
    {
      items: [
        {
          title: "Overview",
          url: url(),
          icon: LayoutDashboard,
          isActive: section === "overview",
          requiredAny: ["org.member", "project.read"],
        },
        {
          title: "Plan",
          url: url("/documents"),
          icon: Briefcase,
          isActive: planSubs.some((item) => item.isActive),
          items: planSubs,
        },
        {
          title: "Build",
          url: url("/schedule"),
          icon: Hammer,
          isActive: buildSubs.some((item) => item.isActive) || BUILD_SECTIONS.has(section),
          items: buildSubs,
        },
        {
          title: "Financials",
          url: getFinancialLandingUrl(projectId),
          icon: Wallet,
          isActive: financialSubs.some((item) => item.isActive) || FINANCIAL_SECTIONS.has(section),
          items: financialSubs,
        },
        {
          title: "Close",
          url: url("/closeout"),
          icon: Flag,
          isActive: closeSubs.some((item) => item.isActive),
          items: closeSubs,
        },
      ],
    },
  ]

  const visibleForPosture = <T extends ProjectNavItem | ProjectNavSubItem>(item: T) => {
    const override = item.moduleKey ? moduleOverrides[item.moduleKey] : undefined
    return override ?? (!item.postures || item.postures.includes(posture))
  }

  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter(visibleForPosture)
        .map((item) => ({
          ...item,
          items: item.items?.filter(visibleForPosture),
        }))
        .filter((item) => !item.items || item.items.length > 0),
    }))
    .filter((group) => group.items.length > 0)
}
