import "server-only"
import { collectBooksRows } from "@/lib/services/books/paging"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { booksDigest } from "@/lib/services/books/hash"

/** History remains economic after reversal; every reversal must mirror its parent. */
export async function verifyBooksReversalHistory(orgId: string) {
  const service = createServiceSupabaseClient()
  const [entries, lines] = await Promise.all([
    collectBooksRows((from,to) => service.from("journal_entries").select("id,status,entry_kind,entry_date,reversal_of_entry_id").eq("org_id",orgId).in("status",["posted","reversed"]).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("journal_lines").select("id,entry_id,account_id,project_id,company_id,debit_cents,credit_cents,dimensions").eq("org_id",orgId).order("id").range(from,to)),
  ])
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const byEntry = new Map<string, typeof lines>()
  for (const line of lines) { const group = byEntry.get(line.entry_id) ?? []; group.push(line); byEntry.set(line.entry_id,group) }
  const children = new Map<string, typeof entries>()
  for (const entry of entries) if (entry.reversal_of_entry_id) { const group = children.get(entry.reversal_of_entry_id) ?? []; group.push(entry); children.set(entry.reversal_of_entry_id,group) }
  const canonical = (entryId: string, reverse = false) => (byEntry.get(entryId) ?? []).map(line => booksDigest({ accountId:line.account_id, projectId:line.project_id, companyId:line.company_id, debitCents:Number(reverse ? line.credit_cents : line.debit_cents), creditCents:Number(reverse ? line.debit_cents : line.credit_cents), dimensions:line.dimensions ?? {} })).sort()
  const differences: Array<{ type: string; entry_id: string; message: string }> = []
  for (const entry of entries) {
    const reversals = children.get(entry.id) ?? []
    if ((entry.status === "reversed" && reversals.length !== 1) || (entry.status === "posted" && reversals.length !== 0)) differences.push({ type:"reversal_chain",entry_id:entry.id,message:"Journal status does not agree with its reversal history" })
    if (entry.entry_kind !== "reversal" && !entry.reversal_of_entry_id) continue
    const original = entry.reversal_of_entry_id ? byId.get(entry.reversal_of_entry_id) : null
    if (!original || original.id === entry.id || entry.entry_kind !== "reversal" || entry.entry_date < original.entry_date || booksDigest(canonical(entry.id)) !== booksDigest(canonical(original.id,true))) differences.push({ type:"reversal_economics",entry_id:entry.id,message:"Reversal must reference and exactly reverse an earlier economic journal" })
  }
  return differences
}
