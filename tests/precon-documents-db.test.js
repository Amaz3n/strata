"use strict"

/**
 * The database side of a deal's documents and its handoff:
 *
 * - `start_prospect_project` — signing is the handoff. Only the current,
 *   executed construction agreement starts a job; it carries the signed
 *   commercial terms into one billing contract, moves the deal's records onto
 *   the project, and does it all in one transaction, idempotently.
 * - `issue_estimate_review_link` — every copy or resend is its own link; only
 *   an explicit replacement revokes; a first issue freezes the draft and is
 *   bound to the brief revision the price was checked against.
 * - `save_estimate_draft` — only the current, unpublished draft of an open deal
 *   can be edited, and never into a different kind of document.
 *
 * All three are service-role only, as are the retired formal-handoff RPCs.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, asRole } = require("./support/pglite")

/** An org whose deal "Kitchen" is in pricing. */
async function pipeline(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const deal = (name = "Kitchen", status = "pricing") => insert(db, "prospects", { org_id: orgId, name, status })
  const lead = await deal()

  /** A deal document; an executed construction agreement unless told otherwise. */
  const document = (prospect = lead, { status = "executed", purpose = "construction_agreement", precon = {}, ...columns } = {}) =>
    insert(db, "estimates", {
      org_id: orgId,
      prospect_id: prospect.id,
      title: "Kitchen",
      status,
      total_cents: 100000,
      subtotal_cents: 90000,
      executed_at: status === "executed" ? new Date().toISOString() : null,
      metadata: {
        precon: { purpose, billing_model: "fixed_price", retainage_percent: 5, ...precon },
        accepted_options: { ids: ["option"], accepted_total_cents: 125000 },
      },
      ...columns,
    })

  const start = (prospect = lead, { expectedProject = null, agreement = null, orgId: tenant = orgId } = {}) =>
    rpc(db, "start_prospect_project", {
      p_org_id: tenant,
      p_prospect_id: prospect.id,
      p_actor_id: userId,
      p_expected_project_id: expectedProject,
      p_property_type: "residential",
      p_expected_agreement_id: agreement,
    })

  const issue = async (estimate, token, revoke = false) => {
    const { rows } = await db.query("select updated_at from estimates where id = $1", [estimate.id])
    return rpc(db, "issue_estimate_review_link", {
      p_org_id: orgId,
      p_estimate_id: estimate.id,
      p_token_hash: token,
      p_expected_updated_at: rows[0].updated_at,
      p_revoke_existing: revoke,
    })
  }

  const saveDraft = async (estimate, purpose = "construction_agreement") => {
    const { rows } = await db.query("select updated_at from estimates where id = $1", [estimate.id])
    return rpc(db, "save_estimate_draft", {
      p_org_id: orgId,
      p_estimate_id: estimate.id,
      p_expected_updated_at: rows[0].updated_at,
      p_document: { metadata: { precon: { purpose } } },
      p_items: [],
    })
  }

  const one = async (sql, params) => (await db.query(sql, params)).rows[0]
  const count = async (table) => (await one(`select count(*)::int as n from ${table}`)).n
  return { db, orgId, userId, lead, deal, document, start, issue, saveDraft, one, count }
}

test("only the current, executed construction agreement starts a job", async (t) => {
  const { db, deal, document, start, count } = await pipeline(t)

  for (const [status, purpose] of [
    ["approved", "budget"],
    ["executed", "preconstruction_agreement"],
    ["client_signed", "construction_agreement"],
    ["draft", "construction_agreement"],
  ]) {
    const lead = await deal(`${status} ${purpose}`)
    await document(lead, { status, purpose })
    await assert.rejects(start(lead), /Execute the current construction agreement/, `${status} ${purpose}`)
  }

  const unsigned = await deal("No agreement")
  await assert.rejects(start(unsigned), /Execute/)

  const superseded = await deal("Superseded")
  const old = await document(superseded)
  await db.query("update estimates set is_current_version = false where id = $1", [old.id])
  await assert.rejects(start(superseded), /Execute/)

  const changed = await deal("Changed")
  await document(changed)
  await assert.rejects(start(changed, { agreement: old.id }), /agreement changed/)

  assert.equal(await count("projects"), 0)
})

