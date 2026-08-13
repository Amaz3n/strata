import { redirect } from "next/navigation"
import { connection } from "next/server"
export const instant = false

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

export default async function LegacyRfiEmailPreviewPage({ searchParams }: { searchParams: SearchParams }) {
  await connection()
  const resolvedSearchParams = await searchParams
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    const first = firstValue(value)
    if (typeof first === "string") params.set(key, first)
  }

  params.set("template", "rfi-notification")
  redirect(`/emails/preview?${params.toString()}`)
}
