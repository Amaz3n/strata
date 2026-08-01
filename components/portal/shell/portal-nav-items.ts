import type { PortalPermissions } from "@/lib/types"

/**
 * Icon identifiers rather than components. These manifests are built in server
 * layouts and handed to the client nav, and a component reference cannot cross
 * that boundary — only serialisable data can. `portal-nav.tsx` maps each key to
 * its Lucide icon.
 */
export type PortalNavIcon =
  | "home"
  | "rfis"
  | "submittals"
  | "punch"
  | "warranty"
  | "warranty-visits"
  | "contracts"
  | "purchase-orders"
  | "invoices"
  | "daily-logs"
  | "compliance"
  | "prequalification"
  | "documents"
  | "payments"
  | "roadmap"
  | "photos"
  | "approvals"
  | "about"
  | "overview"
  | "drawings"
  | "model"

/**
 * A single portal destination. `segment` is relative to the portal root so the
 * shell can prefix it with the token; the nav resolves active state by path.
 */
export interface PortalNavItem {
  /** Path segment appended to the portal root. Empty string is the root itself. */
  segment: string
  label: string
  /** Shortened label for the mobile bottom bar, where width is scarce. */
  shortLabel?: string
  icon: PortalNavIcon
  /** Count of items awaiting the reader. Renders as a badge; 0 renders nothing. */
  count?: number
  /** Promote into the mobile bottom bar. At most four should set this. */
  primary?: boolean
}

export interface SubPortalNavCounts {
  rfis: number
  submittals: number
  punch: number
  compliance: number
  prequalification: number
  warranty: number
}

/**
 * Sub portal destinations, filtered by what the token may actually reach.
 * Order is deliberate: the things a sub owes the builder come before the
 * things the builder owes the sub.
 */
export function buildSubPortalNav({
  permissions,
  counts,
  showPurchaseOrders,
  showPayments,
}: {
  permissions: PortalPermissions
  counts: SubPortalNavCounts
  showPurchaseOrders: boolean
  showPayments: boolean
}): PortalNavItem[] {
  const items: PortalNavItem[] = [
    { segment: "", label: "Home", icon: "home", primary: true },
  ]

  if (permissions.can_view_rfis !== false) {
    items.push({
      segment: "rfis",
      label: "RFIs",
      icon: "rfis",
      count: counts.rfis,
      primary: true,
    })
  }

  if (permissions.can_view_submittals !== false) {
    items.push({
      segment: "submittals",
      label: "Submittals",
      shortLabel: "Subs",
      icon: "submittals",
      count: counts.submittals,
    })
  }

  if (permissions.can_view_punch_items) {
    items.push({
      segment: "punch",
      label: "Punch list",
      shortLabel: "Punch",
      icon: "punch",
      count: counts.punch,
      primary: true,
    })
  }

  if (counts.warranty > 0) {
    items.push({
      segment: "warranty",
      label: "Warranty visits",
      shortLabel: "Warranty",
      icon: "warranty-visits",
      count: counts.warranty,
    })
  }

  if (permissions.can_view_commitments !== false) {
    items.push({ segment: "commitments", label: "Contracts", icon: "contracts" })
  }

  if (showPurchaseOrders) {
    items.push({ segment: "purchase-orders", label: "Purchase orders", shortLabel: "POs", icon: "purchase-orders" })
  }

  if (permissions.can_view_bills !== false) {
    items.push({ segment: "bills", label: "Invoices", icon: "invoices", primary: true })
  }

  if (permissions.can_submit_daily_logs) {
    items.push({ segment: "daily-logs", label: "Daily logs", shortLabel: "Logs", icon: "daily-logs" })
  }

  items.push({
    segment: "compliance",
    label: "Compliance",
    icon: "compliance",
    count: counts.compliance,
  })

  items.push({
    segment: "prequalification",
    label: "Prequalification",
    shortLabel: "Prequal",
    icon: "prequalification",
    count: counts.prequalification,
  })

  items.push({ segment: "documents", label: "Documents", shortLabel: "Docs", icon: "documents" })

  if (showPayments) {
    items.push({ segment: "payments", label: "Get paid", shortLabel: "Payouts", icon: "payments" })
  }

  return items
}

export interface ClientPortalNavCounts {
  actions: number
}

/**
 * Client/buyer portal destinations. Buyers care about progress and money, in
 * that order, so the roadmap and photo timeline lead.
 */
export function buildClientPortalNav({
  permissions,
  counts,
  hasInvoices,
  has3dModel,
  roadmapLabel,
}: {
  permissions: PortalPermissions
  counts: ClientPortalNavCounts
  hasInvoices: boolean
  /** Only shown when this buyer's plan actually has a published model. */
  has3dModel: boolean
  roadmapLabel?: string | null
}): PortalNavItem[] {
  const items: PortalNavItem[] = [
    { segment: "", label: "Home", icon: "home", primary: true },
    { segment: "roadmap", label: roadmapLabel || "Roadmap", icon: "roadmap", primary: true },
  ]

  if (permissions.can_view_photos !== false) {
    items.push({ segment: "photos", label: "Photos", icon: "photos", primary: true })
  }

  if (permissions.can_view_documents !== false) {
    items.push({ segment: "documents", label: "Documents", shortLabel: "Docs", icon: "documents" })
  }

  if (hasInvoices) {
    items.push({ segment: "invoices", label: "Invoices", icon: "invoices" })
  }

  items.push({
    segment: "actions",
    label: "Approvals",
    icon: "approvals",
    count: counts.actions,
    primary: true,
  })

  if (permissions.can_create_punch_items) {
    items.push({ segment: "punch-list", label: "Punch list", shortLabel: "Punch", icon: "punch" })
  }

  if (permissions.can_view_warranty) {
    items.push({ segment: "warranty", label: "Warranty", icon: "warranty" })
  }

  if (has3dModel) {
    items.push({ segment: "model", label: "3D model", shortLabel: "3D", icon: "model" })
  }

  items.push({ segment: "about", label: "Project team", shortLabel: "Team", icon: "about" })

  return items
}

/** Reviewer portal destinations: design review surfaces only. */
export function buildReviewerPortalNav({
  pendingRfis,
  pendingReviews,
  canViewDocuments,
  canReviewSubmittals,
}: {
  pendingRfis: number
  pendingReviews: number
  canViewDocuments: boolean
  canReviewSubmittals: boolean
}): PortalNavItem[] {
  const items: PortalNavItem[] = [
    { segment: "", label: "Overview", icon: "overview", primary: true },
    { segment: "rfis", label: "RFIs", icon: "rfis", count: pendingRfis, primary: true },
  ]

  if (canReviewSubmittals) {
    items.push({
      segment: "submittals",
      label: "Submittals",
      shortLabel: "Subs",
      icon: "submittals",
      count: pendingReviews,
      primary: true,
    })
  }

  if (canViewDocuments) {
    items.push({ segment: "drawings", label: "Drawings", icon: "drawings", primary: true })
  }

  return items
}
