import "server-only";
import { z } from "zod";
import {
  dealProposalSchema,
  EMPTY_DEAL_PROPOSAL,
  estimateProposalSnapshot,
  PROPOSAL_DEFAULT_SETTING_KEYS,
  firstNames,
  normalizeProposalLayout,
  proposalLayoutEntrySchema,
  proposalPaymentSchema,
  proposalSectionKeySchema,
  proposalTemplateFromText,
  splitExclusions,
  type ProposalDefaultField,
  type ProposalNames,
  type ProposalSectionKey,
} from "@/lib/precon/proposal-documents";
import type { PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import { recordAudit } from "./audit";
import { recordEvent } from "./events";
import { requireAnyPermission } from "./permissions";
import { authorizePreconWorkspaceWrite } from "./precon-workspace";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";

type Service = ReturnType<typeof createServiceSupabaseClient>;

/** The proposal columns arrive with a pending migration; until then the tab reads defaults and cannot save. */
const MISSING_SCHEMA = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);

/** Who can change what every new deal starts from: the same people who edit document templates in Settings. */
const DEFAULT_EDITORS = ["org.admin", "billing.manage"];

/** A client's question on one section of the document, and the builder's answer. */
export type ProposalComment = {
  id: string;
  estimateId: string;
  section: ProposalSectionKey | null;
  author: string;
  body: string;
  createdAt: string;
  answer: { body: string; author: string; createdAt: string } | null;
};

/** The comments a deal shows; more than this on one proposal is a meeting, not a thread. */
const COMMENTS_SHOWN = 200;

const sectionSchema = proposalSectionKeySchema;

/**
 * Everything the Proposal tab works from beyond the worksheet: what the builder
 * wrote, what the chosen bids leave out, and the client's comments.
 */
export async function loadDealProposal(input: {
  service: Service;
  orgId: string;
  prospectId: string;
  worksheet: PricingWorksheet | null;
}) {
  const { service, orgId, prospectId, worksheet } = input;
  const quotes = (worksheet?.requests ?? []).flatMap((request) => (request.quote ? [request.quote] : []));
  const [row, submissions, comments, lastSent] = await Promise.all([
    service
      .from("precon_workspaces")
      .select("proposal, proposal_version")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .maybeSingle(),
    quotes.length
      ? service
          .from("bid_submissions")
          .select("id, exclusions")
          .eq("org_id", orgId)
          .in(
            "id",
            quotes.map((quote) => quote.submission_id),
          )
      : Promise.resolve({ data: [], error: null }),
    service
      .from("estimate_comments")
      .select("id, estimate_id, author_type, author_name, body, created_at, metadata, estimate:estimates!inner(prospect_id)")
      .eq("org_id", orgId)
      .eq("estimate.prospect_id", prospectId)
      .eq("kind", "comment")
      .order("created_at", { ascending: true })
      .limit(COMMENTS_SHOWN * 2),
    // What the client has now, so the next send can say what changed.
    service
      .from("estimates")
      .select("version, sent_at, total_cents, metadata, items:estimate_items(description, metadata)")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (lastSent.error) throw new Error(`Unable to load the last version sent: ${lastSent.error.message}`);
  if (submissions.error) throw new Error(`Unable to load the chosen bids: ${submissions.error.message}`);
  if (comments.error) throw new Error(`Unable to load the client's comments: ${comments.error.message}`);
  const available = !row.error || !MISSING_SCHEMA.has(row.error.code ?? "");
  if (row.error && available) throw new Error(`Unable to load the proposal: ${row.error.message}`);
  const parsed = dealProposalSchema.safeParse(row.data?.proposal ?? {});

  const exclusionsById = new Map<string, string | null>(
    (submissions.data ?? []).map((item) => [item.id, item.exclusions]),
  );
  const bids = quotes.map((quote) => ({
    submissionId: quote.submission_id,
    company: quote.company_name,
    exclusions: [
      ...splitExclusions(exclusionsById.get(quote.submission_id)),
      ...quote.gaps.filter((gap) => gap.disposition === "owner_exclusion").map((gap) => gap.description),
    ],
  }));

  const rows = comments.data ?? [];
  const replies = new Map<string, { body: string; author: string; createdAt: string }>();
  for (const comment of rows) {
    const replyTo = comment.metadata?.reply_to;
    if (comment.author_type === "builder" && typeof replyTo === "string")
      replies.set(replyTo, { body: comment.body ?? "", author: comment.author_name ?? "You", createdAt: comment.created_at });
  }
  const threads: ProposalComment[] = rows
    .filter((comment) => comment.author_type === "client" && typeof comment.metadata?.question_id !== "string")
    .slice(-COMMENTS_SHOWN)
    .map((comment) => {
      const section = sectionSchema.safeParse(comment.metadata?.section);
      return {
        id: comment.id,
        estimateId: comment.estimate_id,
        section: section.success ? section.data : null,
        author: comment.author_name ?? "Client",
        body: comment.body ?? "",
        createdAt: comment.created_at,
        answer: replies.get(comment.id) ?? null,
      };
    });

  return {
    available,
    content: parsed.success ? parsed.data : EMPTY_DEAL_PROPOSAL,
    version: z.number().int().catch(0).parse(row.data?.proposal_version),
    bids,
    comments: threads,
    lastSent: lastSent.data ? estimateProposalSnapshot({ ...lastSent.data, items: lastSent.data.items ?? [] }) : null,
  };
}

export type DealProposalData = Awaited<ReturnType<typeof loadDealProposal>>;

async function proposalWriteContext(prospectId: string) {
  const context = await authorizePreconWorkspaceWrite(prospectId);
  if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
    throw new Error("Closed deals are read-only. Reopen a lost deal or continue in the active project.");
  return context;
}

/** Save what the builder wrote, guarded by its own version so the worksheet's autosave never races it. */
export async function saveDealProposal(prospectId: string, input: unknown, expectedVersion: number) {
  const proposal = dealProposalSchema.parse(input);
  z.number().int().nonnegative().parse(expectedVersion);
  const context = await proposalWriteContext(prospectId);
  const { service, orgId, userId } = context;
  const result = await service
    .from("precon_workspaces")
    .update({ proposal, proposal_version: expectedVersion + 1, updated_by: userId })
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .eq("proposal_version", expectedVersion)
    .select("proposal_version")
    .maybeSingle();
  if (result.error && MISSING_SCHEMA.has(result.error.code ?? ""))
    throw new Error("Proposal editing is waiting on a database update. Your changes were not saved.");
  if (result.error) throw new Error(`Unable to save the proposal: ${result.error.message}`);
  if (!result.data)
    throw new Error("The proposal changed in another session. Reload to see the latest before editing.");
  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "prospect",
    entityId: prospectId,
    after: { proposal, proposal_version: expectedVersion + 1 },
  });
  return { version: expectedVersion + 1 };
}

