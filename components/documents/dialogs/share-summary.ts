/** One-line plain-English summary of who a file or folder is visible to. */
export function shareSummary(withClients: boolean, withSubs: boolean, owners: string): string {
  const ownerLabel = owners.toLowerCase()
  if (withClients && withSubs) return `Visible to your team, ${ownerLabel}, and subcontractors.`
  if (withClients) return `Visible to your team and ${ownerLabel}.`
  if (withSubs) return "Visible to your team and subcontractors."
  return "Visible to your internal team only."
}
