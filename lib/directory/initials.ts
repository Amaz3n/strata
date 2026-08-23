/**
 * Initials for an avatar tile. Shared because the list and the account header
 * must produce the same two letters for the same party — a person whose tile
 * changes between the row and the page they opened reads as a different record.
 */
export function initialsFor(value: string) {
  const parts = value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}