const defaultValueSchemas = {
  cover: z.string().trim().min(1).max(20000),
  terms: z.string().trim().min(1).max(20000),
  allowance_policy: z.string().trim().min(1).max(12000),
  inclusions: z.array(z.string().trim().min(1).max(500)).max(100),
  exclusions: z.array(z.string().trim().min(1).max(500)).max(100),
  payments: z.array(proposalPaymentSchema.omit({ id: true })).min(1).max(24),
  layout: z.array(proposalLayoutEntrySchema).max(40).transform(normalizeProposalLayout),
} satisfies Record<ProposalDefaultField, z.ZodTypeAny>;

const defaultInputSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("cover"), value: defaultValueSchemas.cover }),
  z.object({ field: z.literal("terms"), value: defaultValueSchemas.terms }),
  z.object({ field: z.literal("allowance_policy"), value: defaultValueSchemas.allowance_policy }),
  z.object({ field: z.literal("inclusions"), value: defaultValueSchemas.inclusions }),
  z.object({ field: z.literal("exclusions"), value: defaultValueSchemas.exclusions }),
  z.object({ field: z.literal("payments"), value: defaultValueSchemas.payments }),
  z.object({ field: z.literal("layout"), value: defaultValueSchemas.layout }),
]);

/**
 * "Save as my default": this deal's wording becomes what every new deal starts
 * from. A letter is saved as a template, with this deal's names turned back
 * into fields, so the next client is not greeted by this one's name.
 */
export async function saveProposalDefault(prospectId: string, input: unknown) {
  const parsed = defaultInputSchema.parse(input);
  const context = await proposalWriteContext(prospectId);
  await requireAnyPermission(DEFAULT_EDITORS, context);
  const { service, orgId, userId } = context;
  const value =
    parsed.field === "cover" || parsed.field === "terms"
      ? proposalTemplateFromText(parsed.value, await proposalNames(service, orgId, prospectId, userId))
      : parsed.value;
  const { error } = await service.rpc("save_organization_settings", {
    p_org_id: orgId,
    p_actor_id: userId,
    p_section: "proposal",
    p_org_patch: {},
    p_settings_patch: { [PROPOSAL_DEFAULT_SETTING_KEYS[parsed.field]]: value },
  });
  if (error?.message.includes("Invalid settings input"))
    throw new Error("Saving defaults is waiting on a database update. Nothing was saved.");
  if (error) throw new Error("Unable to save your default. Nothing was saved.");
  return { field: parsed.field };
}

