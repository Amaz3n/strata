"use strict"

/**
 * The mobile API's caller, on top of the service harness.
 *
 *   const service = createServiceHarness({ permissions: [...], tables: {...} })
 *   const context = mobileContext(service)
 *   await service.run(() => createWorkspaceDocument(context, "bids", PROJECT, input))
 *
 * `requireMobileOrg()` (lib/mobile/auth.ts) turns a bearer token into this
 * shape; the mobile modules then authorize against the same RBAC rows the
 * harness seeds. Run every mobile call inside `service.run` so the service
 * client and the org context resolve to the harness.
 */

/** The `MobileOrgContext` for the harness's actor and org. */
function mobileContext(service, { productTier = "residential", isPlatformAdmin = false } = {}) {
  return {
    token: "mobile-token",
    user: { id: service.userId, email: "actor@example.test", user_metadata: {} },
    serviceSupabase: service.client,
    isPlatformAdmin,
    orgId: service.orgId,
    serviceContext: { supabase: service.client, orgId: service.orgId, userId: service.userId, productTier },
  }
}

/**
 * A stand-in for a domain service the mobile adapter delegates to: every call
 * is recorded as `[name, ...args]` in `calls`, and `impl[name]` answers it.
 */
function recordingService(calls, impl) {
  return Object.fromEntries(
    Object.entries(impl).map(([name, answer]) => [
      name,
      async (...args) => {
        calls.push([name, ...args])
        return typeof answer === "function" ? answer(...args) : answer
      },
    ]),
  )
}

/** A refusal from the mobile API with this HTTP status. */
const status = (code) => (error) => error?.status === code

module.exports = { mobileContext, recordingService, status }
