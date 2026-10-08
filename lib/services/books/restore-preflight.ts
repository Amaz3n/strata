import { verifyBooksExportBundle } from "@/lib/services/books/export-contract"
import { booksDigest } from "./hash"

export type BooksRestoreCatalog = {
  columns: { schema?: string; table: string; name: string; notNull: boolean; hasDefault: boolean; generated: boolean }[]
  foreignKeys: { schema?: string; table: string; columns: string[]; targetSchema: string; targetTable: string; targetColumns: string[]; match?: "simple" | "full" }[]
}
export type BooksRestoreDependency = { schema: string; table: string; rows: Record<string, unknown>[] }
type Bundle = Parameters<typeof verifyBooksExportBundle>[0]

/** Offline preflight against the actual target schema; no writes or invented identities. */
export function preflightBooksRestore(bundle: Bundle, catalog: BooksRestoreCatalog, dependencies: BooksRestoreDependency[] = [], generatedEvidence?: Bundle) {
  if (!bundle.manifest) throw new Error("A versioned export manifest is required for restoration")
  // Insertion plans omit generated columns, but accounting verification must
  // still compare their original values. Only an independently verified source
  // archive may supply those omitted values; target rows remain unchanged.
  let integrityBundle = bundle
  if (generatedEvidence) {
    if (!verifyBooksExportBundle(generatedEvidence).valid || generatedEvidence.manifest?.orgId !== bundle.manifest.orgId) throw new Error("Generated recovery evidence requires the verified original archive")
    const tables = structuredClone(bundle.tables)
    for (const column of catalog.columns) {
      if (!column.generated || (column.schema ?? "public") !== "public") continue
      for (const row of tables[column.table] ?? []) if (!(column.name in row)) {
        const originals = (generatedEvidence.tables[column.table] ?? []).filter(original => original.id === row.id && original.org_id === row.org_id)
        if (originals.length !== 1) throw new Error("Missing original generated recovery evidence")
        // A generated column introduced after the archive has no historical
        // value to compare; the target must compute it during restoration.
        if (column.name in originals[0]) row[column.name] = originals[0][column.name]
      }
    }
    integrityBundle = {...bundle,tables,manifest:{...bundle.manifest,tables:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,{rows:rows.length,checksum:booksDigest(rows)}]))}}
  }
  const verification = verifyBooksExportBundle(integrityBundle)
  if (!verification.valid) throw new Error("Recovery archive failed integrity verification")
  const blockers: { table: string; rowId: string; column: string; reason: string }[] = []
  const externalDependencies: { table: string; rowId: string; columns: string[]; targetSchema: string; targetTable: string; targetColumns: string[]; values: unknown[] }[] = []
  const indexes = new Map<string, Set<string>>()
  const columns = new Map<string, BooksRestoreCatalog["columns"]>()
  const records = new Map(Object.entries(bundle.tables).map(([table, rows]) => [`public.${table}`, rows]))
  for (const dependency of dependencies) {
    const key = `${dependency.schema}.${dependency.table}`
    if (records.has(key)) throw new Error("Restore dependencies cannot shadow archived tables")
    records.set(key, dependency.rows)
  }
  for (const column of catalog.columns) { const key = `${column.schema ?? "public"}.${column.table}`, list = columns.get(key) ?? []; list.push(column); columns.set(key, list) }
  for (const [qualifiedTable, rows] of records) {
    const table = qualifiedTable.startsWith("public.") ? qualifiedTable.slice(7) : qualifiedTable
    const target = columns.get(qualifiedTable)
    if (!target?.length) throw new Error(`Recovery target has no catalog evidence for ${table}`)
    const known = new Set(target.map(column => column.name))
    for (const record of rows) {
      for (const name of Object.keys(record)) if (!known.has(name)) blockers.push({ table, rowId: String(record.id), column: name, reason: "Column is absent from the target schema" })
      for (const column of target) {
        if (column.generated && column.name in record) blockers.push({ table, rowId: String(record.id), column: column.name, reason: "Generated columns require explicit target-schema restoration handling" })
        if (column.notNull && (record[column.name] === null || (!(column.name in record) && !column.hasDefault && !column.generated))) blockers.push({ table, rowId: String(record.id), column: column.name, reason: "Required value is missing; review redactions or dependency mappings" })
      }
    }
  }
  for (const fk of catalog.foreignKeys) {
    if (!fk.columns.length || fk.columns.length !== fk.targetColumns.length) throw new Error("Invalid restore foreign-key catalog evidence")
    const rows = records.get(`${fk.schema ?? "public"}.${fk.table}`)
    if (!rows) continue
    const target = records.get(`${fk.targetSchema}.${fk.targetTable}`)
    const key = `${fk.targetSchema}.${fk.targetTable}:${JSON.stringify(fk.targetColumns)}`
    if (target && !indexes.has(key)) indexes.set(key, new Set(target.map(record => JSON.stringify(fk.targetColumns.map(column => record[column])))))
    for (const record of rows) {
      const values = fk.columns.map(column => record[column])
      const nullCount = values.filter(value => value === null || value === undefined).length
      if (fk.match === "full" && nullCount && nullCount !== values.length) {
        blockers.push({ table: fk.table, rowId: String(record.id), column: fk.columns.join(","), reason: "MATCH FULL relationship has a partially missing key" })
        continue
      }
      // PostgreSQL MATCH SIMPLE exempts a tuple with any NULL component.
      if (nullCount) continue
      if (!target) externalDependencies.push({ table: fk.table, rowId: String(record.id), columns: fk.columns, targetSchema: fk.targetSchema, targetTable: fk.targetTable, targetColumns: fk.targetColumns, values })
      else if (!indexes.get(key)!.has(JSON.stringify(values))) blockers.push({ table: fk.table, rowId: String(record.id), column: fk.columns.join(","), reason: `Missing restored relationship to ${fk.targetSchema}.${fk.targetTable}` })
    }
  }
  const order = (left: { table: string; rowId: string }, right: { table: string; rowId: string }) => left.table < right.table ? -1 : left.table > right.table ? 1 : left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0
  // Taxpayer IDs never enter an ordinary archive: each one is restored by the
  // separate privileged Vault recovery (or a new W-9). Named here, not blocking.
  const secretRecovery = [
    ...(bundle.tables.companies ?? []).filter((record) => record.tax_id_last4).map((record) => ({ table: "companies", rowId: String(record.id), reason: "Vendor taxpayer ID is kept in Vault: recover it with the privileged Vault restore or collect a new W-9" })),
    ...(bundle.tables.books_legal_entities ?? []).filter((record) => record.payer_tin_last4).map((record) => ({ table: "books_legal_entities", rowId: String(record.id), reason: "The company's own taxpayer ID is kept in Vault: recover it with the privileged Vault restore or enter it again before filing" })),
  ]
  blockers.sort(order); externalDependencies.sort(order); secretRecovery.sort(order)
  return { schemaVersion: bundle.manifest.schemaVersion, orgId: bundle.manifest.orgId, readyForRestoreAttempt: !blockers.length && !externalDependencies.length, blockers, externalDependencies, secretRecovery }
}