test("every signed billing model becomes one billing contract at the accepted total, idempotently", async (t) => {
  const { deal, document, start, one, count } = await pipeline(t)
  const contractType = { time_and_materials: "time_materials", cost_plus_percent: "cost_plus", cost_plus_fixed_fee: "cost_plus", cost_plus_gmp: "cost_plus", fixed_price: "fixed" }

  for (const model of Object.keys(contractType)) {
    const lead = await deal(model)
    const agreement = await document(lead, {
      precon: { billing_model: model, fixed_fee_cents: 15000, gmp_cents: 200000, payment_terms: "Deposit" },
    })
    const { projectId, alreadyStarted } = await start(lead)
    assert.equal(alreadyStarted, false)

    const contract = await one("select * from contracts where project_id = $1", [projectId])
    assert.equal(Number(contract.total_cents), 125000, model)
    assert.equal(Number(contract.retainage_percent), 5)
    assert.equal(contract.snapshot.estimate_id, agreement.id)
    assert.equal(contract.contract_type, contractType[model])
    assert.equal(contract.fixed_fee_cents === null ? null : Number(contract.fixed_fee_cents), model === "cost_plus_fixed_fee" ? 15000 : null)
    assert.equal(contract.gmp_cents === null ? null : Number(contract.gmp_cents), model === "cost_plus_gmp" ? 200000 : null)
    assert.equal((await one("select billing_model from project_financial_settings where project_id = $1", [projectId])).billing_model, model)
    assert.equal((await one("select status from estimates where id = $1", [agreement.id])).status, "executed")

    assert.equal((await start(lead, { expectedProject: projectId })).alreadyStarted, true)
  }
  assert.equal(await count("contracts"), 5)
  assert.equal(await count("budgets"), 0, "a budget is drafted by the app, not the conversion")
  assert.equal((await one("select count(*)::int as n from events where event_type = 'prospect_project_moved'")).n, 5)
})

test("an existing precon project carries the deal's records forward", async (t) => {
  const { db, orgId, lead, document, start, one, count } = await pipeline(t)
  const job = await insert(db, "projects", { org_id: orgId, prospect_id: lead.id, name: "Old name", phase: "precon", status: "planning" })
  const draft = await insert(db, "estimates", { org_id: orgId, prospect_id: lead.id, title: "Early cost plan", status: "draft" })
  await document()
  await insert(db, "files", {
    org_id: orgId,
    prospect_id: lead.id,
    file_name: "plans.pdf",
    storage_path: `${orgId}/plans.pdf`,
    folder_path: `/prospects/${lead.id}/plans`,
  })
  await insert(db, "prospect_contacts", { org_id: orgId, prospect_id: lead.id, full_name: "Client", email: "client@example.test", is_primary: true })
  await insert(db, "bid_packages", { org_id: orgId, prospect_id: lead.id, title: "Framing" })

  assert.equal((await start(lead, { expectedProject: job.id })).projectId, job.id)

  assert.equal(await count("projects"), 1)
  assert.deepEqual(await one("select phase, name from projects"), { phase: "delivery", name: "Kitchen" })
  assert.ok((await one("select client_id from projects")).client_id, "the primary contact becomes the client")
  assert.deepEqual(await one("select project_id, prospect_id from bid_packages"), { project_id: job.id, prospect_id: null })
  assert.deepEqual(await one("select status, project_id from estimates where id = $1", [draft.id]), { status: "draft", project_id: job.id })
  assert.deepEqual(await one("select project_id, folder_path from files"), { project_id: job.id, folder_path: `/projects/${job.id}/plans` })
})

test("open start conditions stay open when the job starts; starting never grants them", async (t) => {
  const { db, orgId, userId, lead, document, start, one } = await pipeline(t)
  await document()
  await insert(db, "precon_decisions", {
    org_id: orgId,
    prospect_id: lead.id,
    title: "Permit condition",
    kind: "readiness",
    blocks_start: true,
    owner_user_id: userId,
    created_by: userId,
    updated_by: userId,
  })
  await start()
  assert.deepEqual(await one("select status, blocks_start from precon_decisions"), { status: "open", blocks_start: true })
})

test("a start against the wrong org, a moved project or a lost deal changes nothing", async (t) => {
  const { db, orgId, lead, document, start, count } = await pipeline(t)
  await document()
  const stranger = await seedMember(db)
  await assert.rejects(start(lead, { orgId: stranger.orgId }), /Prospect not found/)

  const job = await insert(db, "projects", { org_id: orgId, prospect_id: lead.id, name: "Kitchen", phase: "precon" })
  await assert.rejects(start(lead), /linked project changed/)

  await db.query("update prospects set status = 'lost', lost_at = now() where id = $1", [lead.id])
  await assert.rejects(start(lead, { expectedProject: job.id }), /Reopen/)
  assert.equal(await count("contracts"), 0)
})

test("a blank setup contract is superseded; a configured one stops the start and rolls it back", async (t) => {
  const { db, orgId, deal, document, start, one, count } = await pipeline(t)

  for (const placeholder of [true, false]) {
    const lead = await deal(placeholder ? "Placeholder" : "Configured")
    const job = await insert(db, "projects", { org_id: orgId, prospect_id: lead.id, name: "Old name", phase: "precon", status: "planning" })
    await insert(db, "contracts", {
      org_id: orgId,
      project_id: job.id,
      title: "Setup",
      status: "active",
      total_cents: placeholder ? 0 : 70000,
      snapshot: { billing_setup_source: "project_settings" },
    })
    await document(lead)

    if (placeholder) {
      await start(lead, { expectedProject: job.id })
      assert.equal((await one("select count(*)::int as n from contracts where project_id = $1 and status = 'superseded'", [job.id])).n, 1)
      assert.equal((await one("select name from projects where id = $1", [job.id])).name, "Placeholder")
    } else {
      await assert.rejects(start(lead, { expectedProject: job.id }), /different billing contract/)
      assert.equal((await one("select phase from projects where id = $1", [job.id])).phase, "precon")
      assert.equal((await one("select status from prospects where id = $1", [lead.id])).status, "pricing")
    }
  }
  assert.equal(await count("contracts"), 3)
})

