const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

export function buildPartyDetailsBlock(values: { name?: string | null; email?: string | null; address?: string | null }) {
  const lines: string[] = []
  const pushValue = (value?: string | null) => {
    const normalized = String(value ?? "")
      .split(/\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
    lines.push(...normalized)
  }

  pushValue(values.name)
  pushValue(values.email)
  pushValue(values.address)

  return lines.join("\n")
}

export function parsePartyDetailsBlock(value: string) {
  const lines = String(value ?? "")
    .split(/\n/g)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return { name: "", email: "", address: "" }
  }

  const firstLine = lines[0] ?? ""
  const name = EMAIL_PATTERN.test(firstLine) ? "" : firstLine
  const emailLine = lines.find((line) => EMAIL_PATTERN.test(line))
  const emailMatch = emailLine?.match(EMAIL_PATTERN)
  const email = emailMatch?.[0] ?? ""
  const address = lines
    .slice(name ? 1 : 0)
    .filter((line) => line !== emailLine)
    .join("\n")

  return { name, email, address }
}
