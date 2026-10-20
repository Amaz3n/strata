import { allBillingFeatureKeys, BILLING_FEATURE_CATALOG, type BillingFeatureKey } from "@/lib/billing-feature-catalog"
import { BUILDER_PROFILE, isTradeProfile, type BusinessProfile } from "@/lib/business-profile"
import type { ProjectModuleKey } from "@/lib/project-modules"

/**
 * What an organization's workspace includes. The PLAN is the gate (which paid
 * features the org holds, from `entitlements`); the business PROFILE is the
 * shape (a trade company never runs a builder's land, sales or purchasing
 * operation, whatever it pays). Every route guard, nav filter, settings list,
 * mobile catalog and authorization decision asks this module — never
 * `profile.kind` inline. Client-safe: no server imports.
 */
export interface WorkspaceSurface {
  profile: BusinessProfile
  /** Named in every refusal, e.g. "Arc Trade". */
  planName: string
  features: BillingFeatureKey[]
}

export const TRADE_PLAN = { code: "trade", name: "Arc Trade" } as const

/** What the Arc Trade plan includes. Selections and closeout/warranty are a builder's obligations to an owner. */
export const TRADE_PLAN_FEATURES: readonly BillingFeatureKey[] = allBillingFeatureKeys().filter(
  (key) => key !== "selections" && key !== "closeout_warranty",
)

/** The plan a newly provisioned org starts on: a trade company starts on Arc Trade, a builder on what Platform picks. */
export function defaultPlanCode(profile: BusinessProfile) {
  return isTradeProfile(profile) ? TRADE_PLAN.code : null
}

export interface EntitlementRow {
  feature_key: string
  limit_type: string | null
  limit_value: number | string | null
  expires_at: string | null
}

const FEATURE_KEYS = new Set<string>(allBillingFeatureKeys())
const isFeatureKey = (value: string): value is BillingFeatureKey => FEATURE_KEYS.has(value)

/**
 * An org with plan entitlements holds exactly those features. An org without
 * any is on a legacy or hand-provisioned contract: a builder keeps everything
 * it has always had, a trade company gets the Arc Trade plan.
 */
export function resolveWorkspaceSurface({
  profile,
  planName,
  entitlements,
  now,
}: {
  profile: BusinessProfile
  planName: string
  entitlements: EntitlementRow[]
  now: Date
}): WorkspaceSurface {
  const active = entitlements.filter(
    (row) =>
      isFeatureKey(row.feature_key) &&
      Number(row.limit_value ?? 1) > 0 &&
      (!row.expires_at || new Date(row.expires_at).getTime() > now.getTime()),
  )
  const features = active.length
    ? Array.from(new Set(active.map((row) => row.feature_key).filter(isFeatureKey)))
    : isTradeProfile(profile)
      ? [...TRADE_PLAN_FEATURES]
      : allBillingFeatureKeys()
  return { profile, planName, features }
}

export const BUILDER_SURFACE: WorkspaceSurface = {
  profile: BUILDER_PROFILE,
  planName: "Arc",
  features: allBillingFeatureKeys(),
}

export function isTradeSurface(surface: WorkspaceSurface) {
  return isTradeProfile(surface.profile)
}

export function surfaceHasFeature(surface: WorkspaceSurface, feature: BillingFeatureKey) {
  return surface.features.includes(feature)
}

const featureName = (feature: BillingFeatureKey) =>
  BILLING_FEATURE_CATALOG.find((entry) => entry.key === feature)?.name ?? feature

/** Permission domains a paid feature carries. Domains not listed are core to every plan. */
const FEATURE_PERMISSION_DOMAINS: Partial<Record<BillingFeatureKey, readonly string[]>> = {
  selections: ["selections"],
  closeout_warranty: ["warranty"],
}

/** Builder operations a trade company does not run: land, communities, house plans, starts, sales, purchasing. */
const BUILDER_ONLY_PERMISSION_DOMAINS: Record<string, string> = {
  community: "Communities",
  land: "Land",
  land_contract: "Land contracts",
  lot: "Lots",
  plan: "House plans",
  start: "Starts",
  sales: "Sales",
  closing: "Closings",
  lead_intake: "Lead intake",
  agreement_template: "Purchase agreements",
  design_studio: "Design Studio",
  price_book: "Purchasing",
  po: "Purchasing",
  po_completion: "Purchasing",
  po_exception: "Purchasing",
  po_receipt: "Purchasing",
  vpo: "Purchasing",
  purchasing_settings: "Purchasing",
  division: "Divisions",
}

