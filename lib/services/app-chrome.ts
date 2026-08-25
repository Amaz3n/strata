import "server-only"

import { cacheLife } from "next/cache"
import { connection } from "next/server"

import type { ProductTier } from "@/lib/product-tier"
import type { ProjectNavigationItem, User } from "@/lib/types"
import { getOrgAccessState, type OrgAccessState } from "@/lib/services/access"
import { getAmbientDeskContext, type AmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { getCurrentPlatformAccess, type PlatformAccessState } from "@/lib/services/platform-access"
import { getPlatformSessionState, type PlatformSessionState } from "@/lib/services/platform-session"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { orgHasPriceAgreements } from "@/lib/services/price-book"
import { orgHasProductionProjects } from "@/lib/services/production-desk-scope"
import { listProjectNavigationItemsWithClient } from "@/lib/services/projects"
import { getAuthContext } from "@/lib/auth/context"
import { getCurrentUserProfile } from "@/lib/services/users"
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

export interface AppChromeContext {
  user: User | null
  permissions: string[]
  access: OrgAccessState
  platformAccess: PlatformAccessState
  platformSessionState: PlatformSessionState
  productTier: ProductTier
  ambientContext: AmbientDeskContext
  projects: ProjectNavigationItem[]
  hasProductionProjects: boolean
  hasPriceAgreements: boolean
  booksEnabled: boolean
}

const NO_PLATFORM_SESSION: PlatformSessionState = {
  platformContext: { active: false, orgId: null, orgName: null, startedAt: null },
  impersonation: {
    active: false,
    targetUserId: null,
    targetName: null,
    targetEmail: null,
    expiresAt: null,
  },
}

const EMPTY_AMBIENT: AmbientDeskContext = {
  divisions: [],
  divisionId: undefined,
  communities: [],
  communityId: undefined,
  pinnableCommunities: [],
}

/**
 * Everything the authenticated chrome renders from, in one private cache entry.
 *
 * This is what makes the sidebar prefetchable. A route's App Shell can carry
 * session-gated UI, but only through a cached scope — otherwise the nav tree is
 * a dynamic hole that resolves after the click, and the "instant" part of instant
 * navigation is an empty sidebar rectangle.
 *
 * Private caches live in browser memory only. They are never written to the
 * server cache, never shared between users, and never survive a page reload.
 *
 * Everything in here is enforced again server-side on every read and write: a
 * stale permission hides or shows a nav item, it does not grant one. The two
 * entries that gate whole screens are safe for the same reason —
 *   - org access (billing lock): `requireOrgContext` re-checks the lock on every
 *     read and throws, uncached, so a stale entry costs a locked org error states
 *     instead of the clean lock screen for up to one revalidate window.
 *   - platform session (impersonation): every action that starts, ends or
 *     switches it calls `revalidatePath`, which clears the whole client cache.
 * Cookie writes that move any of this must revalidate too — see `refresh()` in
 * switchOrgAction and setDeskScopeAction.
 */
export async function getAppChromeContext(): Promise<AppChromeContext> {
  // This is the single uncached entry point for authenticated app chrome.
  // Supabase checks session expiry with Date.now(), so establish request time
  // before the shared auth helper constructs or uses a live cookie client.
  // Never move this boundary into getAuthContext(): that helper is also called
  // by private project and directory caches, where connection() is forbidden.
  await connection()
  const { user } = await getAuthContext()
  if (!user) return SIGNED_OUT_CHROME
  return loadAppChromeContext()
}

const SIGNED_OUT_CHROME: AppChromeContext = {
  user: null,
  permissions: [],
  access: { status: "unknown", locked: false },
  platformAccess: { canAccessPlatform: false, roles: [], isEnvSuperadmin: false },
  platformSessionState: NO_PLATFORM_SESSION,
  productTier: "residential",
  ambientContext: EMPTY_AMBIENT,
  projects: [],
  hasProductionProjects: false,
  hasPriceAgreements: false,
  booksEnabled: false,
}

async function loadAppChromeContext(): Promise<AppChromeContext> {
  "use cache: private"
  cacheLife("session")

  const [
    user,
    permissionResult,
    access,
    platformAccess,
    platformSessionState,
    context,
    ambientContext,
    hasProductionProjects,
    hasPriceAgreements,
    booksEnabled,
  ] = await Promise.all([
    getCurrentUserProfile().catch(() => null),
    getCurrentUserPermissions().catch(() => ({ permissions: [] as string[] })),
    getOrgAccessState().catch((): OrgAccessState => ({ status: "unknown", locked: false })),
    getCurrentPlatformAccess().catch(
      (): PlatformAccessState => ({ canAccessPlatform: false, roles: [], isEnvSuperadmin: false }),
    ),
    getPlatformSessionState().catch(() => NO_PLATFORM_SESSION),
    requireOrgContext().catch(() => null),
    getAmbientDeskContext().catch(() => EMPTY_AMBIENT),
    orgHasProductionProjects().catch(() => false),
    orgHasPriceAgreements().catch(() => false),
    isBooksWorkspaceEnabled().catch(() => false),
  ])

  // The switcher's project list used to be a client fetch to /api/projects on
  // mount — a round trip that could not start until hydration finished, and
  // could not be prefetched at all. Loading it here puts it in the App Shell.
  const projects = context
    ? await listProjectNavigationItemsWithClient(context.supabase, context.orgId).catch(() => [])
    : []

  return {
    user,
    permissions: permissionResult.permissions,
    access,
    platformAccess,
    platformSessionState,
    productTier: context?.productTier ?? "residential",
    ambientContext,
    projects,
    hasProductionProjects,
    hasPriceAgreements,
    booksEnabled,
  }
}
