import { getQBOAccessToken, getQBOAccessTokenForConnection } from "@/lib/integrations/accounting/qbo/connections"
import { logQBO } from "@/lib/services/accounting-logger"
import { qboCompanyBaseUrl, qboEnvironmentLabel } from "@/lib/integrations/accounting/qbo/config"
import { escapeQboQueryLiteral } from "@/lib/integrations/accounting/qbo/query"
import { mapQboAccountRows, pickPreferredQboIncomeAccounts } from "@/lib/integrations/accounting/qbo/account-utils"
import { isQboMissingEntityFault } from "@/lib/integrations/accounting/qbo/error-rules"

interface QBOFaultError {
  Message?: string
  Detail?: string
  code?: string
}

interface QBOFaultPayload {
  Fault?: {
    type?: string
    Error?: QBOFaultError[]
  }
}

function getFaultErrors(payload: unknown): QBOFaultError[] {
  const maybeErrors = (payload as QBOFaultPayload | null | undefined)?.Fault?.Error
  if (!Array.isArray(maybeErrors)) return []
  return maybeErrors.filter((item) => item && typeof item === "object")
}

function getQBOFaultSummary(payload: unknown): string | null {
  const summaries = getFaultErrors(payload)
    .map((fault) => {
      const message = fault.Message?.trim()
      const detail = fault.Detail?.trim()
      const code = fault.code?.trim()
      const text =
        detail && message && detail !== message
          ? `${message}: ${detail}`
          : (detail ?? message ?? "")
      if (!text && !code) return ""
      return [code ? `code ${code}` : "", text].filter(Boolean).join(" - ")
    })
    .filter(Boolean)

  return summaries.length > 0 ? summaries.join(" | ") : null
}

function getQBOAuthHint(status: number, payload: unknown): string | null {
  if (status !== 401 && status !== 403) return null

  const normalized = JSON.stringify(payload ?? {}).toLowerCase()
  const looksLikeEnvMismatch =
    normalized.includes("applicationauthorizationfailed") ||
    normalized.includes("application authentication failed") ||
    normalized.includes("authenticationfailed") ||
    normalized.includes('"code":"003100"')

  if (looksLikeEnvMismatch) {
    return `Check QBO app environment (${qboEnvironmentLabel}) and QBO_SANDBOX setting.`
  }

  if (status === 403) {
    return "Verify QuickBooks company/app permissions for creating invoices."
  }

  return null
}

function getIntuitTid(response: Response): string | null {
  return response.headers.get("intuit_tid") ?? response.headers.get("intuit-tid")
}

const REQUEST_MAX_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 1500
const RETRY_MAX_DELAY_MS = 30_000
const REQUEST_TIMEOUT_MS = 45_000

// One in-flight Intuit token refresh per connection within this process. Intuit rotates the
// refresh token on every refresh, so N concurrent 401s each forcing their own refresh can
// invalidate each other's tokens and burn the failure counter until the connection expires.
const refreshInFlight = new Map<string, Promise<{ token: string; realmId: string } | null>>()

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000)
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  return Math.round(backoff * (0.5 + Math.random() * 0.5))
}

/** Numeric-aware max, so "INV-100" beats "INV-99" and "2026-014" beats "2026-9". */
export function pickHighestDocNumber(docNumbers: Array<string | undefined | null>): string | null {
  let highest: string | null = null
  for (const raw of docNumbers) {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) continue
    if (highest === null || value.localeCompare(highest, undefined, { numeric: true, sensitivity: "base" }) > 0) {
      highest = value
    }
  }
  return highest
}

interface QueryInvoiceResponse {
  QueryResponse: {
    Invoice?: Array<{ DocNumber?: string }>
  }
}

interface QueryAccountResponse {
  QueryResponse: {
    Account?: Array<{ Id?: string; Name?: string; FullyQualifiedName?: string; AccountType?: string; Classification?: string }>
  }
}

interface QueryClassResponse {
  QueryResponse: {
    Class?: Array<{ Id?: string; Name?: string; FullyQualifiedName?: string; Active?: boolean }>
  }
}

interface QBOCustomer {
  Id?: string
  SyncToken?: string
  DisplayName: string
  FullyQualifiedName?: string
  /** True when this (sub-)customer is a QBO Project. Projects are modeled as sub-customers. */
  IsProject?: boolean
  Job?: boolean
  ParentRef?: { value: string; name?: string }
  PrimaryEmailAddr?: { Address: string }
  PrimaryPhone?: { FreeFormNumber: string }
  BillAddr?: { Line1?: string; Line2?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string }
}

interface QBOInvoice {
  Id?: string
  SyncToken?: string
  DocNumber: string
  TxnDate: string
  DueDate?: string
  CustomerRef: { value: string; name?: string }
  Line: Array<{
    DetailType: "SalesItemLineDetail" | "DescriptionOnly"
    Amount: number
    Description?: string
    SalesItemLineDetail?: {
      ItemRef: { value: string; name?: string }
      Qty?: number
      UnitPrice?: number
      ClassRef?: { value: string; name?: string }
    }
  }>
  PrivateNote?: string
}

interface QBOItem {
  Id?: string
  Name?: string
  Active?: boolean
  Type?: string
  IncomeAccountRef?: { value?: string; name?: string }
}

interface QBOVendor {
  Id?: string
  SyncToken?: string
  DisplayName: string
  PrimaryEmailAddr?: { Address?: string }
  BillAddr?: {
    Line1?: string
    City?: string
    CountrySubDivisionCode?: string
    PostalCode?: string
  }
}