const shapeRefusal = (label: string) => `${label} isn't part of ${TRADE_PLAN.name}.`
const planRefusal = (feature: BillingFeatureKey, surface: WorkspaceSurface) =>
  `${featureName(feature)} isn't included in the ${surface.planName} plan.`

/** Why the workspace refuses a permission outright, whatever role the member holds; null when it does not. */
export function permissionRefusal(surface: WorkspaceSurface, permission: string): string | null {
  const domain = permission.split(".")[0]
  if (isTradeSurface(surface) && domain in BUILDER_ONLY_PERMISSION_DOMAINS) {
    return shapeRefusal(BUILDER_ONLY_PERMISSION_DOMAINS[domain])
  }
  for (const [feature, domains] of Object.entries(FEATURE_PERMISSION_DOMAINS)) {
    if (isFeatureKey(feature) && domains?.includes(domain) && !surfaceHasFeature(surface, feature)) {
      return planRefusal(feature, surface)
    }
  }
  return null
}

/** The member's keys minus the ones this workspace refuses, so menus and pickers agree with the gate. */
export function filterSurfacePermissions(surface: WorkspaceSurface, permissions: string[]) {
  return permissions.filter((permission) => permission === "*" || !permissionRefusal(surface, permission))
}

/** Org roles whose whole job is a builder operation a trade company does not run. */
const BUILDER_ONLY_ROLES = new Set([
  "org_design_studio_coordinator",
  "org_land_manager",
  "org_purchasing_manager",
  "org_sales_agent",
  "org_starts_coordinator",
  "org_warranty_manager",
])

/** Whether the member role picker offers this role in this workspace. */
export function surfaceOffersRole(surface: WorkspaceSurface, roleKey: string) {
  return !isTradeSurface(surface) || !BUILDER_ONLY_ROLES.has(roleKey)
}

interface SurfaceArea {
  path: string
  label: string
  /** Hidden from a trade company whatever its plan. */
  builderOnly?: boolean
  /** Refused when the plan lacks it. */
  feature?: BillingFeatureKey
  /** A controller tool a trade company opens by setting it up; a builder always has it. */
  opensWithPayoutRail?: boolean
}

/** What setup the org has done, for the areas a trade company opens itself. */
export interface SurfaceSetup {
  payoutRailOpen: boolean
}

/** Org desks and settings pages the workspace can refuse. Paths are prefixes. */
export const WORKSPACE_DESKS = {
  bids: { path: "/bids", label: "The bid board", builderOnly: true },
  communities: { path: "/communities", label: "Communities", builderOnly: true },
  // A trade opportunity opens as one workbench; the builder's bids, plans, pricing,
  // proposal and files tabs under it are refused. The bracketed path never matches a URL.
  deal_room: { path: "/pipeline/[dealId]/tabs", label: "The builder deal room", builderOnly: true },
  design_studio: { path: "/design-studio", label: "Design Studio", builderOnly: true, feature: "selections" },
  estimates: { path: "/estimates", label: "Estimates", builderOnly: true },
  plans: { path: "/plans", label: "House plans", builderOnly: true },
  purchasing: { path: "/purchasing", label: "Purchasing", builderOnly: true },
  safety: { path: "/safety", label: "The safety desk", builderOnly: true },
  sales: { path: "/sales", label: "Sales", builderOnly: true },
  starts: { path: "/starts", label: "Starts", builderOnly: true },
  trade_lookahead: { path: "/schedule/trades", label: "The trade look-ahead", builderOnly: true },
  warranty: { path: "/warranty", label: "Warranty", builderOnly: true, feature: "closeout_warranty" },
  settings_divisions: { path: "/settings/divisions", label: "Divisions", builderOnly: true },
  settings_lead_intake: { path: "/settings/lead-intake", label: "Lead intake", builderOnly: true },
  settings_milestone_feeds: { path: "/settings/milestone-feeds", label: "Lender and title feeds", builderOnly: true },
  settings_purchasing: { path: "/settings/purchasing", label: "Purchasing settings", builderOnly: true },
  settings_starts: { path: "/settings/starts", label: "Start settings", builderOnly: true },
  settings_takeoff: { path: "/settings/takeoff", label: "Takeoff settings", builderOnly: true },
  // A trade keeps only its waiver templates here; the page sends it to that section.
  // Controller tools: a trade company gets them once vendor payouts are set up.
  payment_runs: { path: "/payables/payment-runs", label: "Payment runs", builderOnly: true, opensWithPayoutRail: true },
  payment_reconciliation: { path: "/payables/reconciliation", label: "Payment reconciliation", builderOnly: true, opensWithPayoutRail: true },
  settings_templates: { path: "/settings/templates", label: "Templates" },
  settings_warranty: { path: "/settings/warranty", label: "Warranty settings", builderOnly: true, feature: "closeout_warranty" },
} as const satisfies Record<string, SurfaceArea>
export type WorkspaceDesk = keyof typeof WORKSPACE_DESKS
const isWorkspaceDesk = (value: string): value is WorkspaceDesk => Object.hasOwn(WORKSPACE_DESKS, value)
const DESKS = Object.keys(WORKSPACE_DESKS).filter(isWorkspaceDesk)

