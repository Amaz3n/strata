import "server-only"

import { getCommunityReleaseSlots, getMissedStarts } from "@/lib/services/even-flow"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import {
  listStartPackageCandidates,
  listStartPackages,
  type StartCandidateDTO,
  type StartPackageListItemDTO,
} from "@/lib/services/starts"
import { addWeeks, mondayOfIsoWeek } from "@/lib/starts/even-flow-math"

/** One week back keeps a just-missed release visible; eleven ahead covers a
 *  permit cycle, which is as far as anyone can honestly plan a start. */
const WEEKS_BACK = 1
const WEEKS_AHEAD = 11
/** The horizon the ribbon reports slot coverage over. */
const COVERAGE_WEEKS = 4
/** How far back the ribbon looks for slots that never got a house. */
const MISSED_WEEKS = 4
/** Packages the lane draws per status band; past this the lane says how many it left out. */
const PACKAGE_PAGE_SIZE = 200
/**
 * The ribbon counts every package in scope even when the lane draws only the
 * first page. Past this many it refuses rather than counting a sample.
 */
const COUNTER_PACKAGE_CAP = 5_000

type PackageFilters = Parameters<typeof listStartPackages>[0]

/**
 * Every package matching `filters`, page by page, starting from the page the
 * lane already loaded. Only called when that page was not the whole set.
 */
async function readEveryPackage(
  filters: PackageFilters,
  first: { packages: StartPackageListItemDTO[]; total: number },
): Promise<StartPackageListItemDTO[]> {
  if (first.total <= first.packages.length) return first.packages
  if (first.total > COUNTER_PACKAGE_CAP) {
    throw new Error(`More than ${COUNTER_PACKAGE_CAP} start packages are in scope; narrow the desk by community.`)
  }
  const pages = Math.ceil(first.total / PACKAGE_PAGE_SIZE)
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) =>
      listStartPackages({ ...filters, page: index + 2, pageSize: PACKAGE_PAGE_SIZE }),
    ),
  )
  return [...first.packages, ...rest.flatMap((page) => page.packages)]
}

export interface DeskWeek {
  weekStart: string
  /** Summed across every community in scope. */
  targetStarts: number
  perCommunity: Array<{ communityId: string; communityName: string; targetStarts: number }>
}

export interface DeskCounters {
  precon: number
  ready: number
  atRisk: number
  failed: number
  slotsAhead: number
  filledAhead: number
  soldAtRisk: number
  unpackagedSold: number
  /** Slots the last few weeks were paced for and never filled. */
  missedStarts: number
  missedStartsWeeks: number
}

export interface StartsDesk {
  currentWeek: string
  weeks: DeskWeek[]
  packages: StartPackageListItemDTO[]
  candidates: StartCandidateDTO[]
  counters: DeskCounters
  /** True when more packages exist than the desk loaded — the UI must say so. */
  truncated: boolean
  /** Every package in scope, whether or not the lane drew it. */
  packageTotal: number
  canWrite: boolean
  canRelease: boolean
  canSetSlots: boolean
}

/**
 * Everything the release lane draws, in one org-scoped read: the week slots,
 * the houses competing for them, the yard of lots still waiting for a slot,
 * and the counters the ribbon filters by.
 */
