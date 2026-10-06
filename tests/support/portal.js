"use strict"

/**
 * A token portal against an in-memory database.
 *
 * The real credential module hashes and encrypts the link, the real
 * portal-access and external-portal-auth services read it back, and only the
 * request-scoped edges are replaced: the Supabase client, the cookie store and
 * `connection()`. Stubs are installed once per process and delegate to the
 * current database and cookie jar, so modules loaded by an earlier test keep
 * seeing the state of the test that is running.
 */

const { createFakeSupabase } = require("./fake-supabase")
const { stubModule } = require("./modules")

const PORTAL_ORG = "00000000-0000-4000-8000-0000000000a1"
const PORTAL_PROJECT = "00000000-0000-4000-8000-0000000000a2"
const PORTAL_COMPANY = "00000000-0000-4000-8000-0000000000a3"

const state = { supabase: createFakeSupabase(), cookies: new Map() }

if (!process.env.PORTAL_ACCESS_SECRET) {
  process.env.PORTAL_ACCESS_SECRET = "portal-fixture-secret-with-at-least-32-characters"
}

stubModule("next/headers", {
  cookies: async () => ({
    get: (name) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
    set: (nameOrEntry, maybeValue) => {
      const entry = typeof nameOrEntry === "string" ? { name: nameOrEntry, value: maybeValue } : nameOrEntry
      if (entry.value) state.cookies.set(entry.name, entry.value)
      else state.cookies.delete(entry.name)
    },
    delete: (name) => state.cookies.delete(name),
  }),
  headers: async () => new Headers(),
})
stubModule("next/server", { connection: async () => {}, after: () => {} })
stubModule("@/lib/supabase/server", {
  createServiceSupabaseClient: () => state.supabase,
  createServerSupabaseClient: async () => state.supabase,
})

const credentials = require("../../lib/services/portal-credentials.ts")

/**
 * One `portal_access_tokens` row as the database stores it: the link itself is
 * only ever present as its lookup hash and its encrypted copy.
 */
function portalLink(overrides = {}) {
  const token = overrides.token ?? `link-${Math.random().toString(36).slice(2)}`
  const { token: _token, ...columns } = overrides
  const row = {
    id: `token-${token}`,
    org_id: PORTAL_ORG,
    project_id: PORTAL_PROJECT,
    company_id: null,
    contact_id: null,
    name: "Fixture link",
    portal_type: "client",
    purpose: "portal",
    pin_required: false,
    require_account: false,
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    access_count: 0,
    max_access_count: null,
    created_at: "2026-01-01T00:00:00Z",
    ...columns,
    token_hash: credentials.hashPortalToken(token),
    token_encrypted: credentials.encryptPortalToken(token),
  }
  return { token, row }
}

/** Replace the database for the next test; returns the fake client. */
function usePortalDatabase(tables = {}, rpcHandlers = {}) {
  state.supabase = createFakeSupabase(tables, rpcHandlers)
  state.cookies.clear()
  return state.supabase
}

/** The browser has passed the PIN screen for this link. */
function markPinEntered(token) {
  return credentials.markPinVerified(`portal:${token}`)
}

module.exports = {
  PORTAL_ORG,
  PORTAL_PROJECT,
  PORTAL_COMPANY,
  portalLink,
  usePortalDatabase,
  markPinEntered,
}