interface QBOInvoiceLineSnapshot {
  Id?: string
  DetailType?: "SalesItemLineDetail" | "DescriptionOnly" | string
  Amount?: number
  Description?: string
  SalesItemLineDetail?: {
    ItemRef?: { value?: string; name?: string }
    Qty?: number
    UnitPrice?: number
    TaxCodeRef?: { value?: string; name?: string }
    ClassRef?: { value?: string; name?: string }
  }
}

export interface QBOInvoiceSnapshot {
  Id?: string
  SyncToken?: string
  DocNumber?: string
  TxnDate?: string
  DueDate?: string
  TotalAmt?: number
  Balance?: number
  PrivateNote?: string
  Line?: QBOInvoiceLineSnapshot[]
  TxnTaxDetail?: {
    TotalTax?: number | string
  }
}

export interface QBOPaymentSnapshot {
  Id?: string
  SyncToken?: string
  TotalAmt?: number
  TxnDate?: string
  Line?: Array<{
    LinkedTxn?: Array<{
      TxnId?: string
      TxnType?: string
    }>
  }>
}

export interface QBOIncomeAccount {
  id: string
  name: string
  fullyQualifiedName?: string
}

export interface QBOAccountRef {
  id: string
  name: string
  fullyQualifiedName?: string
  accountType?: string
}

export interface QBOCustomerOption {
  id: string
  name: string
  email?: string | null
  billingAddress?: string | null
  /** True when this customer is a QBO Project (a sub-customer with IsProject set). */
  isProject?: boolean
  /** Hierarchy path, e.g. "Shara Barnett:Barnett Design". */
  fullyQualifiedName?: string | null
  parentId?: string | null
}

export interface QBOVendorOption {
  id: string
  name: string
}

export interface QBOClassOption {
  id: string
  name: string
  fullyQualifiedName?: string
}

export class QBOClient {
  private token: string
  private realmId: string
  private orgId: string | null
  private connectionId: string | null

  constructor(token: string, realmId: string, orgId?: string, connectionId?: string) {
    this.token = token
    this.realmId = realmId
    this.orgId = orgId ?? null
    this.connectionId = connectionId ?? null
  }

  static async forOrg(orgId: string): Promise<QBOClient | null> {
    const auth = await getQBOAccessToken(orgId)
    if (!auth) return null
    return new QBOClient(auth.token, auth.realmId, orgId)
  }

  static async forConnection(connectionId: string): Promise<QBOClient | null> {
    const auth = await getQBOAccessTokenForConnection(connectionId)
    if (!auth) return null
    return new QBOClient(auth.token, auth.realmId, undefined, connectionId)
  }