interface ProjectTabArea extends SurfaceArea {
  /** A project module override switches a builder-only tab back on for one job. */
  moduleKey?: ProjectModuleKey
}

/** Project workbench tabs the workspace can refuse. Paths are relative to /projects/[id]. */
export const WORKSPACE_PROJECT_TABS = {
  bids: { path: "/bids", label: "Bids", builderOnly: true, moduleKey: "bids" },
  selections: { path: "/selections", label: "Selections", builderOnly: true, feature: "selections" },
  released: { path: "/released", label: "Released options", builderOnly: true, feature: "selections" },
  decisions: { path: "/decisions", label: "Decisions", builderOnly: true, moduleKey: "decisions" },
  closing: { path: "/closing", label: "Closing", builderOnly: true },
  closeout: { path: "/closeout", label: "Closeout", builderOnly: true, moduleKey: "closeout" },
  warranty: { path: "/warranty", label: "Warranty", builderOnly: true, moduleKey: "warranty", feature: "closeout_warranty" },
  specs: { path: "/specs", label: "Specifications", builderOnly: true, moduleKey: "specs" },
  transmittals: { path: "/transmittals", label: "Transmittals", builderOnly: true, moduleKey: "transmittals" },
  meetings: { path: "/meetings", label: "Meeting minutes", builderOnly: true, moduleKey: "meetings" },
  budget: { path: "/financials/budget", label: "The budget", builderOnly: true },
  cost_inbox: { path: "/financials/cost-inbox", label: "The cost inbox", builderOnly: true },
  inventory: { path: "/financials/inventory", label: "Inventory", builderOnly: true },
  commitments: { path: "/commitments", label: "Commitments", builderOnly: true },
  cost_plus: { path: "/financials/cost-plus", label: "Cost-plus billing", builderOnly: true },
  trust_center: { path: "/financials/trust-center", label: "The trust center", builderOnly: true },
  proposals: { path: "/proposals", label: "Proposals", builderOnly: true },
  // A trade job opens these one job at a time through a project module override.
  rfis: { path: "/rfis", label: "RFIs", builderOnly: true, moduleKey: "rfis" },
  submittals: { path: "/submittals", label: "Submittals", builderOnly: true, moduleKey: "submittals" },
  permits: { path: "/permits", label: "Permits", builderOnly: true, moduleKey: "permits" },
  inspections: { path: "/inspections", label: "Inspections", builderOnly: true, moduleKey: "inspections" },
  drawings: { path: "/drawings", label: "Drawings", builderOnly: true, moduleKey: "drawings" },
  safety: { path: "/safety", label: "Safety", builderOnly: true, moduleKey: "safety" },
} as const satisfies Record<string, ProjectTabArea>
export type WorkspaceProjectTab = keyof typeof WORKSPACE_PROJECT_TABS
const isWorkspaceProjectTab = (value: string): value is WorkspaceProjectTab => Object.hasOwn(WORKSPACE_PROJECT_TABS, value)
const PROJECT_TABS = Object.keys(WORKSPACE_PROJECT_TABS).filter(isWorkspaceProjectTab)