export async function getStartsDesk(
  { refused = false, ...scope }: { communityId?: string; divisionId?: string; refused?: boolean } = {},
): Promise<StartsDesk> {
  const currentWeek = mondayOfIsoWeek(new Date())
  const windowStart = addWeeks(currentWeek, -WEEKS_BACK)
  const permissionResult = await getCurrentUserPermissions()
  const grants = permissionResult.permissions
  const isAdmin = grants.includes("*") || grants.includes("org.admin")
  const canWrite = isAdmin || grants.includes("start.write")
  const canRelease = isAdmin || grants.includes("start.release")
  const canSetSlots = isAdmin || grants.includes("start.slots")

  // A refused community lens (see resolveProductionDeskScope) draws nothing.
  if (refused) {
    return {
      currentWeek, weeks: [], packages: [], candidates: [], truncated: false, packageTotal: 0,
      counters: { precon: 0, ready: 0, atRisk: 0, failed: 0, slotsAhead: 0, filledAhead: 0, soldAtRisk: 0, unpackagedSold: 0, missedStarts: 0, missedStartsWeeks: MISSED_WEEKS },
      canWrite, canRelease, canSetSlots,
    }
  }

  const activeFilters: PackageFilters = { ...scope, status: ["open", "ready", "releasing", "attention"] }
  const releasedFilters: PackageFilters = { ...scope, status: ["released"], targetWeekFrom: windowStart }
  const [slots, active, released, candidates, missed] = await Promise.all([
    getCommunityReleaseSlots({ ...scope, weeksBack: WEEKS_BACK, weeksAhead: WEEKS_AHEAD }),
    listStartPackages({ ...activeFilters, pageSize: PACKAGE_PAGE_SIZE }),
    listStartPackages({ ...releasedFilters, pageSize: PACKAGE_PAGE_SIZE }),
    canWrite ? listStartPackageCandidates(scope) : Promise.resolve([]),
    getMissedStarts({ ...scope, weeksBack: MISSED_WEEKS }),
  ])

  // No active community means no drumbeat to draw — the lane renders its
  // empty state rather than a row of weeks nobody can start into.
  const weekStarts = slots.length
    ? Array.from({ length: WEEKS_BACK + WEEKS_AHEAD + 1 }, (_, index) => addWeeks(windowStart, index))
    : []
  const weeks: DeskWeek[] = weekStarts.map((weekStart) => {
    const perCommunity = slots.map((community) => ({
      communityId: community.communityId,
      communityName: community.communityName,
      targetStarts: community.weeks.find((week) => week.weekStart === weekStart)?.targetStarts ?? 0,
    }))
    return {
      weekStart,
      targetStarts: perCommunity.reduce((sum, entry) => sum + entry.targetStarts, 0),
      perCommunity,
    }
  })

  const packages = [...active.packages, ...released.packages]
  // The ribbon counts the whole scope, not the page the lane drew: a counter
  // that tops out at the page size reads as "200 at risk" when it is 340.
  const [everyActive, everyReleased] = await Promise.all([
    readEveryPackage(activeFilters, active),
    readEveryPackage(releasedFilters, released),
  ])
  const coverageWeeks = new Set(
    Array.from({ length: COVERAGE_WEEKS }, (_, index) => addWeeks(currentWeek, index)),
  )
  const counters: DeskCounters = {
    precon: active.total,
    ready: everyActive.filter((pkg) => pkg.status === "ready").length,
    atRisk: everyActive.filter((pkg) => pkg.risk === "at_risk" || pkg.risk === "late").length,
    failed: everyActive.filter((pkg) => pkg.status === "attention").length,
    slotsAhead: weeks
      .filter((week) => coverageWeeks.has(week.weekStart))
      .reduce((sum, week) => sum + week.targetStarts, 0),
    filledAhead: [...everyActive, ...everyReleased].filter((pkg) => pkg.targetWeek && coverageWeeks.has(pkg.targetWeek)).length,
    soldAtRisk: everyActive.filter((pkg) => pkg.sale.isSold && (pkg.risk === "at_risk" || pkg.risk === "late")).length,
    unpackagedSold: candidates.filter((candidate) => candidate.sale.isSold).length,
    missedStarts: missed.missed,
    missedStartsWeeks: missed.weeks,
  }

  return {
    currentWeek,
    weeks,
    packages,
    candidates,
    counters,
    truncated: active.total > active.packages.length || released.total > released.packages.length,
    packageTotal: active.total + released.total,
    canWrite,
    canRelease,
    canSetSlots,
  }
}
