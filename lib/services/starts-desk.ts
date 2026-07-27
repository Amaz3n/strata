import "server-only"

import { getCommunityReleaseSlots } from "@/lib/services/even-flow"
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
const PACKAGE_PAGE_SIZE = 200

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
}

export interface StartsDesk {
  currentWeek: string
  weeks: DeskWeek[]
  packages: StartPackageListItemDTO[]
  candidates: StartCandidateDTO[]
  counters: DeskCounters
  /** True when more packages exist than the desk loaded — the UI must say so. */
  truncated: boolean
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
  scope: { communityId?: string; divisionId?: string } = {},
): Promise<StartsDesk> {
  const currentWeek = mondayOfIsoWeek(new Date())
  const windowStart = addWeeks(currentWeek, -WEEKS_BACK)
  const permissionResult = await getCurrentUserPermissions()
  const grants = permissionResult.permissions
  const isAdmin = grants.includes("*") || grants.includes("org.admin")
  const canWrite = isAdmin || grants.includes("start.write")
  const canRelease = isAdmin || grants.includes("start.release")

  const [slots, active, released, candidates] = await Promise.all([
    getCommunityReleaseSlots({ ...scope, weeksBack: WEEKS_BACK, weeksAhead: WEEKS_AHEAD }),
    listStartPackages({ ...scope, status: ["open", "ready", "releasing", "attention"], pageSize: PACKAGE_PAGE_SIZE }),
    listStartPackages({ ...scope, status: ["released"], targetWeekFrom: windowStart, pageSize: PACKAGE_PAGE_SIZE }),
    canWrite ? listStartPackageCandidates(scope) : Promise.resolve([]),
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
  const coverageWeeks = new Set(
    Array.from({ length: COVERAGE_WEEKS }, (_, index) => addWeeks(currentWeek, index)),
  )
  const counters: DeskCounters = {
    precon: active.packages.length,
    ready: active.packages.filter((pkg) => pkg.status === "ready").length,
    atRisk: active.packages.filter((pkg) => pkg.risk === "at_risk" || pkg.risk === "late").length,
    failed: active.packages.filter((pkg) => pkg.status === "attention").length,
    slotsAhead: weeks
      .filter((week) => coverageWeeks.has(week.weekStart))
      .reduce((sum, week) => sum + week.targetStarts, 0),
    filledAhead: packages.filter((pkg) => pkg.targetWeek && coverageWeeks.has(pkg.targetWeek)).length,
    soldAtRisk: active.packages.filter((pkg) => pkg.sale.isSold && (pkg.risk === "at_risk" || pkg.risk === "late")).length,
    unpackagedSold: candidates.filter((candidate) => candidate.sale.isSold).length,
  }

  return {
    currentWeek,
    weeks,
    packages,
    candidates,
    counters,
    truncated: active.total > active.packages.length || released.total > released.packages.length,
    canWrite,
    canRelease,
    canSetSlots: isAdmin || grants.includes("start.slots"),
  }
}
