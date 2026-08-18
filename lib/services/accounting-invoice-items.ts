import { QBOClient } from "@/lib/integrations/accounting/qbo/client"
import {
  requireAccountingConnectionForOrg,
  updateAccountingConnectionSettings,
} from "@/lib/services/accounting-connections"
import { requireOrgContext } from "@/lib/services/context"

export type AccountingInvoiceItemReference = { id: string; name: string | null }

export interface AccountingInvoiceItemConfiguration {
  defaultItem: AccountingInvoiceItemReference | null
  incomeAccountMappings: Record<string, AccountingInvoiceItemReference>
}

function normalizeReference(value: unknown): AccountingInvoiceItemReference | null {
  if (!value || typeof value !== "object") return null
  const item = value as { id?: unknown; name?: unknown }
  if (typeof item.id !== "string" || !item.id.trim()) return null
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : null,
  }
}

export async function getAccountingInvoiceItemConfiguration(connectionId: string, orgId?: string) {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const connection = await requireAccountingConnectionForOrg(connectionId, resolvedOrgId, {
    activeOnly: true,
    provider: "qbo",
  })
  const client = await QBOClient.forConnection(connectionId)
  if (!client) throw new Error("QuickBooks connection is not active")
  const items = await client.listInvoiceItems()
  const settings = connection.settings ?? {}
  const mappings =
    settings.invoice_item_mappings && typeof settings.invoice_item_mappings === "object"
      ? settings.invoice_item_mappings
      : {}
  return {
    items,
    configuration: {
      defaultItem: normalizeReference(settings.default_invoice_item),
      incomeAccountMappings: Object.fromEntries(
        Object.entries(mappings).flatMap(([accountId, value]) => {
          const item = normalizeReference(value)
          return item ? [[accountId, item]] : []
        }),
      ),
    } satisfies AccountingInvoiceItemConfiguration,
  }
}

/**
 * Save only existing, active QBO items. Product/Service creation deliberately
 * remains in QuickBooks so invoice sync cannot mutate the client's item list.
 */
export async function updateAccountingInvoiceItemConfiguration(input: {
  connectionId: string
  defaultItem: AccountingInvoiceItemReference | null
  incomeAccountMappings: Record<string, AccountingInvoiceItemReference>
  orgId?: string
}) {
  const { orgId } = await requireOrgContext(input.orgId)
  await requireAccountingConnectionForOrg(input.connectionId, orgId, {
    activeOnly: true,
    provider: "qbo",
  })
  const client = await QBOClient.forConnection(input.connectionId)
  if (!client) throw new Error("QuickBooks connection is not active")

  const requested = [input.defaultItem, ...Object.values(input.incomeAccountMappings)].filter(
    (item): item is AccountingInvoiceItemReference => Boolean(item?.id),
  )
  const verified = new Map<string, AccountingInvoiceItemReference>()
  for (const requestedItem of requested) {
    if (verified.has(requestedItem.id)) continue
    const item = await client.getInvoiceItemById(requestedItem.id)
    if (!item) throw new Error(`QuickBooks Product/Service ${requestedItem.name ?? requestedItem.id} was not found`)
    if (!item.active) throw new Error(`QuickBooks Product/Service ${item.name} is inactive`)
    verified.set(item.id, { id: item.id, name: item.name })
  }

  const defaultItem = input.defaultItem ? verified.get(input.defaultItem.id) ?? null : null
  const invoiceItemMappings = Object.fromEntries(
    Object.entries(input.incomeAccountMappings).map(([accountId, item]) => {
      const normalizedAccountId = accountId.trim()
      if (!normalizedAccountId) throw new Error("Income-account mapping keys cannot be empty")
      const verifiedItem = verified.get(item.id)
      if (!verifiedItem) throw new Error(`QuickBooks Product/Service ${item.name ?? item.id} was not verified`)
      return [normalizedAccountId, verifiedItem]
    }),
  )

  await updateAccountingConnectionSettings(
    input.connectionId,
    {
      default_invoice_item: defaultItem,
      invoice_item_mappings: invoiceItemMappings,
    },
    orgId,
  )
  return { defaultItem, incomeAccountMappings: invoiceItemMappings }
}