const PAYOUT_RAIL_CLOSED = "Payment runs and reconciliation open once supplier payouts are set up in Settings → Supplier payments."

/**
 * Why a refused area is refused, so a notice can say what to do about it:
 * `plan` (the subscription lacks the feature), `shape` (a builder operation a
 * trade company does not run) or `setup` (opens once the org finishes setup).
 */
export type SurfaceRefusalKind = "plan" | "shape" | "setup"
export interface SurfaceRefusal {
  kind: SurfaceRefusalKind
  message: string
}

function areaRefusalDetail(
  surface: WorkspaceSurface,
  area: SurfaceArea,
  moduleOverride?: boolean,
  setup?: SurfaceSetup,
): SurfaceRefusal | null {
  if (area.feature && !surfaceHasFeature(surface, area.feature)) return { kind: "plan", message: planRefusal(area.feature, surface) }
  if (area.opensWithPayoutRail && isTradeSurface(surface)) return setup?.payoutRailOpen ? null : { kind: "setup", message: PAYOUT_RAIL_CLOSED }
  if (area.builderOnly && isTradeSurface(surface) && moduleOverride !== true) return { kind: "shape", message: shapeRefusal(area.label) }
  return null
}

const areaRefusal = (...args: Parameters<typeof areaRefusalDetail>) => areaRefusalDetail(...args)?.message ?? null

/** `setup` says what the org has opened; without it an area that opens by setup is refused. */
export function deskRefusal(surface: WorkspaceSurface, desk: WorkspaceDesk, setup?: SurfaceSetup) {
  return areaRefusal(surface, WORKSPACE_DESKS[desk], undefined, setup)
}

export function projectTabModuleKey(tab: WorkspaceProjectTab): ProjectModuleKey | undefined {
  const area: ProjectTabArea = WORKSPACE_PROJECT_TABS[tab]
  return area.moduleKey
}

export function projectTabRefusal(
  surface: WorkspaceSurface,
  tab: WorkspaceProjectTab,
  moduleOverrides: Record<string, boolean> = {},
) {
  const area: ProjectTabArea = WORKSPACE_PROJECT_TABS[tab]
  return areaRefusal(surface, area, area.moduleKey ? moduleOverrides[area.moduleKey] : undefined)
}

const underPath = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
const withoutQuery = (url: string) => url.split(/[?#]/)[0]

function deskForPath(path: string): WorkspaceDesk | null {
  const clean = withoutQuery(path)
  return DESKS.find((desk) => underPath(clean, WORKSPACE_DESKS[desk].path)) ?? null
}

function projectTabForPath(path: string): WorkspaceProjectTab | null {
  const match = /^\/projects\/[^/]+(\/.*)$/.exec(withoutQuery(path))
  if (!match) return null
  return PROJECT_TABS.find((tab) => underPath(match[1], WORKSPACE_PROJECT_TABS[tab].path)) ?? null
}

/** Whether a nav link leads somewhere this workspace serves. Nav filters call this; the routes enforce it. */
export function surfaceAllowsPath(
  surface: WorkspaceSurface,
  path: string,
  moduleOverrides: Record<string, boolean> = {},
  setup?: SurfaceSetup,
) {
  const tab = projectTabForPath(path)
  if (tab) return !projectTabRefusal(surface, tab, moduleOverrides)
  const desk = deskForPath(path)
  return !desk || !deskRefusal(surface, desk, setup)
}

/** Where a refused route sends the member, carrying the reason the home page names. */
export function refusedRouteHref(area: WorkspaceDesk | WorkspaceProjectTab) {
  return `/?unavailable=${encodeURIComponent(area)}`
}

/** The refusal the home page shows for `?unavailable=`; null for anything it does not recognize. */
export function unavailableRefusal(surface: WorkspaceSurface, value: string | undefined): SurfaceRefusal | null {
  if (!value) return null
  if (isWorkspaceDesk(value)) return areaRefusalDetail(surface, WORKSPACE_DESKS[value])
  if (isWorkspaceProjectTab(value)) {
    const area: ProjectTabArea = WORKSPACE_PROJECT_TABS[value]
    return areaRefusalDetail(surface, area)
  }
  return null
}

/** The sentence of that refusal. */
export function unavailableNotice(surface: WorkspaceSurface, value: string | undefined) {
  return unavailableRefusal(surface, value)?.message ?? null
}
