import { z } from "zod"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { allowed } from "@/lib/mobile/workspace"
import { field, section, type Action, type Section, type Field } from "@/lib/mobile/workspace-detail"
import { getBooksWorkspace } from "@/lib/services/books/workspace"

export async function loadBooksRows(moduleId: string, orgId: string) {
  if (moduleId === "period-close") {
    const workspace = await getBooksWorkspace(orgId, "close")
    return workspace.periods.map(period => ({ ...period, title: `${period.period_start} – ${period.period_end}` }))
  }
  if (moduleId === "assets" || moduleId === "loans") {
    const registers = await (await import("@/lib/services/books/registers")).getBooksRegisters(orgId)
    return moduleId === "assets" ? registers.assets : registers.debts
  }
  const workspace = await getBooksWorkspace(orgId, moduleId === "chart" ? "chart" : "banking")
  if (moduleId === "chart") return workspace.accounts.map(account => ({ ...account, title: `${account.code} · ${account.name}` }))
  if (moduleId === "banking") return workspace.bankAccounts
  if (moduleId === "bank-transactions") return workspace.bankTransactions.map(transaction => ({ ...transaction,
    status: transaction.matches.filter(match => match.status === "confirmed").reduce((sum, match) => sum + Number(match.matched_amount_cents ?? 0), 0) >= transaction.amount_cents ? "matched" : transaction.matches.some(match => match.status === "confirmed") ? "partially_matched" : "unmatched" }))
  if (moduleId === "bank-reconciliations") return workspace.bankReconciliations.map(record => ({ ...record,
    title: `${workspace.bankAccounts.find(account => account.id === record.bank_account_id)?.name ?? "Statement"} · ${record.statement_end}` }))
  return []
}

function choices(key: string, label: string, rows: { id: string; name: string; code?: string }[], value?: string): Field {
  return { ...field(key, label, "choice", true), value, options: rows.map(row => row.id), option_labels: Object.fromEntries(rows.map(row => [row.id, row.code ? `${row.code} · ${row.name}` : row.name])) }
}

export async function loadBooksDetail(context: MobileOrgContext, moduleId: string, row: Record<string, unknown>) {
  const sections: Section[] = [], actions: Action[] = []
  const orgId = context.orgId, id = String(row.id)
  if (moduleId === "period-close") {
    const workspace = await getBooksWorkspace(orgId, "close")
    const checks = workspace.closeItems.filter(item => item.period_id === id)
    sections.push(section("close-checks", "Close Checklist", checks, ["label"], [field("category", "Category"), field("status", "Result"), field("blocking", "Blocks close"), field("issue_count", "Issues", "number"), field("updated_at", "Last checked", "date")]))
    if (["open", "reopened"].includes(String(row.status)) && await allowed(context, "books.close")) {
      actions.push({ id: "run-close-checks", title: "Run Close Checks", fields: [] })
      if (checks.length && !checks.some(item => item.blocking && item.status !== "passed")) actions.push({ id: "close-period", title: "Close Accounting Period", fields: [] })
    }
    if (row.status === "closed" && await allowed(context, "books.reopen")) actions.push({ id: "reopen-period", title: "Reopen Accounting Period", fields: [field("reason", "Reason (at least 10 characters)", "multiline", true)] })
  }
  if (moduleId === "chart" && !row.is_system && await allowed(context, "books.manage")) {
    actions.push({ id: "edit-account", title: "Edit Account", fields: [
      { ...field("name", "Name", "text", true), value: String(row.name) },
      { ...field("description", "Description", "multiline"), value: String(row.description ?? "") },
    ] })
    actions.push({ id: row.active ? "deactivate-account" : "activate-account", title: row.active ? "Deactivate Account" : "Activate Account", fields: [] })
  }
  if (moduleId === "banking" || moduleId === "bank-transactions") {
    const workspace = await getBooksWorkspace(orgId, "banking")
    const bank = workspace.bankAccounts.find(account => account.id === (moduleId === "banking" ? id : row.bank_account_id))
    if (moduleId === "banking") {
      const ledgerAccount = workspace.accounts.find(account => account.id === bank?.gl_account_id)
      if (ledgerAccount) sections.push(section("mapped-account", "Ledger Account", [ledgerAccount], ["name"], [field("code", "Code")]))
      sections.push(section("transactions", "Recent Transactions", workspace.bankTransactions.filter(transaction => transaction.bank_account_id === id), ["merchant_name", "description"], [field("transaction_date", "Date", "date"), field("amount_cents", "Amount", "money"), field("direction", "Direction")]))
      if (workspace.bankTransactionsTruncated) sections.push(section("limit", "History", [{ id: "limit", title: "Recent activity", description: "This view includes the latest 250 organization transactions. Older transactions remain in statement reconciliation evidence." }], ["title"], [field("description", "Coverage", "multiline")]))
      if (await allowed(context, "books.reconcile")) actions.push({ id: "start-reconciliation", title: "Start Reconciliation", fields: [
        field("statement_start", "Statement start", "date", true), field("statement_end", "Statement end", "date", true),
        field("beginning_balance", "Beginning balance (currency units)", "number", true), field("ending_balance", "Ending balance (currency units)", "number", true),
      ] })
      if (await allowed(context, "books.reconcile")) {
        const subtypes = bank?.account_type === "credit" ? ["credit_card"] : bank?.account_type === "loan" ? ["current_debt", "long_term_debt"] : ["cash", "undeposited_funds", "other_asset"]
        const accounts = workspace.accounts.filter(account => account.active && subtypes.includes(account.subtype))
        if (accounts.length) actions.push({ id: "map-account", title: "Map Ledger Account", fields: [choices("account_id", "Ledger account", accounts, bank?.gl_account_id ?? undefined)] })
      }
    } else if (bank?.gl_account_id && workspace.unmatchedTransactions.some(transaction => transaction.id === id) && await allowed(context, "books.reconcile")) {
      const accounts = workspace.accounts.filter(account => account.active && account.id !== bank.gl_account_id)
      if (accounts.length) {
        const coding = await (await import("@/lib/services/books/bank-rules")).getBankCostCodingOptions()
        const optionalChoice = (key: string, label: string, rows: { id: string; name: string; code?: string }[]) => ({ ...choices(key, label, [{ id: "", name: "None" }, ...rows]), required: false })
        actions.push({ id: "categorize", title: "Categorize and Post", fields: [choices("account_id", "Ledger account", accounts), optionalChoice("project_id", "Project (required for direct job costs)", coding.projects), optionalChoice("cost_code_id", "Cost code", coding.costCodes), field("memo", "Memo", "multiline")] })
      }
    }
  }
  if (moduleId === "bank-reconciliations") {
    const proof = await (await import("@/lib/services/books/bank-reconciliation")).getBankReconciliationDetail(id, orgId)
    sections.push(section("proof", "Statement Proof", [{ ...proof, title: "Reconciliation" }], ["title"], [field("cleared_balance_cents", "Cleared balance", "money"), field("difference_cents", "Statement difference", "money"), field("book_balance_cents", "Book balance", "money"), field("outstanding_balance_cents", "Outstanding balance", "money"), field("book_difference_cents", "Book difference", "money")]))
    sections.push(section("items", "Statement Transactions", proof.items.map(item => ({ ...item, id: item.transactionId })), ["description", "counterparty"], [field("transaction_date", "Date", "date"), field("direction", "Direction"), field("amount_cents", "Amount", "money"), field("matched_cents", "Matched", "money"), field("status", "Status")]))
    if (proof.status !== "closed" && proof.differenceCents === 0 && proof.bookDifferenceCents === 0 && !proof.truncated && !proof.items.some(item => item.status === "outstanding") && await allowed(context, "books.reconcile")) actions.push({ id: "close-reconciliation", title: "Close Reconciliation", fields: [] })
    if (proof.status === "closed" && await allowed(context, "books.reopen")) actions.push({ id: "reopen-reconciliation", title: "Reopen Reconciliation", fields: [field("reason", "Reason (at least 10 characters)", "multiline", true)] })
  }
  if (moduleId === "assets" || moduleId === "loans") sections.push(section("events", "Recent Register Events", Array.isArray(row.events) ? row.events : [], ["event_type"], [field("event_date", "Date", "date"), field("principal_cents", "Principal", "money"), field("interest_cents", "Interest", "money"), field("fee_cents", "Fees", "money"), field("amount_cents", "Amount", "money"), field("memo", "Memo", "multiline")]))
  return { sections, actions }
}

