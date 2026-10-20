"use strict"

/**
 * Platform-operator actors for the service harness.
 *
 *   const { platformActor, envSuperadmin } = require("./support/platform")
 *   const { getAuditLogs } = freshRequire("lib/services/admin.ts")
 *
 *   const operator = platformActor({ platform: ["platform.support.read"] })
 *   await operator.run(() => getAuditLogs({}))
 *
 * A platform actor is the harness actor (`ACTOR`), signed in, with a
 * `platform_memberships` row granting `platform` keys and, separately, a tenant
 * membership in `ORG` granting `tenant` keys. Everything between the sign-in
 * and the database is real: `requireAnyPlatformPermission()`, the RBAC
 * platform branch, and `isPlatformAdminId()` (env superadmins, switched with
 * `envSuperadmin()`). Only `requireAuth()` — the session cookie — is replaced.
 *
 * Require this module BEFORE `freshRequire`-ing the services under test.
 */

const { createServiceHarness, ORG, ACTOR } = require("./service")
const { freshRequire, stubModule } = require("./modules")

const OPERATOR_EMAIL = "operator@example.test"

stubModule("@/lib/auth/context", {
  ...require("@/lib/auth/context"),
  requireAuth: async () => ({ user: { id: ACTOR, email: OPERATOR_EMAIL }, orgId: ORG }),
})
// Reload the gate so it binds the signed-in operator above.
freshRequire("lib/services/platform-access.ts")

delete process.env.SUPERADMIN_IDS
delete process.env.SUPERADMIN_EMAILS

/** Make the actor an environment-configured superadmin (or not). */
function envSuperadmin(on) {
  if (on) process.env.SUPERADMIN_IDS = ACTOR
  else delete process.env.SUPERADMIN_IDS
}

/** A platform role row, embedded the way PostgREST joins it. */
function platformMembership(permissions, overrides = {}) {
  return {
    user_id: ACTOR,
    status: "active",
    expires_at: null,
    role: { permissions: permissions.map((key) => ({ permission_key: key })) },
    ...overrides,
  }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.platform] Keys the actor's platform role grants (none: no platform membership).
 * @param {string[]} [options.tenant] Keys the actor's tenant role in ORG grants.
 * @param {Record<string, object[]>} [options.tables]
 * @param {string[]} [options.projects] Restrict the tenant membership to these projects.
 */
function platformActor({ platform, tenant = [], tables = {}, projects } = {}) {
  envSuperadmin(false)
  return createServiceHarness({
    permissions: tenant,
    projects,
    tables: {
      ...tables,
      platform_memberships: platform ? [platformMembership(platform)] : [],
    },
  })
}

/** Queries that reached business data, as opposed to the RBAC lookups. */
function dataQueries(service) {
  const access = new Set([
    "permissions",
    "memberships",
    "membership_divisions",
    "membership_permission_overrides",
    "project_members",
    "platform_memberships",
    "authorization_audit_log",
    // The workspace surface (plan entitlements + business profile) bounds every decision.
    "org_settings",
    "entitlements",
    "subscriptions",
  ])
  return service.queries.filter((query) => !access.has(query.table))
}

module.exports = { platformActor, platformMembership, envSuperadmin, dataQueries, OPERATOR_EMAIL }
