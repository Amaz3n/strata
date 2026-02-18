export function escapeQboQueryLiteral(value: string): string {
  return value.replace(/'/g, "''")
}
