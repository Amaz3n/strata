import { z } from "zod"

const email = z.string().email()

/** Accept pasted address lists, including Name <email> from mail clients. */
export function parseInvoiceRecipients(value: string): string[] {
  const seen = new Set<string>()
  return value.split(/[,;\n]+/).flatMap((entry) => {
    const trimmed = entry.trim()
    if (!trimmed) return []
    const address = (trimmed.match(/<([^<>]+)>/)?.[1] ?? trimmed).trim()
    const key = address.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [address]
  })
}

export function isInvoiceRecipientValid(value: string) {
  return email.safeParse(value).success
}
