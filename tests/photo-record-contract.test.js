const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

const MIGRATION = "supabase/migrations/20260825120000_photo_records.sql"

/** The category list as `lib/media/photo-media.ts` declares it. */
function typescriptCategories() {
  const declaration = /NON_PHOTO_FILE_CATEGORIES\s*=\s*\[([^\]]*)\]/.exec(source("lib/media/photo-media.ts"))
  assert.ok(declaration, "NON_PHOTO_FILE_CATEGORIES must stay a literal array")
  return [...declaration[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
}

/** The same list as the `project_photo_entries` view applies it. */
function sqlCategories() {
  const clause = /f\.category\s+not\s+in\s*\(([^)]*)\)/.exec(source(MIGRATION))
  assert.ok(clause, "the view must exclude business-document categories")
  return [...clause[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
}

test("paperwork is excluded from the photo list, and both halves of the rule agree", () => {
  const inTypescript = typescriptCategories()
  const inSql = sqlCategories()

  assert.ok(inTypescript.length > 0, "the category list must not be empty")
  // Two languages, one rule. The view hides paperwork from the workbench and
  // `isBusinessDocumentCategory` stops the captioning job paying to describe it;
  // if they drift, receipts get captioned or site photos get hidden.
  assert.deepEqual([...inSql].sort(), [...inTypescript].sort())
  assert.ok(inTypescript.includes("financials"), "expense receipts and bill attachments must be excluded")
})

test("the photo record is written for every project image, and filtered only on read", () => {
  const migration = source(MIGRATION)

  // The trigger fires before file_links exists, so it cannot classify — and a
  // record for a file that is recategorised later is what lets it appear without
  // a backfill. Narrowing the trigger to the view's predicate would break both.
  const trigger = migration.slice(migration.indexOf("tg_files_ensure_photo_record"))
  const triggerBody = trigger.slice(0, trigger.indexOf("$$;"))
  assert.doesNotMatch(triggerBody, /category/, "the trigger must not filter on category")
  assert.match(triggerBody, /mime_type not like 'image\/%'/)

  assert.match(migration, /create unique index if not exists photos_org_file_key/)
})

test("the photo timeline sorts on capture time, not upload time", () => {
  const migration = source(MIGRATION)
  assert.match(migration, /alter table public\.photos alter column taken_at set not null/)
  assert.match(migration, /photos_project_taken_at_idx[\s\S]{0,120}taken_at desc/)

  const service = source("lib/services/photos.ts")
  assert.match(service, /\.order\("taken_at", \{ ascending: false \}\)/)
  // A cursor keyed on anything but the sort column skips or repeats rows.
  assert.match(service, /taken_at\.lt\.\$\{cursor\.takenAt\}/)
})
