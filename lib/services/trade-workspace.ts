import "server-only";
import { defaultTradeJobType } from "@/lib/business-profile";
import { z } from "zod";
import type { OrgServiceContext } from "@/lib/services/context";
import { requireTradeContext } from "@/lib/services/business-profile";
import {
  createProject,
  resolveVisibleProjectIds,
} from "@/lib/services/projects";
import {
  hasPermission,
  hasAnyPermission,
  requirePermission,
  requireProjectPermission,
} from "@/lib/services/permissions";
import { createScheduleItem } from "@/lib/services/schedule";
import { scheduleItemInputSchema } from "@/lib/validation/schedule";
import { tradeJobSchema, tradeWorkSchema } from "@/lib/trade/workspace";
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status";

const projectRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  description: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
});
const workRow = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  status: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  assigned_to: z.string().nullable(),
  planned_hours: z.coerce.number().nullable(),
});
const invoiceRow = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  invoice_number: z.string().nullable(),
  due_date: z.string().nullable(),
  balance_due_cents: z.number(),
  currency: z.string(),
});
const contactRow = z.object({
  id: z.string(),
  full_name: z.string(),
  email: z.string().nullable(),
});
const memberRow = z.object({
  user_id: z.string(),
  user: z
    .object({ full_name: z.string().nullable(), email: z.string() })
    .nullable(),
});

async function readTradeCustomers(
  context: OrgServiceContext,
  canManage: boolean,
  canDirectory: boolean,
) {
  if (!canManage || !canDirectory)
    return { contacts: [], contactsTotal: 0, canManage };
  const { data, count, error } = await context.supabase
    .from("contacts")
    .select("id,full_name,email", { count: "exact" })
    .eq("org_id", context.orgId)
    .order("full_name")
    .order("id")
    .limit(200);
  if (error) throw new Error("Unable to load your customers.");
  return {
    contacts: z.array(contactRow).parse(data ?? []),
    contactsTotal: count ?? 0,
    canManage,
  };
}

export async function getTradeJobCustomers() {
  const context = await requireTradeContext();
  const [canManage, canDirectory] = await Promise.all([
    hasPermission("project.manage", context),
    hasPermission("directory.read", context),
  ]);
  return readTradeCustomers(context, canManage, canDirectory);
}