  private async fetchEndpoint(
    method: "GET" | "POST",
    endpoint: string,
    init?: {
      body?: BodyInit
      headers?: Record<string, string>
    },
  ): Promise<Response> {
    const url = `${qboCompanyBaseUrl}/${this.realmId}/${endpoint}`
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      body: init?.body,
      // A hung Intuit socket must not consume the whole function budget — a
      // timed-out create is recoverable via the PrivateNote marker; a silent
      // hang past the platform limit is not.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  private async refreshTokenSingleFlight(): Promise<boolean> {
    const key = this.connectionId ? `conn:${this.connectionId}` : `org:${this.orgId}`
    let pending = refreshInFlight.get(key)
    if (!pending) {
      pending = (this.connectionId
        ? getQBOAccessTokenForConnection(this.connectionId, { forceRefresh: true })
        : getQBOAccessToken(this.orgId ?? "", { forceRefresh: true })
      ).finally(() => refreshInFlight.delete(key))
      refreshInFlight.set(key, pending)
    }
    const refreshed = await pending
    if (!refreshed?.token) return false
    this.token = refreshed.token
    this.realmId = refreshed.realmId
    return true
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: any): Promise<T> {
    let refreshedOnce = false
    let attempt = 0
    for (;;) {
      attempt += 1
      let response: Response
      try {
        response = await this.fetchEndpoint(method, endpoint, {
          headers: {
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        })
      } catch (networkError) {
        // fetch throws (timeout, DNS, reset) without an HTTP response. Reads are
        // safe to retry; a write may have landed, so it goes to the outbox path
        // whose duplicate protection owns write retries.
        if (method === "GET" && attempt < REQUEST_MAX_ATTEMPTS) {
          await sleep(retryDelayMs(null, attempt))
          continue
        }
        throw networkError
      }

      if (response.ok) return response.json()

      if (response.status === 401 && !refreshedOnce && (this.connectionId || this.orgId)) {
        refreshedOnce = true
        if (await this.refreshTokenSingleFlight()) continue
      }

      // 429 means the request was throttled before processing, so any method is safe to
      // retry. 5xx is retried only for reads — QBO gives no idempotency guarantee on
      // writes, and the outbox retry path owns write retries with duplicate protection.
      const retryable = response.status === 429 || (method === "GET" && response.status >= 500)
      if (retryable && attempt < REQUEST_MAX_ATTEMPTS) {
        // Release the abandoned response body so retries don't pin sockets.
        void response.body?.cancel()
        await sleep(retryDelayMs(response, attempt))
        continue
      }

      const errorPayload = await response.json().catch(() => ({}))
      throw new QBOError(response.status, errorPayload, getIntuitTid(response))
    }
  }

  private toQboStringLiteral(value: string): string {
    return escapeQboQueryLiteral(value)
  }

  async getLastInvoiceNumber(): Promise<string> {
    // The most recently *created* invoice is not necessarily the highest-numbered one
    // (backdated or imported invoices), so scan a window and take the numeric max.
    const query = `SELECT DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 100`
    const result = await this.request<QueryInvoiceResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return pickHighestDocNumber((result.QueryResponse.Invoice ?? []).map((row) => row.DocNumber)) ?? "0"
  }

  async findCustomerByName(displayName: string): Promise<QBOCustomer | null> {
    const query = `SELECT * FROM Customer WHERE DisplayName = '${this.toQboStringLiteral(displayName)}'`
    const result = await this.request<{ QueryResponse: { Customer?: QBOCustomer[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return result.QueryResponse.Customer?.[0] ?? null
  }

  async createCustomer(customer: Omit<QBOCustomer, "Id" | "SyncToken">): Promise<QBOCustomer> {
    const result = await this.request<{ Customer: QBOCustomer }>("POST", "customer", customer)
    return result.Customer
  }

  async getOrCreateCustomer(displayName: string): Promise<QBOCustomer> {
    const found = await this.findCustomerByName(displayName)
    if (found) return found
    try {
      return await this.createCustomer({ DisplayName: displayName })
    } catch (error) {
      // Fault 6240: the name exists. Either a concurrent push created it first
      // (re-lookup adopts the winner) or an INACTIVE same-name customer holds
      // the name — QBO name-uniqueness spans inactive records, so say so
      // instead of failing forever with Intuit's raw text.
      if (error instanceof QBOError && error.faultCode === "6240") {
        const raced = await this.findCustomerByName(displayName)
        if (raced) return raced
        throw new QBOError(
          error.status,
          { Fault: { Error: [{ code: "6240", Detail: `An inactive QuickBooks customer already uses the name "${displayName}". Reactivate or rename it in QuickBooks, then retry.` }] } },
          error.intuitTid,
        )
      }
      throw error
    }
  }

  async listCustomers(limit = 1000): Promise<QBOCustomerOption[]> {
    // SELECT * (not an explicit column list): QBO's query parser rejects complex properties like
    // BillAddr / PrimaryEmailAddr in a column list ("Property BillAddr not found"), so we fetch the
    // full Customer object and let mapCustomerOption pull what it needs.
    const query = `SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName MAXRESULTS ${Math.min(Math.max(limit, 1), 1000)}`
    const result = await this.request<{ QueryResponse: { Customer?: QBOCustomer[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return (result.QueryResponse.Customer ?? [])
      .filter((customer) => customer.Id && customer.DisplayName)
      .map((customer) => mapCustomerOption(customer))
  }

  /**
   * Every active customer and project (QBO models projects as sub-customers), paged through in full.
   * Unlike `listCustomers`, which caps at a single 1000-row page, this advances STARTPOSITION until
   * QBO returns a short page, so an org with thousands of customers/projects surfaces all of them —
   * used to populate the import project filter from the real QBO list rather than inferring it from
   * the fetched transactions. `maxResults` is a safety ceiling on total rows (default 10000).
   */
  async listAllCustomers(opts?: { maxResults?: number }): Promise<QBOCustomerOption[]> {
    const hardCap = Math.max(opts?.maxResults ?? 10000, 1)
    const pageSize = 1000
    const all: QBOCustomerOption[] = []
    let startPosition = 1
    while (all.length < hardCap) {
      const page = await this.queryEntity<QBOCustomer>("Customer", {
        whereClause: "Active = true",
        orderBy: "DisplayName",
        startPosition,
        maxResults: Math.min(pageSize, hardCap - all.length),
      })
      for (const customer of page) {
        if (customer.Id && customer.DisplayName) all.push(mapCustomerOption(customer))
      }
      if (page.length < pageSize) break
      startPosition += page.length
    }
    if (all.length >= hardCap) {
      logQBO("warn", "customer_list_truncated", { realmId: this.realmId, cap: hardCap })
    }
    return all
  }

  // Server-side typeahead. Empty/short queries return the leading slice of active customers so the
  // picker has something to show on open; non-empty queries do a DisplayName "contains" match in QBO
  // (wildcards on both sides) so searching by a last name or keyword mid-name still finds the customer.
  async searchCustomers(term: string, limit = 25): Promise<QBOCustomerOption[]> {
    const max = Math.min(Math.max(limit, 1), 100)
    const trimmed = term.trim()
    const where = trimmed
      ? `WHERE Active = true AND DisplayName LIKE '%${this.toQboStringLiteral(trimmed).replace(/([%_])/g, "\\$1")}%'`
      : `WHERE Active = true`
    // SELECT * — see listCustomers: an explicit column list with BillAddr / PrimaryEmailAddr is
    // rejected by QBO ("Property BillAddr not found for Entity Customer").
    const query = `SELECT * FROM Customer ${where} ORDERBY DisplayName MAXRESULTS ${max}`
    const result = await this.request<{ QueryResponse: { Customer?: QBOCustomer[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return (result.QueryResponse.Customer ?? [])
      .filter((customer) => customer.Id && customer.DisplayName)
      .map((customer) => mapCustomerOption(customer))
  }

  async createCustomerOption(input: {
    name: string
    email?: string | null
    line1?: string | null
    city?: string | null
    state?: string | null
    postalCode?: string | null
  }): Promise<QBOCustomerOption> {
    const payload: Omit<QBOCustomer, "Id" | "SyncToken"> = { DisplayName: input.name.trim() }
    const email = input.email?.trim()
    if (email) payload.PrimaryEmailAddr = { Address: email }
    const billAddr = {
      Line1: input.line1?.trim() || undefined,
      City: input.city?.trim() || undefined,
      CountrySubDivisionCode: input.state?.trim() || undefined,
      PostalCode: input.postalCode?.trim() || undefined,
    }
    if (Object.values(billAddr).some(Boolean)) payload.BillAddr = billAddr
    const created = await this.createCustomer(payload)
    return mapCustomerOption(created)
  }

  async findVendorByName(displayName: string): Promise<QBOVendor | null> {
    const query = `SELECT * FROM Vendor WHERE DisplayName = '${this.toQboStringLiteral(displayName)}'`
    const result = await this.request<{ QueryResponse: { Vendor?: QBOVendor[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return result.QueryResponse.Vendor?.[0] ?? null
  }

  async createVendor(vendor: Omit<QBOVendor, "Id" | "SyncToken">): Promise<QBOVendor> {
    const result = await this.request<{ Vendor: QBOVendor }>("POST", "vendor", vendor)
    return result.Vendor
  }

  async createVendorOption(input: {
    name: string
    email?: string | null
    line1?: string | null
    city?: string | null
    state?: string | null
    postalCode?: string | null
  }): Promise<QBOVendorOption> {
    const payload: Omit<QBOVendor, "Id" | "SyncToken"> = { DisplayName: input.name.trim() || "Unknown Vendor" }
    const email = input.email?.trim()
    if (email) payload.PrimaryEmailAddr = { Address: email }
    const billAddr = {
      Line1: input.line1?.trim() || undefined,
      City: input.city?.trim() || undefined,
      CountrySubDivisionCode: input.state?.trim() || undefined,
      PostalCode: input.postalCode?.trim() || undefined,
    }
    if (Object.values(billAddr).some(Boolean)) payload.BillAddr = billAddr
    const created = await this.createVendor(payload)
    return { id: String(created.Id), name: String(created.DisplayName) }
  }

  async getOrCreateVendor(displayName: string): Promise<QBOVendor> {
    const normalized = displayName.trim() || "Unknown Vendor"
    const found = await this.findVendorByName(normalized)
    if (found) return found
    try {
      return await this.createVendor({ DisplayName: normalized })
    } catch (error) {
      // See getOrCreateCustomer: 6240 is a lost create race or an inactive
      // same-name vendor squatting on the name.
      if (error instanceof QBOError && error.faultCode === "6240") {
        const raced = await this.findVendorByName(normalized)
        if (raced) return raced
        throw new QBOError(
          error.status,
          { Fault: { Error: [{ code: "6240", Detail: `An inactive QuickBooks vendor already uses the name "${normalized}". Reactivate or rename it in QuickBooks, then retry.` }] } },
          error.intuitTid,
        )
      }
      throw error
    }
  }

  async listVendors(limit = 1000): Promise<QBOVendorOption[]> {
    const query = `SELECT Id, DisplayName FROM Vendor WHERE Active = true ORDERBY DisplayName MAXRESULTS ${Math.min(Math.max(limit, 1), 1000)}`
    const result = await this.request<{ QueryResponse: { Vendor?: QBOVendor[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return (result.QueryResponse.Vendor ?? [])
      .filter((vendor) => vendor.Id && vendor.DisplayName)
      .map((vendor) => ({
        id: String(vendor.Id),
        name: String(vendor.DisplayName),
      }))
  }

  /**
   * Resolve an existing QBO Product/Service. Invoice sync must never create an
   * Item as a side effect: item creation changes the client's books and must be
   * an explicit setup action in QuickBooks.
   */
  async getInvoiceItemById(itemId: string): Promise<{
    id: string
    name: string
    active: boolean
    type: string | null
    incomeAccountId: string | null
    incomeAccountName: string | null
  } | null> {
    try {
      const result = await this.request<{ Item?: QBOItem }>("GET", `item/${encodeURIComponent(itemId)}`)
      const item = result.Item
      if (!item?.Id || !item.Name) return null
      return {
        id: String(item.Id),
        name: String(item.Name),
        active: item.Active !== false,
        type: item.Type ? String(item.Type) : null,
        incomeAccountId: item.IncomeAccountRef?.value ? String(item.IncomeAccountRef.value) : null,
        incomeAccountName: item.IncomeAccountRef?.name ? String(item.IncomeAccountRef.name) : null,
      }
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async listInvoiceItems(limit = 1000): Promise<Array<{
    id: string
    name: string
    active: boolean
    type: string | null
    incomeAccountId: string | null
    incomeAccountName: string | null
  }>> {
    const query = `SELECT * FROM Item WHERE Active = true ORDERBY Name MAXRESULTS ${Math.min(Math.max(limit, 1), 1000)}`
    const result = await this.request<{ QueryResponse: { Item?: QBOItem[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return (result.QueryResponse.Item ?? [])
      .filter((item): item is QBOItem & { Id: string; Name: string } => Boolean(item.Id && item.Name))
      .map((item) => ({
        id: String(item.Id),
        name: String(item.Name),
        active: item.Active !== false,
        type: item.Type ? String(item.Type) : null,
        incomeAccountId: item.IncomeAccountRef?.value ? String(item.IncomeAccountRef.value) : null,
        incomeAccountName: item.IncomeAccountRef?.name ? String(item.IncomeAccountRef.name) : null,
      }))
  }

  /**
   * Page a list query to completion. Chart-of-accounts and class listings used
   * to cap silently at 1000 rows — a job-costing file with a class per job
   * loses the tail and the mapping UI shows a partial chart as if it were
   * complete. Errors propagate: an Intuit outage must not render as "this
   * company has no accounts".
   */
  private async queryAllPages<TRow>(baseQuery: string, extract: (payload: QueryAccountResponse & QueryClassResponse) => TRow[] | undefined): Promise<TRow[]> {
    const pageSize = 1000
    const rows: TRow[] = []
    for (let start = 1; ; start += pageSize) {
      const query = `${baseQuery} STARTPOSITION ${start} MAXRESULTS ${pageSize}`
      const result = await this.request<QueryAccountResponse & QueryClassResponse>("GET", `query?query=${encodeURIComponent(query)}`)
      const page = extract(result) ?? []
      rows.push(...page)
      if (page.length < pageSize) return rows
    }
  }

  private async queryAccountRefs(where: string, orderBy = "Name"): Promise<QBOAccountRef[]> {
    const rows = await this.queryAllPages(
      `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE ${where} ORDERBY ${orderBy}`,
      (payload) => payload.QueryResponse.Account,
    )
    return rows
      .filter((account) => account.Id && account.Name)
      .map((account) => ({
        id: String(account.Id),
        name: String(account.Name),
        fullyQualifiedName: account.FullyQualifiedName ? String(account.FullyQualifiedName) : undefined,
        accountType: account.AccountType ? String(account.AccountType) : undefined,
      }))
  }

  async listIncomeAccounts(): Promise<QBOIncomeAccount[]> {
    const runAccountQuery = async (where: string): Promise<QBOIncomeAccount[]> => {
      const rows = await this.queryAllPages(
        `SELECT Id, Name, FullyQualifiedName FROM Account WHERE ${where} ORDERBY Name`,
        (payload) => payload.QueryResponse.Account,
      )
      return mapQboAccountRows(rows)
    }

    const incomeAccounts = await runAccountQuery(`AccountType = 'Income' AND Active = true`)
    const otherIncomeAccounts = await runAccountQuery(`AccountType = 'Other Income' AND Active = true`)
    const revenueFallback =
      incomeAccounts.length + otherIncomeAccounts.length > 0 ? [] : await runAccountQuery(`Classification = 'Revenue' AND Active = true`)
    return pickPreferredQboIncomeAccounts({
      income: incomeAccounts,
      otherIncome: otherIncomeAccounts,
      revenueFallback,
    })
  }

  async listExpenseAccounts(): Promise<QBOAccountRef[]> {
    const [expense, cogs, otherExpense] = await Promise.all([
      this.queryAccountRefs(`AccountType = 'Expense' AND Active = true`),
      this.queryAccountRefs(`AccountType = 'Cost of Goods Sold' AND Active = true`),
      this.queryAccountRefs(`AccountType = 'Other Expense' AND Active = true`),
    ])
    return [...expense, ...cogs, ...otherExpense]
  }

  async listPaymentAccounts(): Promise<QBOAccountRef[]> {
    const accounts = await this.queryAccountRefs(`Active = true`)
    return accounts.filter((account) => {
      const type = String(account.accountType ?? "").toLowerCase()
      return type === "bank" || type === "credit card" || type === "other current asset"
    })
  }

  async listAllAccounts(): Promise<QBOAccountRef[]> {
    return this.queryAccountRefs(`Active = true`, "FullyQualifiedName")
  }

  async listAccountsPayableAccounts(): Promise<QBOAccountRef[]> {
    return this.queryAccountRefs(`AccountType = 'Accounts Payable' AND Active = true`)
  }

  async listClasses(): Promise<QBOClassOption[]> {
    const rows = await this.queryAllPages(
      `SELECT Id, Name, FullyQualifiedName FROM Class WHERE Active = true ORDERBY FullyQualifiedName`,
      (payload) => payload.QueryResponse.Class,
    )
    return rows
      .filter((qboClass) => qboClass.Id && qboClass.Name)
      .map((qboClass) => ({
        id: String(qboClass.Id),
        name: String(qboClass.Name),
        fullyQualifiedName: qboClass.FullyQualifiedName ? String(qboClass.FullyQualifiedName) : undefined,
      }))
  }

  private async findIncomeAccountByName(name: string): Promise<QBOIncomeAccount | null> {
    const query = `SELECT Id, Name, FullyQualifiedName FROM Account WHERE AccountType = 'Income' AND Name = '${this.toQboStringLiteral(name)}' MAXRESULTS 1`
    const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    const match = result.QueryResponse.Account?.[0]
    if (!match?.Id || !match?.Name) return null
    return {
      id: String(match.Id),
      name: String(match.Name),
      fullyQualifiedName: match.FullyQualifiedName ? String(match.FullyQualifiedName) : undefined,
    }
  }

  async createIncomeAccount(name: string): Promise<QBOIncomeAccount> {
    const normalized = name.trim()
    if (!normalized) {
      throw new Error("Account name is required")
    }

    const existing = await this.findIncomeAccountByName(normalized)
    if (existing) return existing

    try {
      const created = await this.request<{ Account?: { Id?: string; Name?: string; FullyQualifiedName?: string } }>(
        "POST",
        "account",
        {
          Name: normalized,
          AccountType: "Income",
          AccountSubType: "SalesOfProductIncome",
        },
      )

      if (!created.Account?.Id || !created.Account?.Name) {
        throw new Error("QuickBooks did not return the new income account.")
      }

      return {
        id: String(created.Account.Id),
        name: String(created.Account.Name),
        fullyQualifiedName: created.Account.FullyQualifiedName ? String(created.Account.FullyQualifiedName) : undefined,
      }
    } catch (error) {
      const foundAfterError = await this.findIncomeAccountByName(normalized).catch(() => null)
      if (foundAfterError) return foundAfterError
      throw error
    }
  }

  async createInvoice(invoice: Omit<QBOInvoice, "Id" | "SyncToken">): Promise<QBOInvoice> {
    const result = await this.request<{ Invoice: QBOInvoice }>("POST", "invoice", invoice)
    return result.Invoice
  }

  async updateInvoice(invoice: QBOInvoice): Promise<QBOInvoice> {
    if (!invoice.Id || !invoice.SyncToken) {
      throw new Error("Invoice Id and SyncToken required for update")
    }
    const result = await this.request<{ Invoice: QBOInvoice }>("POST", "invoice", invoice)
    return result.Invoice
  }

  async voidInvoice(invoice: Pick<QBOInvoice, "Id" | "SyncToken">): Promise<QBOInvoice> {
    if (!invoice.Id || !invoice.SyncToken) {
      throw new Error("Invoice Id and SyncToken required for void")
    }
    const result = await this.request<{ Invoice: QBOInvoice }>(
      "POST",
      "invoice?operation=void",
      {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        sparse: true,
      },
    )
    return result.Invoice
  }

  async createPayment(payment: any): Promise<any> {
    const result = await this.request<{ Payment: any }>("POST", "payment", payment)
    return result.Payment
  }

  async createPurchase(purchase: any): Promise<any> {
    const result = await this.request<{ Purchase: any }>("POST", "purchase", purchase)
    return result.Purchase
  }

  async updatePurchase(purchase: any): Promise<any> {
    if (!purchase.Id || !purchase.SyncToken) {
      throw new Error("Purchase Id and SyncToken required for update")
    }
    const result = await this.request<{ Purchase: any }>("POST", "purchase", purchase)
    return result.Purchase
  }

  async createBill(bill: any): Promise<any> {
    const result = await this.request<{ Bill: any }>("POST", "bill", bill)
    return result.Bill
  }

  async updateBill(bill: any): Promise<any> {
    if (!bill.Id || !bill.SyncToken) {
      throw new Error("Bill Id and SyncToken required for update")
    }
    const result = await this.request<{ Bill: any }>("POST", "bill", bill)
    return result.Bill
  }

  async createVendorCredit(credit: any): Promise<any> {
    const result = await this.request<{ VendorCredit: any }>("POST", "vendorcredit", credit)
    return result.VendorCredit
  }

  async updateVendorCredit(credit: any): Promise<any> {
    if (!credit.Id || !credit.SyncToken) throw new Error("VendorCredit Id and SyncToken required for update")
    const result = await this.request<{ VendorCredit: any }>("POST", "vendorcredit", credit)
    return result.VendorCredit
  }

  async createBillPayment(billPayment: any): Promise<any> {
    const result = await this.request<{ BillPayment: any }>("POST", "billpayment", billPayment)
    return result.BillPayment
  }

  /**
   * Delete a bill payment, which is how QuickBooks reverses one — there is no
   * void operation for BillPayment as there is for Invoice. Deleting reopens the
   * linked bill's balance, which is exactly what an ACH return means happened.
   */
  async deleteBillPayment(billPayment: { Id: string; SyncToken: string }): Promise<void> {
    if (!billPayment.Id || !billPayment.SyncToken) {
      throw new Error("BillPayment Id and SyncToken required for delete")
    }
    await this.request("POST", "billpayment?operation=delete", {
      Id: billPayment.Id,
      SyncToken: billPayment.SyncToken,
    })
  }

  async createJournalEntry(journalEntry: any): Promise<any> {
    const result = await this.request<{ JournalEntry: any }>("POST", "journalentry", journalEntry)
    return result.JournalEntry
  }

  async getBillPaymentById(billPaymentId: string): Promise<any | null> {
    const normalizedId = String(billPaymentId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ BillPayment?: any }>(
        "GET",
        `billpayment/${encodeURIComponent(normalizedId)}`,
      )
      return result.BillPayment ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getInvoiceById(invoiceId: string): Promise<QBOInvoiceSnapshot | null> {
    const normalizedId = String(invoiceId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ Invoice?: QBOInvoiceSnapshot }>(
        "GET",
        `invoice/${encodeURIComponent(normalizedId)}`,
      )
      return result.Invoice ?? null
    } catch (error) {
      // QBO returns ValidationFault 610 (HTTP 400), rather than 404, when a
      // transaction has been deleted. Treat it as missing only on this direct
      // lookup; the same fault on a create/update can mean an inactive
      // customer, item, or account and must still surface as an error.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getPaymentById(paymentId: string): Promise<QBOPaymentSnapshot | null> {
    const normalizedId = String(paymentId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ Payment?: QBOPaymentSnapshot }>(
        "GET",
        `payment/${encodeURIComponent(normalizedId)}`,
      )
      return result.Payment ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getPurchaseById(purchaseId: string): Promise<any | null> {
    const normalizedId = String(purchaseId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ Purchase?: any }>(
        "GET",
        `purchase/${encodeURIComponent(normalizedId)}`,
      )
      return result.Purchase ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getBillById(billId: string): Promise<any | null> {
    const normalizedId = String(billId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ Bill?: any }>(
        "GET",
        `bill/${encodeURIComponent(normalizedId)}`,
      )
      return result.Bill ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getVendorCreditById(vendorCreditId: string): Promise<any | null> {
    const normalizedId = String(vendorCreditId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ VendorCredit?: any }>(
        "GET",
        `vendorcredit/${encodeURIComponent(normalizedId)}`,
      )
      return result.VendorCredit ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async getJournalEntryById(journalEntryId: string): Promise<any | null> {
    const normalizedId = String(journalEntryId ?? "").trim()
    if (!normalizedId) return null

    try {
      const result = await this.request<{ JournalEntry?: any }>(
        "GET",
        `journalentry/${encodeURIComponent(normalizedId)}`,
      )
      return result.JournalEntry ?? null
    } catch (error) {
      // Deleted transactions come back as ValidationFault 610 on HTTP 400, not
      // 404 — checking only 404 made the deleted-entity recovery path
      // unreachable for this entity type.
      if (error instanceof QBOError && isQboMissingEntityFault(error)) return null
      throw error
    }
  }

  async changeDataCapture(entities: string[], changedSinceIso: string): Promise<any> {
    const entityList = entities.map((entity) => entity.trim()).filter(Boolean).join(",")
    if (!entityList) throw new Error("At least one CDC entity is required")
    const params = new URLSearchParams({
      entities: entityList,
      changedSince: changedSinceIso,
    })
    return this.request<any>("GET", `cdc?${params.toString()}`)
  }

  /**
   * Run a raw entity query and return the matching rows. Used by the QBO import flow to enumerate
   * transactions that may not yet exist in Arc. `whereClause` should NOT include the "WHERE" keyword.
   */
  private async queryEntity<T = any>(
    entity: string,
    opts?: { whereClause?: string; orderBy?: string; startPosition?: number; maxResults?: number },
  ): Promise<T[]> {
    const maxResults = Math.min(Math.max(opts?.maxResults ?? 100, 1), 1000)
    const startPosition = Math.max(opts?.startPosition ?? 1, 1)
    const where = opts?.whereClause ? ` WHERE ${opts.whereClause}` : ""
    const orderBy = opts?.orderBy ? ` ORDERBY ${opts.orderBy}` : ""
    const query = `SELECT * FROM ${entity}${where}${orderBy} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`
    const result = await this.request<{ QueryResponse?: Record<string, T[] | undefined> }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return (result.QueryResponse?.[entity] as T[] | undefined) ?? []
  }

  /**
   * List transactions of the given QBO entity type for the import picker. Optionally filtered to
   * those on or after `sinceDate` (YYYY-MM-DD), most recent first.
   *
   * Pages through the full result set (QBO returns at most 1000 rows per request), so a busy org with
   * thousands of transactions in the window still surfaces older ones — a single 200-row page would
   * silently drop everything past the 200 most recent. `maxResults` is a safety ceiling on the total
   * rows pulled (default 5000), not a per-page cap.
   */
  async listTransactionsForImport(
    entity: "Invoice" | "Purchase" | "Bill" | "Payment" | "BillPayment" | "JournalEntry" | "VendorCredit",
    opts?: { sinceDate?: string | null; maxResults?: number },
  ): Promise<any[]> {
    const since =
      opts?.sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.sinceDate)
        ? `TxnDate >= '${this.toQboStringLiteral(opts.sinceDate)}'`
        : undefined
    const hardCap = Math.max(opts?.maxResults ?? 25000, 1)
    const pageSize = 1000
    const all: any[] = []
    const seenIds = new Set<string>()
    let startPosition = 1
    while (all.length < hardCap) {
      const page = await this.queryEntity<any>(entity, {
        whereClause: since,
        orderBy: "TxnDate DESC",
        startPosition,
        maxResults: Math.min(pageSize, hardCap - all.length),
      })
      for (const row of page) {
        const id = row?.Id ? String(row.Id) : null
        if (!id || seenIds.has(id)) continue
        seenIds.add(id)
        all.push(row)
      }
      if (page.length < pageSize) break
      startPosition += page.length
    }
    if (all.length >= hardCap) {
      logQBO("warn", "import_list_truncated", { realmId: this.realmId, entity, cap: hardCap })
    }
    return all.sort(
      (a, b) =>
        String(b?.TxnDate ?? "").localeCompare(String(a?.TxnDate ?? "")) ||
        String(a?.Id ?? "").localeCompare(String(b?.Id ?? "")),
    )
  }

  /**
   * Find a transaction this company file already holds that carries `marker` in
   * its PrivateNote.
   *
   * QuickBooks has no idempotency key on create. When a create succeeds but its
   * response is lost — a timeout near the function cap is the usual way — the
   * retry has no way to tell "never created" from "created, never heard back",
   * and posts the money a second time. Arc stamps its own transaction id into
   * PrivateNote on create so the retry can look for its own work and adopt it.
   *
   * PrivateNote is not a filterable field in the QBO query language, so the
   * filter is on TxnDate (which is) and the marker is matched here. `SELECT *`
   * is deliberate: QBO rejects queries that name complex columns.
   */
  async findTransactionByPrivateNote(
    entity: "Payment" | "BillPayment" | "Invoice" | "Bill" | "Purchase" | "VendorCredit" | "JournalEntry",
    marker: string,
    opts?: { sinceDate?: string | null },
  ): Promise<{ Id?: string; SyncToken?: string; PrivateNote?: string } | null> {
    const normalizedMarker = String(marker ?? "").trim()
    if (!normalizedMarker) return null
    const since =
      opts?.sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.sinceDate)
        ? `TxnDate >= '${this.toQboStringLiteral(opts.sinceDate)}'`
        : undefined

    const rows = await this.queryEntity<{ Id?: string; SyncToken?: string; PrivateNote?: string }>(entity, {
      whereClause: since,
      orderBy: "TxnDate DESC",
      maxResults: 1000,
    })
    return rows.find((row) => String(row?.PrivateNote ?? "").includes(normalizedMarker)) ?? null
  }

  async uploadAttachmentForEntity(params: {
    entityType: "Invoice" | "Purchase" | "Bill" | "BillPayment" | "PurchaseOrder" | "VendorCredit"
    entityId: string
    fileName: string
    contentType: string
    content: Uint8Array | Buffer
    note?: string | null
  }): Promise<{ id: string; fileName?: string; tempDownloadUri?: string | null }> {
    const metadata = {
      AttachableRef: [
        {
          EntityRef: {
            type: params.entityType,
            value: params.entityId,
          },
        },
      ],
      FileName: params.fileName,
      ContentType: params.contentType,
      Note: params.note ?? undefined,
    }

    const fileBytes = Buffer.isBuffer(params.content) ? params.content : Buffer.from(params.content)
    const fileArrayBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    ) as ArrayBuffer

    // Multipart, so it cannot ride `request()` — but it still needs the same
    // 401-refresh and 429/retry treatment: this runs at the END of a push,
    // after money has already posted, which is exactly when the access token
    // is most likely to have aged out mid-batch.
    let refreshedOnce = false
    let attempt = 0
    let response: Response
    for (;;) {
      attempt += 1
      // FormData is single-use once sent; rebuild it per attempt.
      const form = new FormData()
      form.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "attachment.json")
      form.append("file_content_01", new Blob([fileArrayBuffer], { type: params.contentType }), params.fileName)
      response = await this.fetchEndpoint("POST", "upload", { body: form })
      if (response.ok) break
      if (response.status === 401 && !refreshedOnce && (this.connectionId || this.orgId)) {
        refreshedOnce = true
        if (await this.refreshTokenSingleFlight()) continue
      }
      // An attachment upload is idempotent enough to retry on 429/5xx: the
      // caller fingerprints uploads, and a duplicated receipt is recoverable
      // where a failed whole push after posted money is not.
      if ((response.status === 429 || response.status >= 500) && attempt < REQUEST_MAX_ATTEMPTS) {
        void response.body?.cancel()
        await sleep(retryDelayMs(response, attempt))
        continue
      }
      const errorPayload = await response.json().catch(() => ({}))
      throw new QBOError(response.status, errorPayload, getIntuitTid(response))
    }

    const payload = await response.json().catch(() => ({} as any))
    const attachable =
      payload?.AttachableResponse?.[0]?.Attachable ??
      payload?.Attachable ??
      null

    if (!attachable?.Id) {
      throw new Error("QuickBooks did not return an attachment id.")
    }

    return {
      id: String(attachable.Id),
      fileName: typeof attachable.FileName === "string" ? attachable.FileName : undefined,
      tempDownloadUri: typeof attachable.TempDownloadUri === "string" ? attachable.TempDownloadUri : null,
    }
  }

  async uploadAttachmentForInvoice(params: {
    invoiceId: string
    fileName: string
    contentType: string
    content: Uint8Array | Buffer
    note?: string | null
  }): Promise<{ id: string; fileName?: string; tempDownloadUri?: string | null }> {
    return this.uploadAttachmentForEntity({
      entityType: "Invoice",
      entityId: params.invoiceId,
      fileName: params.fileName,
      contentType: params.contentType,
      content: params.content,
      note: params.note,
    })
  }
}

function mapCustomerOption(customer: QBOCustomer): QBOCustomerOption {
  return {
    id: String(customer.Id),
    name: String(customer.DisplayName),
    email: customer.PrimaryEmailAddr?.Address ?? null,
    billingAddress: formatQboAddress(customer.BillAddr),
    isProject: customer.IsProject === true,
    fullyQualifiedName: customer.FullyQualifiedName ? String(customer.FullyQualifiedName) : null,
    parentId: customer.ParentRef?.value ? String(customer.ParentRef.value) : null,
  }
}

function formatQboAddress(address?: QBOCustomer["BillAddr"]) {
  if (!address) return null
  return [
    address.Line1,
    address.Line2,
    [address.City, address.CountrySubDivisionCode, address.PostalCode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n") || null
}

export class QBOError extends Error {
  status: number
  qboError: any
  intuitTid: string | null
  faultType: string | null
  faultCode: string | null
  faultDetail: string | null

  constructor(status: number, error: any, intuitTid?: string | null) {
    const summary = getQBOFaultSummary(error)
    const hint = getQBOAuthHint(status, error)
    const detail = [summary, hint].filter(Boolean).join(" | ")
    super(detail ? `QBO API Error ${status}: ${detail}` : `QBO API Error ${status}`)
    this.status = status
    this.qboError = error
    this.intuitTid = intuitTid ?? null
    this.faultType = error?.Fault?.type ?? null
    const firstFault = getFaultErrors(error)[0]
    this.faultCode = firstFault?.code ?? null
    this.faultDetail = firstFault?.Detail ?? firstFault?.Message ?? null
  }

  get isRateLimit() {
    return this.status === 429
  }

  get isAuthError() {
    return (
      this.status === 401 ||
      this.faultType?.toLowerCase() === "authentication" ||
      this.faultCode === "003100"
    )
  }

  get isPermissionError() {
    return this.status === 403 && !this.isAuthError
  }
}