/** Fresh detail authorization and server-generated choices are checked by performWorkspaceAction. */
export async function performBooksAction(context: MobileOrgContext, moduleId: string, recordId: string, actionId: string, input: Record<string, string>) {
  const orgId = context.orgId
  if (moduleId === "period-close") {
    const service = await import("@/lib/services/books/period-close")
    if (actionId === "run-close-checks") return service.runBooksCloseChecklist(recordId, orgId)
    if (actionId === "close-period") return service.closeAccountingPeriod(recordId, orgId)
    if (actionId === "reopen-period") return service.reopenAccountingPeriod({ periodId: recordId, reason: z.string().trim().min(10).max(1000).parse(input.reason), orgId })
    throw new MobileAPIError(405, "action_unavailable", "This accounting action is unavailable.")
  }
  if (moduleId === "chart") {
    const service = await import("@/lib/services/books/chart-management")
    if (actionId === "edit-account") {
      const workspace = await getBooksWorkspace(orgId, "chart")
      const account = workspace.accounts.find(account => account.id === recordId)
      if (!account) throw new MobileAPIError(404, "account_missing", "Account no longer available.")
      return service.updateGlAccount({ accountId: recordId, name: input.name, description: input.description, cashFlowCategory: account.cash_flow_category }, orgId)
    }
    return service.setGlAccountActive(recordId, actionId === "activate-account", orgId)
  }
  if (actionId === "map-account") return (await import("@/lib/services/books/bank-feeds")).mapBankAccountToGl({ bankAccountId: recordId, glAccountId: input.account_id, orgId })
  if (actionId === "categorize") return (await import("@/lib/services/books/bank-rules")).categorizeBankTransaction({ bankTransactionId: recordId, glAccountId: input.account_id, projectId: input.project_id || null, costCodeId: input.cost_code_id || null, memo: input.memo, learn: false, orgId })
  const service = await import("@/lib/services/books/bank-reconciliation")
  if (actionId === "start-reconciliation") {
    const start = z.string().date().parse(input.statement_start), end = z.string().date().parse(input.statement_end)
    if (end < start) throw new MobileAPIError(422, "invalid_dates", "Statement end must be on or after its start.")
    const cents = (value: string) => {
      if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new MobileAPIError(422, "invalid_amount", "Enter a balance with up to two decimal places.")
      return z.number().int().safe().parse(Math.round(Number(value) * 100))
    }
    return service.createBankReconciliation({ bankAccountId: recordId, statementStart: start, statementEnd: end, beginningBalanceCents: cents(input.beginning_balance), endingBalanceCents: cents(input.ending_balance), orgId })
  }
  if (actionId === "close-reconciliation") return service.closeBankReconciliation(recordId, orgId)
  if (actionId === "reopen-reconciliation") return service.reopenBankReconciliation({ reconciliationId: recordId, reason: input.reason, orgId })
  throw new MobileAPIError(405, "action_unavailable", "This accounting action is unavailable.")
}
