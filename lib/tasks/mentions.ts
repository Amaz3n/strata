/** Same @name / @all boundaries as the daily-log composer. Resolve against authorized people only. */
export function resolveTaskMentions(value: string, users: { id: string; name: string }[]): string[] {
  if (/(^|\s)@all(?=\s|$|[.,;:!?])/i.test(value)) return [...new Set(users.map(user => user.id))]
  return [...new Set(users.filter(user => {
    const escaped = user.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[.,;:!?])`, "i").test(value)
  }).map(user => user.id))]
}
