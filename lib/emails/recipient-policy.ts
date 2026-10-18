/** Reserved documentation domains cannot receive transactional email. */
export function isPlaceholderEmail(value: string): boolean {
  const address = value.trim().match(/<([^<>]+)>$/)?.[1] ?? value.trim()
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase()
  return ["example.com", "example.net", "example.org"].some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  ) || /\.(test|invalid|example)$/.test(domain)
}