export async function getTradeWorkspace() {
  const context = await requireTradeContext();
  const { supabase, orgId } = context;
  const [
    visibleIds,
    canSchedule,
    canBill,
    canManage,
    canDirectory,
    canEditSchedule,
    canTime,
    canChanges,
    canSetup,
    canPipeline,
  ] = await Promise.all([
    resolveVisibleProjectIds({ ...context, includePrecon: false }),
    hasPermission("schedule.read", context),
    hasPermission("invoice.read", context),
    hasPermission("project.manage", context),
    hasPermission("directory.read", context),
    hasPermission("schedule.edit", context),
    hasAnyPermission(["time.read", "time.write"], context),
    hasPermission("change_order.read", context),
    hasPermission("org.admin", context),
    hasAnyPermission(["pipeline.read", "pipeline.write"], context),
  ]);
  let jobsQuery = supabase
    .from("projects")
    .select("id,name,status,description,start_date,end_date", {
      count: "exact",
    })
    .eq("org_id", orgId)
    .eq("phase", "delivery")
    .not("status", "in", "(completed,cancelled)")
    .order("start_date", { nullsFirst: false })
    .order("id")
    .limit(200);
  if (visibleIds) jobsQuery = jobsQuery.in("id", visibleIds);
  const jobsResult =
    visibleIds?.length === 0
      ? { data: [], error: null, count: 0 }
      : await jobsQuery;
  if (jobsResult.error) throw new Error("Unable to load your jobs.");
  const jobs = z.array(projectRow).parse(jobsResult.data ?? []);
  const jobIds = jobs.map((job) => job.id);
  const [workResult, invoiceResult, contactsResult, membersResult] =
    await Promise.all([
      canSchedule && jobIds.length
        ? supabase
            .from("schedule_items")
            .select(
              "id,project_id,name,status,start_date,end_date,assigned_to,planned_hours",
              { count: "exact" },
            )
            .eq("org_id", orgId)
            .in("project_id", jobIds)
            .not("status", "in", "(completed,cancelled)")
            .order("start_date", { nullsFirst: false })
            .order("id")
            .limit(200)
        : { data: [], error: null, count: 0 },
      canBill && visibleIds?.length !== 0
        ? (() => {
            let query = supabase
              .from("invoices")
              .select(
                "id,project_id,invoice_number,due_date,balance_due_cents,currency",
                { count: "exact" },
              )
              .eq("org_id", orgId)
              .in("status", [...BILLED_INVOICE_STATUSES])
              .gt("balance_due_cents", 0)
              .order("due_date", { nullsFirst: false })
              .order("id")
              .limit(50);
            if (visibleIds) query = query.in("project_id", visibleIds);
            return query;
          })()
        : { data: [], error: null, count: 0 },
      readTradeCustomers(context, canManage, canDirectory),
      canSchedule
        ? supabase
            .from("memberships")
            .select(
              "user_id,user:app_users!memberships_user_id_fkey(full_name,email)",
              { count: "exact" },
            )
            .eq("org_id", orgId)
            .eq("status", "active")
            .order("user_id")
            .limit(200)
        : { data: [], error: null, count: 0 },
    ]);
  if ([workResult, invoiceResult, membersResult].some((result) => result.error))
    throw new Error("Unable to load your work. Please try again.");
  return {
    profile: context.profile,
    defaultJobType: defaultTradeJobType(context.productTier),
    jobs,
    jobsTotal: jobsResult.count ?? jobs.length,
    work: z.array(workRow).parse(workResult.data ?? []),
    workTotal: workResult.count ?? 0,
    invoices: z.array(invoiceRow).parse(invoiceResult.data ?? []),
    invoicesTotal: invoiceResult.count ?? 0,
    contacts: contactsResult.contacts,
    contactsTotal: contactsResult.contactsTotal,
    members: z.array(memberRow).parse(membersResult.data ?? []),
    membersTotal: membersResult.count ?? 0,
    canSchedule,
    canBill,
    canManage,
    canEditSchedule,
    canTime,
    canChanges,
    canSetup,
    canPipeline,
  };
}
export type TradeWorkspace = Awaited<ReturnType<typeof getTradeWorkspace>>;

export async function createTradeJob(input: unknown) {
  const data = tradeJobSchema.parse(input);
  const context = await requireTradeContext();
  await requirePermission("project.manage", context);
  if (data.client_id) {
    const { data: contact, error } = await context.supabase
      .from("contacts")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("id", data.client_id)
      .maybeSingle();
    if (error || !contact)
      throw new Error("Choose a customer from your company directory.");
  }
  const project = await createProject({
    context,
    input: {
      ...data,
      status: "active",
      phase: "delivery",
      retainage_percent: 0,
      project_type: "new_construction",
      open_book: false,
      requires_client_cost_approval: false,
      contract_type:
        data.billing_model === "time_and_materials"
          ? "time_materials"
          : "fixed",
    },
  });
  return { id: project.id };
}

export async function scheduleTradeWork(input: unknown) {
  const data = tradeWorkSchema.parse(input);
  const context = await requireTradeContext();
  await requireProjectPermission(
    context.userId,
    data.project_id,
    "schedule.edit",
  );
  // Project authorization alone must never allow a foreign org's job into this workspace.
  const { data: project, error: projectError } = await context.supabase
    .from("projects")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", data.project_id)
    .maybeSingle();
  if (projectError || !project)
    throw new Error("This job is not in your company workspace.");
  if (data.assigned_to) {
    const { data: member, error } = await context.supabase
      .from("memberships")
      .select("user_id")
      .eq("org_id", context.orgId)
      .eq("user_id", data.assigned_to)
      .eq("status", "active")
      .maybeSingle();
    if (error || !member)
      throw new Error("Choose an active member of your company.");
  }
  return createScheduleItem({
    input: scheduleItemInputSchema.parse({
      ...data,
      trade: context.profile.specialty.toLowerCase(),
      metadata: { notes: data.notes },
    }),
  });
}
