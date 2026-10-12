import { authorize } from "@/lib/services/authorization"
import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"
import { dueCourtesyInspections } from "@/lib/services/warranty/domain"
import { warrantyEffectiveDateSchema } from "@/lib/services/warranty-enrollment"
const coverageSchema = z.object({ id: z.string().uuid(), project_id: z.string().uuid(), effective_date: warrantyEffectiveDateSchema })
const receiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_due") }),
  z.object({ status: z.enum(["created", "existing", "adopted"]), reservation_id: z.string().uuid(), request_id: z.string().uuid(), due_on: warrantyEffectiveDateSchema }),
])
export async function courtesyReservationsEnabled(supabase: SupabaseClient, orgId: string) {
  const flag = await supabase.from("feature_flags").select("enabled,expires_at").eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.warrantyCourtesyReservations).order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (flag.error) throw new Error(`Unable to verify courtesy inspection rollout: ${flag.error.message}`)
  if (flag.data?.enabled === true && flag.data.expires_at) throw new Error("Courtesy inspection reservations cannot use an expiring rollout")
  if (flag.data && typeof flag.data.enabled !== "boolean") throw new Error("Invalid courtesy inspection rollout state")
  if (flag.data?.enabled === true) return true
  const receipt = await supabase.from("warranty_courtesy_reservations").select("id").eq("org_id", orgId).limit(1).maybeSingle()
  if (receipt.error && receipt.error.code !== "42P01" && receipt.error.code !== "PGRST205") throw new Error(`Unable to verify courtesy reservation history: ${receipt.error.message}`)
  if (receipt.data) throw new Error("Restore courtesy inspection reservations before replaying this organization")
  return false
}

export async function authorizeCourtesyHome(input: { supabase: SupabaseClient; orgId: string; userId: string; projectId: string }) {
  const decision = await authorize({ ...input, permission: "warranty.manage" })
  if (!decision.allowed) return false
  const home = await input.supabase.from("projects").select("division_id").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle()
  if (home.error) throw new Error(`Unable to verify courtesy home access: ${home.error.message}`)
  if (!home.data) return false
  return decision.divisionScope !== "assigned" || Boolean(home.data.division_id && decision.divisionIds?.includes(home.data.division_id))
}

/** Keyset pages retain bounded memory and avoid giant project-ID lookup catalogs. */
export async function generateReservedCourtesyInspections(input: {
  supabase: SupabaseClient; orgId: string; asOf: Date; actorId?: string; canCreate?: (projectId: string) => Promise<boolean>
}) {
  const orgId = z.string().uuid().parse(input.orgId)
  const actorId = input.actorId === undefined ? null : z.string().uuid().parse(input.actorId)
  if (actorId && !input.canCreate) throw new Error("Coordinator courtesy scheduling requires home authorization")
  if (!Number.isFinite(input.asOf.getTime())) throw new Error("Invalid courtesy inspection sweep date")
  const asOf = input.asOf.toISOString().slice(0, 10)
  const start = new Date(input.asOf.getTime() - 425 * 86400000).toISOString().slice(0, 10)
  let cursor: string | null = null, created = 0
  for (;;) {
    let query = input.supabase.from("project_warranty_coverage").select("id,project_id,effective_date").eq("org_id", orgId).is("voided_at", null)
      .gte("effective_date", start).lte("effective_date", asOf).order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    const page = await query
    if (page.error) throw new Error(`Unable to read courtesy inspection homes: ${page.error.message}`)
    if (!page.data) throw new Error("Courtesy inspection home page is unavailable")
    const homes = z.array(coverageSchema).max(100).parse(page.data)
    if (!homes.length) break
    if (homes.some((home, index) => (index ? home.id <= homes[index - 1].id : Boolean(cursor && home.id <= cursor)))) throw new Error("Courtesy inspection cursor did not advance")
    // Four concurrent home transactions; milestones on a home remain sequential.
    for (let offset = 0; offset < homes.length; offset += 4) {
      const outcomes = await Promise.allSettled(homes.slice(offset, offset + 4).map(async home => {
        const due = dueCourtesyInspections(home.effective_date, input.asOf)
        if (!due.length || (input.canCreate && !await input.canCreate(home.project_id))) return 0
        let count = 0
        for (const milestone of due) {
          const response = await input.supabase.rpc("reserve_warranty_courtesy_inspection", { p_org_id: orgId, p_coverage_id: home.id, p_milestone: milestone.key, p_as_of: asOf, p_actor_id: actorId })
          if (response.error) throw new Error(`Unable to reserve courtesy inspection: ${response.error.message}`)
          const receipt = receiptSchema.parse(response.data)
          if (receipt.status !== "not_due" && receipt.due_on !== milestone.due_on) throw new Error("Courtesy reservation due date differs from coverage evidence")
          if (receipt.status === "created") count++
        }
        return count
      }))
      let failure: unknown
      for (const result of outcomes) { if (result.status === "fulfilled") created += result.value; else failure ??= result.reason }
      if (failure) throw failure
    }
    cursor = homes[homes.length - 1].id
    if (homes.length < 100) break
  }
  return created
}
