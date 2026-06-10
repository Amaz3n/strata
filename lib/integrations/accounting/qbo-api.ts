import { getQBOAccessToken } from "@/lib/services/qbo-connection"
import { qboCompanyBaseUrl, qboEnvironmentLabel } from "@/lib/integrations/accounting/qbo-config"
import { escapeQboQueryLiteral } from "@/lib/integrations/accounting/qbo-query"
import { mapQboAccountRows, pickPreferredQboIncomeAccounts } from "@/lib/integrations/accounting/qbo-account-utils"

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
  return response.headers.get("intuit_tid") ?? response.headers.get("intuit_tid".replace("_", "-"))
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

  constructor(token: string, realmId: string) {
    this.token = token
    this.realmId = realmId
  }

  static async forOrg(orgId: string): Promise<QBOClient | null> {
    const auth = await getQBOAccessToken(orgId)
    if (!auth) return null
    return new QBOClient(auth.token, auth.realmId)
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
    })
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: any): Promise<T> {
    const response = await this.fetchEndpoint(method, endpoint, {
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}))
      throw new QBOError(response.status, errorPayload, getIntuitTid(response))
    }

    return response.json()
  }

  private toQboStringLiteral(value: string): string {
    return escapeQboQueryLiteral(value)
  }

  async getLastInvoiceNumber(): Promise<string> {
    const query = `SELECT DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 1`
    const result = await this.request<QueryInvoiceResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return result.QueryResponse.Invoice?.[0]?.DocNumber ?? "0"
  }

  async checkDocNumberExists(docNumber: string): Promise<boolean> {
    const query = `SELECT Id FROM Invoice WHERE DocNumber = '${this.toQboStringLiteral(docNumber)}'`
    const result = await this.request<QueryInvoiceResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return (result.QueryResponse.Invoice?.length ?? 0) > 0
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
    return this.createCustomer({ DisplayName: displayName })
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
    return all
  }

  // Server-side typeahead. Empty/short queries return the leading slice of active customers so the
  // picker has something to show on open; non-empty queries do a DisplayName "contains" match in QBO
  // (wildcards on both sides) so searching by a last name or keyword mid-name still finds the customer.
  async searchCustomers(term: string, limit = 25): Promise<QBOCustomerOption[]> {
    const max = Math.min(Math.max(limit, 1), 100)
    const trimmed = term.trim()
    const where = trimmed
      ? `WHERE Active = true AND DisplayName LIKE '%${this.toQboStringLiteral(trimmed)}%'`
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
    return this.createVendor({ DisplayName: normalized })
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

  private async getDefaultIncomeAccountId(): Promise<string | null> {
    const query = `SELECT Id, Name FROM Account WHERE AccountType = 'Income' AND Active = true MAXRESULTS 1`
    const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return result.QueryResponse.Account?.[0]?.Id ?? null
  }

  async getDefaultServiceItem(defaultIncomeAccountId?: string): Promise<{ value: string; name: string }> {
    if (defaultIncomeAccountId) {
      const itemName = `Arc Services ${defaultIncomeAccountId}`
      const existingForAccount = await this.findServiceItemByName(itemName)
      if (existingForAccount?.Id && existingForAccount?.Name) {
        return { value: existingForAccount.Id, name: existingForAccount.Name }
      }

      try {
        const createdForAccount = await this.request<{ Item: QBOItem }>("POST", "item", {
          Name: itemName,
          Type: "Service",
          IncomeAccountRef: { value: defaultIncomeAccountId },
        })

        if (createdForAccount.Item?.Id && createdForAccount.Item?.Name) {
          return { value: createdForAccount.Item.Id, name: createdForAccount.Item.Name }
        }
      } catch (error) {
        const duplicate = await this.findServiceItemByName(itemName)
        if (duplicate?.Id && duplicate?.Name) {
          return { value: duplicate.Id, name: duplicate.Name }
        }
        throw error
      }
    }

    const query = `SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1`
    const result = await this.request<{ QueryResponse: { Item?: any[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )

    if (result.QueryResponse.Item?.[0]) {
      return {
        value: result.QueryResponse.Item[0].Id,
        name: result.QueryResponse.Item[0].Name,
      }
    }

    const incomeAccountId = defaultIncomeAccountId ?? (await this.getDefaultIncomeAccountId())
    if (!incomeAccountId) {
      throw new Error("Unable to create QBO service item: no active Income account found")
    }

    const newItem = await this.request<{ Item: any }>("POST", "item", {
      Name: "Construction Services",
      Type: "Service",
      IncomeAccountRef: { value: incomeAccountId },
    })

    return { value: newItem.Item.Id, name: newItem.Item.Name }
  }

  private async findServiceItemByName(name: string): Promise<QBOItem | null> {
    const query = `SELECT Id, Name FROM Item WHERE Type = 'Service' AND Name = '${this.toQboStringLiteral(name)}' MAXRESULTS 1`
    const result = await this.request<{ QueryResponse: { Item?: QBOItem[] } }>(
      "GET",
      `query?query=${encodeURIComponent(query)}`,
    )
    return result.QueryResponse.Item?.[0] ?? null
  }

  async listIncomeAccounts(): Promise<QBOIncomeAccount[]> {
    const runAccountQuery = async (query: string): Promise<QBOIncomeAccount[]> => {
      try {
        const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
        return mapQboAccountRows(result.QueryResponse.Account)
      } catch {
        return []
      }
    }

    const incomeAccounts = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName FROM Account WHERE AccountType = 'Income' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )
    const otherIncomeAccounts = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName FROM Account WHERE AccountType = 'Other Income' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )

    const revenueFallback = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName FROM Account WHERE Classification = 'Revenue' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )
    return pickPreferredQboIncomeAccounts({
      income: incomeAccounts,
      otherIncome: otherIncomeAccounts,
      revenueFallback,
    })
  }

  async listExpenseAccounts(): Promise<QBOAccountRef[]> {
    const runAccountQuery = async (query: string): Promise<QBOAccountRef[]> => {
      try {
        const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
        return (result.QueryResponse.Account ?? [])
          .filter((account) => account.Id && account.Name)
          .map((account) => ({
            id: String(account.Id),
            name: String(account.Name),
            fullyQualifiedName: account.FullyQualifiedName ? String(account.FullyQualifiedName) : undefined,
            accountType: account.AccountType ? String(account.AccountType) : undefined,
          }))
      } catch {
        return []
      }
    }

    const expense = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE AccountType = 'Expense' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )
    const cogs = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE AccountType = 'Cost of Goods Sold' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )
    const otherExpense = await runAccountQuery(
      `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE AccountType = 'Other Expense' AND Active = true ORDERBY Name MAXRESULTS 1000`,
    )
    return [...expense, ...cogs, ...otherExpense]
  }

  async listPaymentAccounts(): Promise<QBOAccountRef[]> {
    const query = `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE Active = true ORDERBY Name MAXRESULTS 1000`
    const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return (result.QueryResponse.Account ?? [])
      .filter((account) => account.Id && account.Name)
      .filter((account) => {
        const type = String(account.AccountType ?? "").toLowerCase()
        return type === "bank" || type === "credit card" || type === "other current asset"
      })
      .map((account) => ({
        id: String(account.Id),
        name: String(account.Name),
        fullyQualifiedName: account.FullyQualifiedName ? String(account.FullyQualifiedName) : undefined,
        accountType: account.AccountType ? String(account.AccountType) : undefined,
      }))
  }

  async listAccountsPayableAccounts(): Promise<QBOAccountRef[]> {
    const query = `SELECT Id, Name, FullyQualifiedName, AccountType FROM Account WHERE AccountType = 'Accounts Payable' AND Active = true ORDERBY Name MAXRESULTS 1000`
    const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return (result.QueryResponse.Account ?? [])
      .filter((account) => account.Id && account.Name)
      .map((account) => ({
        id: String(account.Id),
        name: String(account.Name),
        fullyQualifiedName: account.FullyQualifiedName ? String(account.FullyQualifiedName) : undefined,
        accountType: account.AccountType ? String(account.AccountType) : undefined,
      }))
  }

  async listClasses(limit = 1000): Promise<QBOClassOption[]> {
    const query = `SELECT Id, Name, FullyQualifiedName FROM Class WHERE Active = true ORDERBY FullyQualifiedName MAXRESULTS ${Math.min(Math.max(limit, 1), 1000)}`
    const result = await this.request<QueryClassResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    return (result.QueryResponse.Class ?? [])
      .filter((qboClass) => qboClass.Id && qboClass.Name)
      .map((qboClass) => ({
        id: String(qboClass.Id),
        name: String(qboClass.Name),
        fullyQualifiedName: qboClass.FullyQualifiedName ? String(qboClass.FullyQualifiedName) : undefined,
      }))
  }

  async getIncomeAccountById(accountId: string): Promise<QBOIncomeAccount | null> {
    const normalized = String(accountId ?? "").trim()
    if (!normalized) return null

    const query = `SELECT Id, Name, FullyQualifiedName FROM Account WHERE Id = '${this.toQboStringLiteral(normalized)}' MAXRESULTS 1`
    const result = await this.request<QueryAccountResponse>("GET", `query?query=${encodeURIComponent(query)}`)
    const match = result.QueryResponse.Account?.[0]
    if (!match?.Id || !match?.Name) return null
    return {
      id: String(match.Id),
      name: String(match.Name),
      fullyQualifiedName: match.FullyQualifiedName ? String(match.FullyQualifiedName) : undefined,
    }
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

  async createBillPayment(billPayment: any): Promise<any> {
    const result = await this.request<{ BillPayment: any }>("POST", "billpayment", billPayment)
    return result.BillPayment
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
      if (error instanceof QBOError && error.status === 404) return null
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
    const hardCap = Math.max(opts?.maxResults ?? 5000, 1)
    const pageSize = 1000
    const all: any[] = []
    let startPosition = 1
    while (all.length < hardCap) {
      const page = await this.queryEntity<any>(entity, {
        whereClause: since,
        orderBy: "TxnDate DESC",
        startPosition,
        maxResults: Math.min(pageSize, hardCap - all.length),
      })
      all.push(...page)
      if (page.length < pageSize) break
      startPosition += page.length
    }
    return all
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

    const form = new FormData()
    const fileBytes = Buffer.isBuffer(params.content) ? params.content : Buffer.from(params.content)
    const fileArrayBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    ) as ArrayBuffer
    form.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "attachment.json")
    form.append("file_content_01", new Blob([fileArrayBuffer], { type: params.contentType }), params.fileName)

    const response = await this.fetchEndpoint("POST", "upload", {
      body: form,
    })

    if (!response.ok) {
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
