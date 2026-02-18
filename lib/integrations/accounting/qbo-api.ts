import { getQBOAccessToken } from "@/lib/services/qbo-connection"
import { escapeQboQueryLiteral } from "@/lib/integrations/accounting/qbo-query"

const BASE_URL =
  process.env.NODE_ENV === "production"
    ? "https://quickbooks.api.intuit.com/v3/company"
    : "https://sandbox-quickbooks.api.intuit.com/v3/company"

interface QueryInvoiceResponse {
  QueryResponse: {
    Invoice?: Array<{ DocNumber?: string }>
  }
}

interface QueryAccountResponse {
  QueryResponse: {
    Account?: Array<{ Id?: string; Name?: string }>
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
    const url = `${BASE_URL}/${this.realmId}/${endpoint}`
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
}

export class QBOError extends Error {
  status: number
  qboError: any

  constructor(status: number, error: any) {
    super(`QBO API Error ${status}`)
    this.status = status
    this.qboError = error
  }

  get isRateLimit() {
    return this.status === 429
  }

  get isAuthError() {
    return this.status === 401
  }
}
