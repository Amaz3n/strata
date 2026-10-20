import "server-only";
import { cache } from "react";
import { z } from "zod";
import {
  businessProfileSchema,
  isTradeProfile,
  resolveBusinessProfile,
} from "@/lib/business-profile";
import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";
import { recordEvent } from "@/lib/services/events";
import { recordAudit } from "@/lib/services/audit";

export const getBusinessProfile = cache(async () => {
  const { supabase, orgId } = await requireOrgContext(undefined, {
    allowLocked: true,
  });
  const { data, error } = await supabase
    .from("org_settings")
    .select("settings")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error("Unable to load the company workspace.");
  return resolveBusinessProfile(
    z.record(z.unknown()).parse(data?.settings ?? {}),
  );
});

export async function requireTradeContext() {
  const [context, profile] = await Promise.all([
    requireOrgContext(),
    getBusinessProfile(),
  ]);
  if (!isTradeProfile(profile))
    throw new Error("Enable Arc Trade in Company setup first.");
  return { ...context, profile };
}

export async function saveBusinessProfile(input: unknown) {
  const profile = businessProfileSchema.parse(input);
  const context = await requireOrgContext();
  await requirePermission("org.admin", context);
  const { supabase, orgId, userId } = context;
  const { data: current, error: readError } = await supabase
    .from("org_settings")
    .select("settings,updated_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) throw new Error("Unable to load the company settings.");
  const before = z.record(z.unknown()).parse(current?.settings ?? {});
  const settings = { ...before, business_profile: profile };
  // Compare-and-swap avoids overwriting concurrent changes in the shared bag.
  const result = current
    ? await supabase
        .from("org_settings")
        .update({ settings, updated_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("updated_at", current.updated_at)
        .select("org_id")
    : await supabase
        .from("org_settings")
        .insert({ org_id: orgId, settings })
        .select("org_id");
  if (result.error || !result.data?.length)
    throw new Error("Company settings changed. Reload and try again.");
  await Promise.all([
    recordEvent({
      orgId,
      eventType: "business_profile_updated",
      entityType: "org_settings",
      entityId: orgId,
      payload: { business_profile: profile },
    }),
    recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "org_settings",
      entityId: orgId,
      before,
      after: settings,
    }),
  ]);
  return profile;
}
