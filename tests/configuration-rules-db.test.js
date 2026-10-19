"use strict"

/**
 * The database contract behind option configuration rules
 * (`selection_configuration_rules`): a rule stays inside its org, can never
 * make a configuration impossible — directly, transitively, or through a
 * community override inheriting its base — and the options a rule depends on
 * cannot be archived, disabled, moved or deleted out from under it. Browser
 * roles cannot touch the table at all; the service writes it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember, asRole } = require("./support/pglite")

/** An org with `count` catalog options in one category, plus a second org with one. */
async function catalog(t, count) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const foreign = await seedMember(db)
  const category = await insert(db, "selection_categories", { org_id: orgId, name: "Kitchen" })
  const { rows } = await db.query(
    `insert into selection_options (org_id, category_id, name)
     select $1, $2, 'Option ' || n from generate_series(0, $3 - 1) as n
     returning id`,
    [orgId, category.id, count],
  )
  const options = rows.map((row) => row.id)
  const foreignCategory = await insert(db, "selection_categories", { org_id: foreign.orgId, name: "Kitchen" })
  const foreignOption = await insert(db, "selection_options", {
    org_id: foreign.orgId,
    category_id: foreignCategory.id,
    name: "Foreign option",
  })
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge" })

  const rule = (source, target, kind = "requires") =>
    db.query(
      "insert into selection_configuration_rules (org_id, source_option_id, target_option_id, kind) values ($1, $2, $3, $4)",
      [orgId, source, target, kind],
    )
  const count_ = async () => (await db.query("select count(*)::int as n from selection_configuration_rules")).rows[0].n
  const option = (optionId, set) => db.query(`update selection_options set ${set} where id = $1`, [optionId])
  return { db, orgId, userId, options, foreignOption: foreignOption.id, community: community.id, rule, count: count_, option }
}

test("a rule stays inside its org and can never contradict itself", async (t) => {
  const { options: [a, b], foreignOption, rule } = await catalog(t, 2)

  await rule(a, b)
  await assert.rejects(rule(a, foreignOption), /configuration_rule_target_fk/)
  await assert.rejects(rule(a, a), /cannot require or exclude itself/)
  await assert.rejects(rule(a, b, "excludes"), /impossible configuration/)
  await assert.rejects(rule(a, b), /configuration_rule_pair_unique/)
})

test("browser roles cannot read or write rules; the service role can", async (t) => {
  const { db, userId, orgId, options: [a, b], count } = await catalog(t, 2)
  const insertRule = (tx) =>
    tx.query(
      "insert into selection_configuration_rules (org_id, source_option_id, target_option_id, kind) values ($1, $2, $3, 'requires')",
      [orgId, b, a],
    )

  await assert.rejects(
    asRole(db, { role: "authenticated", userId }, (tx) => tx.query("select * from selection_configuration_rules")),
    /permission denied/,
  )
  await assert.rejects(asRole(db, { role: "authenticated", userId }, insertRule), /permission denied/)
  for (const query of ["select * from selection_configuration_rule_locks", "select validate_selection_configuration_rule()"]) {
    await assert.rejects(asRole(db, { role: "authenticated", userId }, (tx) => tx.query(query)), /permission denied/, query)
  }

  await asRole(db, { role: "service_role" }, insertRule)
  assert.equal(await count(), 1)
})

test("a rule that makes a configuration impossible through a chain of rules is refused", async (t) => {
  const { db, options: o, rule, count } = await catalog(t, 4)

  await rule(o[0], o[1])
  await rule(o[1], o[2])
  await assert.rejects(rule(o[2], o[0], "excludes"), /impossible configuration/)

  // A requirement added later is checked against exclusions that already exist.
  await rule(o[2], o[3], "excludes")
  await assert.rejects(rule(o[0], o[3]), /impossible configuration/)

  // A cycle of requirements is fine; turning one link into an exclusion is not.
  await rule(o[2], o[0])
  await assert.rejects(
    db.query("update selection_configuration_rules set kind = 'excludes' where source_option_id = $1 and target_option_id = $2", [o[1], o[2]]),
    /impossible configuration/,
  )
  assert.equal(await count(), 4, "a refused write leaves no partial rule")
})

test("a change that is valid alone but makes an ancestor impossible is refused", async (t) => {
  const { options: o, rule } = await catalog(t, 3)
  await rule(o[0], o[1])
  await rule(o[0], o[2], "excludes")
  await assert.rejects(rule(o[1], o[2]), /impossible configuration/)
})

test("a community override inherits its base option's rules and scope", async (t) => {
  const { options: o, community, option, rule } = await catalog(t, 6)
  await rule(o[0], o[1])
  await rule(o[1], o[2])
  await option(o[4], `parent_option_id = '${o[0]}', community_id = '${community}'`)

  await assert.rejects(rule(o[4], o[2], "excludes"), /impossible configuration/)
  await assert.rejects(rule(o[4], o[0]), /cannot require or exclude itself/)
  await assert.rejects(rule(o[5], o[4]), /source option community/)
})

test("rules only point at options that are live", async (t) => {
  const { options: o, option, rule } = await catalog(t, 3)
  await option(o[1], "is_archived = true")
  await assert.rejects(rule(o[0], o[1]), /Restore archived options/)
  await option(o[2], "is_available = false")
  await assert.rejects(rule(o[0], o[2]), /Restore unavailable options/)
})

test("an option a rule depends on cannot be archived, disabled, moved or deleted", async (t) => {
  const { db, options: o, community, option, rule } = await catalog(t, 6)
  await rule(o[0], o[1])

  for (const [optionId, set] of [
    [o[0], `community_id = '${community}'`],
    [o[1], `parent_option_id = '${o[5]}'`],
    [o[1], "is_available = false"],
    [o[1], "is_archived = true"],
  ]) {
    await assert.rejects(option(optionId, set), /participates in configuration rules/, set)
  }
  await option(o[0], "name = 'Updated label', community_id = community_id")

  // A base is protected when only its community override carries a rule.
  await option(o[3], `parent_option_id = '${o[2]}', community_id = '${community}'`)
  await rule(o[3], o[4])
  await assert.rejects(option(o[2], "is_archived = true"), /participates in configuration rules/)
  for (const optionId of [o[2], o[3]]) {
    await assert.rejects(db.query("delete from selection_options where id = $1", [optionId]), /participates in configuration rules/)
  }
  await db.query("delete from selection_options where id = $1", [o[5]])
})

test("one option carries at most 200 rules, and a rule at the limit can still be edited", async (t) => {
  const { db, orgId, options: o, rule, count } = await catalog(t, 202)
  await db.query(
    "insert into selection_configuration_rules (org_id, source_option_id, target_option_id, kind) select $1, $2, unnest($3::uuid[]), 'excludes'",
    [orgId, o[0], o.slice(1, 201)],
  )
  await assert.rejects(rule(o[0], o[201], "excludes"), /at most 200/)

  await db.query(
    "update selection_configuration_rules set target_option_id = $1 where source_option_id = $2 and target_option_id = $3",
    [o[201], o[0], o[1]],
  )
  assert.equal(await count(), 200)
})
