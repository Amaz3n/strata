import { z } from "zod"

export const warrantyTechQueueSchema = z.object({
  date: z.string().date(), userId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(2048).optional(), pageSize: z.number().int().min(1).max(100).default(100),
})
const cursorSchema = z.object({
  version: z.literal(1), orgId: z.string().uuid(), actorId: z.string().uuid(), userId: z.string().uuid(), date: z.string().date(),
  window_start: z.string().datetime({ offset: true }), id: z.string().uuid(),
}).strict()
export type WarrantyTechCursorScope = { orgId: string; actorId: string; userId: string; date: string }
export function decodeWarrantyTechCursor(cursor: string | undefined, scope: WarrantyTechCursorScope) {
  if (!cursor) return null
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048) throw new Error()
    const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
    if (value.orgId !== scope.orgId || value.actorId !== scope.actorId || value.userId !== scope.userId || value.date !== scope.date) throw new Error()
    return value
  } catch { throw new Error("Invalid warranty technician queue cursor") }
}
export function encodeWarrantyTechCursor(scope: WarrantyTechCursorScope, row: { id: string; window_start: string }) {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ version: 1, ...scope, ...row }))).toString("base64url")
}