/** The names a template's fields stand for on this deal. */
export async function proposalNames(
  service: Service,
  orgId: string,
  prospectId: string,
  userId: string,
  coSigners?: string[],
): Promise<ProposalNames> {
  const [prospect, org, user, workspace] = await Promise.all([
    service
      .from("prospects")
      .select("name, prospect_contacts(full_name, is_primary)")
      .eq("org_id", orgId)
      .eq("id", prospectId)
      .maybeSingle(),
    service.from("orgs").select("name").eq("id", orgId).maybeSingle(),
    service.from("app_users").select("full_name, email").eq("id", userId).maybeSingle(),
    coSigners === undefined
      ? service.from("precon_workspaces").select("proposal").eq("org_id", orgId).eq("prospect_id", prospectId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (prospect.error || !prospect.data) throw new Error("Deal not found.");
  const contacts = z
    .array(z.object({ full_name: z.string().nullable(), is_primary: z.boolean().nullable() }))
    .catch([])
    .parse(prospect.data.prospect_contacts);
  const primary = contacts.find((contact) => contact.is_primary) ?? contacts[0];
  const saved = dealProposalSchema.safeParse(workspace.data?.proposal ?? {});
  const others = coSigners ?? (saved.success ? saved.data.co_signers.map((signer) => signer.name) : []);
  return {
    client: firstNames([primary?.full_name ?? "", ...others].filter(Boolean)) || "there",
    project: prospect.data.name ?? "your project",
    builder: org.data?.name ?? "",
    sender: user.data?.full_name ?? user.data?.email ?? "",
  };
}

/** Answer a client's comment where they asked it; they see the answer on that section of their link. */
export async function answerProposalComment(prospectId: string, commentId: string, body: string) {
  z.string().uuid().parse(commentId);
  const answer = z.string().trim().min(1, "Write an answer.").max(4000).parse(body);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  const { service, orgId, userId } = context;
  const { data: comment, error } = await service
    .from("estimate_comments")
    .select("id, estimate_id, version_group_id, author_type, metadata, estimate:estimates!inner(prospect_id)")
    .eq("org_id", orgId)
    .eq("id", commentId)
    .eq("estimate.prospect_id", prospectId)
    .maybeSingle();
  if (error) throw new Error(`Unable to load the comment: ${error.message}`);
  if (!comment || comment.author_type !== "client") throw new Error("This comment is not on this deal.");
  const existing = await service
    .from("estimate_comments")
    .select("id")
    .eq("org_id", orgId)
    .eq("estimate_id", comment.estimate_id)
    .contains("metadata", { reply_to: commentId })
    .limit(1);
  if (existing.error) throw new Error(`Unable to check for an earlier answer: ${existing.error.message}`);
  if (existing.data?.length) throw new Error("This comment is already answered.");
  const user = await service.from("app_users").select("full_name, email").eq("id", userId).maybeSingle();
  const { data: inserted, error: insertError } = await service
    .from("estimate_comments")
    .insert({
      org_id: orgId,
      estimate_id: comment.estimate_id,
      version_group_id: comment.version_group_id,
      author_type: "builder",
      author_user_id: userId,
      author_name: user.data?.full_name ?? user.data?.email ?? null,
      kind: "comment",
      body: answer,
      metadata: { reply_to: commentId, section: comment.metadata?.section ?? null },
    })
    .select("id")
    .single();
  if (insertError) throw new Error(`Unable to save the answer: ${insertError.message}`);
  await Promise.all([
    recordEvent({
      orgId,
      eventType: "estimate_comment_added",
      entityType: "estimate",
      entityId: comment.estimate_id,
      payload: { author_type: "builder", reply_to: commentId },
    }),
    recordAudit({
      orgId,
      actorId: userId,
      action: "insert",
      entityType: "estimate_comment",
      entityId: inserted.id,
      after: { reply_to: commentId, body: answer },
    }),
  ]);
  return { id: z.string().parse(inserted.id) };
}
