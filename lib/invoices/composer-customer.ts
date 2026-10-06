/** Existing documents keep their billing party; new invoices inherit the project customer. */
export function resolveInvoiceInitialCustomer<T extends { id: string }>(
  contacts: T[],
  { hasSeed, explicitId, projectCustomerId }: { hasSeed: boolean; explicitId?: string | null; projectCustomerId?: string | null },
): T | null {
  if (hasSeed) return null
  const id = explicitId ?? projectCustomerId
  return contacts.find(contact => contact.id === id) ?? null
}