test("a failure late in the start rolls back the contract, the project and the deal together", async (t) => {
  const { db, document, start, one, count } = await pipeline(t)
  await document()
  await db.exec(`
    create function fail_start_event() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
    create trigger fail_start before insert on events for each row execute function fail_start_event();
  `)
  await assert.rejects(start(), /injected failure/)
  assert.equal(await count("contracts"), 0)
  assert.equal(await count("projects"), 0)
  assert.equal((await one("select status from prospects")).status, "pricing")
})

test("copied and resent links stay valid; an explicit replacement revokes every one", async (t) => {
  const { db, document, issue, one, count } = await pipeline(t)
  const draft = await document(undefined, { status: "draft", token_hash: "legacy" })

  await issue(draft, "one")
  await issue(draft, "two")
  assert.equal(await count("estimate_review_links"), 2)
  assert.deepEqual(await one("select token_hash, status from estimates"), { token_hash: "legacy", status: "sent" })

  await issue(draft, "replacement", true)
  assert.deepEqual((await db.query("select token_hash from estimate_review_links")).rows, [{ token_hash: "replacement" }])
  assert.equal((await one("select token_hash from estimates")).token_hash, null)

  await db.query("update estimates set status = 'client_signed', client_signed_at = now()")
  await assert.rejects(issue(draft, "signed"), /unsigned/)
})

test("a first issue is checked against the brief revision the price was built on, and never once delivered", async (t) => {
  const { db, orgId, lead, document, issue, count } = await pipeline(t)
  const draft = await document(undefined, { status: "draft", precon: { brief_version: 1 } })
  await insert(db, "precon_workspaces", { org_id: orgId, prospect_id: lead.id, version: 3, brief: { pricing_revision: 2 } })

  await assert.rejects(issue(draft, "stale"), /pricing basis changed/)
  assert.equal(await count("estimate_review_links"), 0)

  await db.query("update estimates set metadata = jsonb_set(metadata, '{precon,brief_version}', '2')")
  await issue(draft, "current")

  await insert(db, "projects", { org_id: orgId, prospect_id: lead.id, name: "Kitchen", phase: "delivery", status: "active" })
  await assert.rejects(issue(draft, "delivered"), /in delivery/)
})

test("only the current unpublished draft of an open deal can be edited, and never into another kind", async (t) => {
  const { db, orgId, lead, deal, document, issue, saveDraft } = await pipeline(t)

  const draft = await document(undefined, { status: "draft" })
  await assert.rejects(saveDraft(draft, "budget"), /separate document/)

  await db.query("update prospects set status = 'lost', lost_at = now() where id = $1", [lead.id])
  await assert.rejects(saveDraft(draft), /Reopen/)

  const published = await document(await deal("Published"), { status: "draft" })
  await issue(published, "published")
  await assert.rejects(saveDraft(published), /unpublished draft/)

  const older = await deal("Older")
  const first = await document(older, { status: "draft" })
  await insert(db, "estimates", {
    org_id: orgId,
    prospect_id: older.id,
    title: "Kitchen",
    status: "draft",
    created_at: new Date(Date.now() + 86_400_000).toISOString(),
    metadata: { precon: { purpose: "construction_agreement" } },
  })
  await assert.rejects(saveDraft(first), /newer document/)
})

test("browser roles cannot issue links, convert deals or run the retired handoff", async (t) => {
  const { db, userId, document } = await pipeline(t)
  const draft = await document(undefined, { status: "draft" })

  for (const role of ["anon", "authenticated"]) {
    const caller = { role, userId: role === "anon" ? null : userId }
    await assert.rejects(
      asRole(db, caller, (tx) => tx.query("select public.issue_estimate_review_link($1, $2, 'denied', now(), false)", [draft.org_id, draft.id])),
      /permission denied/,
      role,
    )
  }

  const { rows } = await db.query(`
    select
      has_function_privilege('authenticated', 'public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type,uuid)', 'execute') as start,
      has_function_privilege('anon', 'public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type,uuid)', 'execute') as anon_start,
      has_function_privilege('authenticated', 'public.save_estimate_draft(uuid,uuid,timestamptz,jsonb,jsonb)', 'execute') as save,
      has_function_privilege('authenticated', 'public.convert_executed_prospect_handoff(uuid,uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb)', 'execute') as convert,
      has_function_privilege('anon', 'public.transition_precon_handoff(uuid,uuid,uuid,text,jsonb)', 'execute') as transition
  `)
  assert.deepEqual(rows[0], { start: false, anon_start: false, save: false, convert: false, transition: false })
})
