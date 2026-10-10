const { migrationSql } = require("../support/migration-sql")
const fs=require('node:fs')
async function installGroupRecovery(db){
 const ddl=fs.readFileSync('supabase/migrations/20260718182717_option_catalog_design_studio.sql','utf8')
 for(const table of ['selection_groups','selection_group_categories'])await db.exec(ddl.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))[0])
 // Older lifecycle suites intentionally begin before durable registration.
 // Install missing prerequisites, then exercise their same cases against the
 // extended functions without changing the historical write/replay inputs.
 for(const [signature,migration] of [
  ['register_catalog_publication(uuid,uuid,text,uuid,jsonb)','20261004033000_catalog_publication_intents.sql'],
  ['list_catalog_publication_history(uuid,uuid,uuid,jsonb)','20261004034500_catalog_publication_history.sql'],
  ['list_pending_catalog_publications(uuid,uuid,uuid)','20261004043000_catalog_publication_pending_scopes.sql']
 ])if(!(await db.query('select to_regprocedure($1) present',['public.'+signature])).rows[0].present)await db.exec(migrationSql(migration.replace(/\.sql$/, "")))
 for(const migration of ['20261004065019_catalog_group_publication.sql','20261004072434_catalog_group_publication_recovery.sql'])await db.exec(migrationSql(migration.replace(/\.sql$/, "")))
}
module.exports={installGroupRecovery}
