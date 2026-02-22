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

interface QBOCustomer {
  Id?: string
  SyncToken?: string
  DisplayName: string
  PrimaryEmailAddr?: { Address: string }
  PrimaryPhone?: { FreeFormNumber: string }
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
    }
  }>
  PrivateNote?: string
}

interface QBOItem {
  Id?: string
  Name?: string
}

export interface QBOInvoiceSnapshot {
  Id?: string
  SyncToken?: string
  DocNumber?: string
  TxnDate?: string
  DueDate?: string
  TotalAmt?: number
  Balance?: number
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

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: any): Promise<T> {
    const url = `${qboCompanyBaseUrl}/${this.realmId}/${endpoint}`
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}))
      throw new QBOError(response.status, errorPayload)
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

  async createPayment(payment: any): Promise<any> {
    const result = await this.request<{ Payment: any }>("POST", "payment", payment)
    return result.Payment
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
}

export class QBOError extends Error {
  status: number
  qboError: any
  faultType: string | null
  faultCode: string | null
  faultDetail: string | null

  constructor(status: number, error: any) {
    const summary = getQBOFaultSummary(error)
    const hint = getQBOAuthHint(status, error)
    const detail = [summary, hint].filter(Boolean).join(" | ")
    super(detail ? `QBO API Error ${status}: ${detail}` : `QBO API Error ${status}`)
    this.status = status
    this.qboError = error
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
