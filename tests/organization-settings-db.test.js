"use strict"

/**
 * Organization settings' database contract: `save_organization_settings`
 * writes the org header, the settings document, the audit row and the activity
 * event in one transaction, and `get_org_member_mfa_status` exposes only a
 * yes/no MFA flag for members of the requested org. Both are server-only RPCs
 * the settings and team services call as `service_role`.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An org with a billing email and some settings the invoicing section does not own. */
async function settingsOrg(db) {
  const { orgId, userId } = await seedMember(db)
  await db.query("update orgs set billing_email = 'old@example.com' where id = $1", [orgId])
  await db.query(
    `insert into org_settings (org_id, settings) values ($1, $2)
     on conflict (org_id) do update set settings = excluded.settings`,
    [orgId, { invoice_default_payment_details: "Wire to account 1", unrelated: 42 }],
  )
  const save = (orgPatch, settingsPatch, section = "invoicing") =>
    rpc(db, "save_organization_settings", {
      p_org_id: orgId,
      p_actor_id: userId,
      p_section: section,
      p_org_patch: orgPatch,
      p_settings_patch: settingsPatch,
    })
  return { orgId, userId, save }
}

async function stored(db, orgId) {
  const org = await db.query("select billing_email from orgs where id = $1", [orgId])
  const settings = await db.query("select settings from org_settings where org_id = $1", [orgId])
  const audits = await db.query(
    "select count(*)::int as n from audit_log where org_id = $1 and entity_type = 'org_settings'",
    [orgId],
  )
  return { billingEmail: org.rows[0].billing_email, settings: settings.rows[0].settings, audits: audits.rows[0].n }
}

// ---------------------------------------------------------------------------
// save_organization_settings
// ---------------------------------------------------------------------------

test("a save returns the canonical org and settings, with its audit and event", async (t) => {
  const db = await createDatabase(t)
  const home = await settingsOrg(db)

  const result = await home.save(
    { billing_email: "new@example.com", address: { formatted: "Main St" } },
    { invoice_default_payment_terms_days: 30, invoice_default_payment_details: "" },
  )

  assert.equal(result.org.billing_email, "new@example.com")
  assert.deepEqual(result.org.address, { formatted: "Main St" })
  assert.deepEqual(result.settings, {
    invoice_default_payment_terms_days: 30,
    invoice_default_payment_details: "",
    unrelated: 42,
  })
  const audit = (
    await db.query("select before_data, after_data, source from audit_log where entity_type = 'org_settings'")
  ).rows[0]
  assert.equal(audit.before_data.org.billing_email, "old@example.com")
  assert.deepEqual(audit.after_data, result)
  assert.equal(audit.source, "settings.invoicing")
  const event = (await db.query("select payload from events where event_type = 'settings_updated'")).rows[0]
  assert.deepEqual(event.payload, { section: "invoicing", actor_id: home.userId })
})

test("a cleared setting stays cleared on the next save", async (t) => {
  const db = await createDatabase(t)
  const home = await settingsOrg(db)

  await home.save({}, { invoice_default_payment_details: "" })
  const next = await home.save({}, { invoice_default_payment_terms_days: 15 })

  assert.equal(next.settings.invoice_default_payment_details, "")
})

test("a failing event write rolls back the header, the settings and the audit", async (t) => {
  const db = await createDatabase(t)
  const home = await settingsOrg(db)
  const before = await stored(db, home.orgId)
  await db.exec(`
    alter table events add constraint test_reject_settings check (event_type <> 'settings_updated') not valid
  `)

  await assert.rejects(
    home.save({ billing_email: "partial@example.com" }, { invoice_default_payment_details: "must roll back" }),
    /test_reject_settings/,
  )

  assert.deepEqual(await stored(db, home.orgId), before)
})

test("a save refuses fields its section does not own and a signer from another org", async (t) => {
  const db = await createDatabase(t)
  const home = await settingsOrg(db)
  const stranger = await seedMember(db)
  const before = await stored(db, home.orgId)
  const foreignSigner = {
    estimate_builder_signer_mode: "specific_user",
    estimate_builder_signer_user_id: stranger.userId,
  }

  const refusals = [
    [[{ status: "disabled" }, {}], /Unexpected settings fields/],
    [[{}, { unrelated: "clobber" }], /Unexpected settings fields/],
    [[{ billing_email: "x@example.com" }, {}, "organization"], /Unexpected settings fields/],
    [[{}, foreignSigner, "organization"], /active organization member/],
  ]
  for (const [args, refusal] of refusals) {
    await assert.rejects(home.save(...args), refusal, JSON.stringify(args))
  }
  assert.deepEqual(await stored(db, home.orgId), before)
})

// ---------------------------------------------------------------------------
// get_org_member_mfa_status
// ---------------------------------------------------------------------------

test("MFA status answers only for the org's members, from verified factors", async (t) => {
  const db = await createDatabase(t)
  const { orgId, userId: verified } = await seedMember(db)
  const { userId: pending } = await seedMember(db, { orgId })
  const { userId: noFactor } = await seedMember(db, { orgId })
  const { userId: outsider } = await seedMember(db)
  await insert(db, "auth.mfa_factors", { user_id: verified, status: "verified" })
  await insert(db, "auth.mfa_factors", { user_id: pending, status: "unverified" })
  await insert(db, "auth.mfa_factors", { user_id: outsider, status: "verified" })

  const rows = await rpc(db, "get_org_member_mfa_status", {
    p_org_id: orgId,
    p_user_ids: [verified, pending, noFactor, outsider],
  })

  const byUser = Object.fromEntries(rows.map((row) => [row.user_id, row.enabled]))
  assert.deepEqual(byUser, { [verified]: true, [pending]: false, [noFactor]: false })
})

// ---------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------

test("browser roles cannot call either settings RPC", async (t) => {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)

  for (const caller of [{ role: "anon" }, { role: "authenticated", userId }]) {
    await assert.rejects(
      rpc(
        db,
        "save_organization_settings",
        { p_org_id: orgId, p_actor_id: userId, p_section: "invoicing", p_org_patch: {}, p_settings_patch: {} },
        caller,
      ),
      /permission denied/,
    )
    await assert.rejects(
      rpc(db, "get_org_member_mfa_status", { p_org_id: orgId, p_user_ids: [userId] }, caller),
      /permission denied/,
    )
  }
})
