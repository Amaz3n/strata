import { z } from "zod";
import { ACTIVITY_KINDS } from "@/lib/sales/activity";
import { TIMEFRAMES } from "@/lib/sales/registration-options";

/** How a custom-build client found the builder. Stored on `prospects.source`. */
export const DEAL_SOURCES = ["Referral", "Past client", "Website", "Architect", "Realtor", "Social media", "Other"] as const;

/** The band a client names before anything is priced. Stored on `prospects.budget_range`. */
export const DEAL_BUDGETS = ["Under $250K", "$250–500K", "$500K–1M", "$1–2M", "$2–4M", "Over $4M"] as const;

const optionalText = (max: number) => z.string().trim().max(max).default("");

/** Who the deal is for: a person already in the directory, or one the deal adds to it. */
export const dealClientChoiceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing"),
    contact_id: z.string().uuid(),
    name: z.string().trim().min(2).max(200),
  }),
  z.object({
    kind: z.literal("new"),
    full_name: z.string().trim().min(2, "Enter the client's name").max(200),
    email: z.string().trim().email("Enter a valid email").or(z.literal("")).default(""),
    phone: optionalText(50),
    company_name: optionalText(200),
  }),
]);
export type DealClientChoice = z.infer<typeof dealClientChoiceSchema>;

/** Most clients name a band; some name a number. Either is stored as the deal's stated budget. */
export const dealBudgetChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("band"), band: z.enum(DEAL_BUDGETS) }),
  z.object({ kind: z.literal("amount"), cents: z.number().int().positive().max(100_000_000_000) }),
]);

/** A rough window, or the date they want to start by. */
export const dealTimeframeChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("band"), band: z.enum(TIMEFRAMES) }),
  z.object({ kind: z.literal("date"), date: z.string().date() }),
]);

/**
 * A deal starts from who it is for. The rest is the first phone call: who the
 * client is, where the site is, notes, and roughly how much and when.
 */
export const newDealInputSchema = z.object({
  name: z.string().trim().min(2, "Name the deal or the client").max(200),
  client: dealClientChoiceSchema.nullable().default(null),
  street: optionalText(200),
  city: optionalText(120),
  state: optionalText(60),
  postal_code: optionalText(20),
  notes: optionalText(10000),
  source: z.enum(DEAL_SOURCES).nullable().default(null),
  /** What "Other" means, in the words of whoever took the call. */
  source_detail: optionalText(120),
  budget: dealBudgetChoiceSchema.nullable().default(null),
  timeframe: dealTimeframeChoiceSchema.nullable().default(null),
  owner_user_id: z.string().uuid().nullable().default(null),
});
export type NewDealInput = z.input<typeof newDealInputSchema>;

export const dealNotesInputSchema = z.string().max(10000);

export const dealClientInputSchema = z.object({
  name: z.string().trim().min(2, "Name the deal").max(200),
  client_name: z.string().trim().min(2, "Enter the client's name").max(200),
  email: z.string().trim().email("Enter a valid email").or(z.literal("")),
  phone: z.string().trim().max(50),
  street: z.string().trim().max(200),
  city: z.string().trim().max(120),
  state: z.string().trim().max(60),
  postal_code: z.string().trim().max(20),
});
export type DealClientInput = z.infer<typeof dealClientInputSchema>;

/** Where a price starts. Mirrors `DealPriceStart` in lib/services/precon-deals.ts. */
export const dealPriceStartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blank") }),
  z.object({ kind: z.literal("plans") }),
  z.object({ kind: z.literal("template"), templateId: z.string().uuid() }),
  z.object({ kind: z.literal("deal"), dealId: z.string().uuid() }),
]);

export const dealPriceSourceSearchSchema = z.string().trim().max(120);

/** The next touch: a day, and what it is for. */
export const dealFollowUpInputSchema = z.object({
  on: z.string().date(),
  note: z.string().trim().max(500),
});
export type DealFollowUpInput = z.infer<typeof dealFollowUpInputSchema>;

/**
 * A logged conversation. It may close the open follow-up and leave the next
 * one, in the same entry, because that is how the call actually went.
 */
export const dealLogInputSchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  note: z.string().trim().max(2000),
  /** The day it happened, when it was not today. */
  occurred_on: z.string().date().nullable(),
  complete_follow_up: z.boolean(),
  follow_up: dealFollowUpInputSchema.nullable(),
});
export type DealLogInput = z.infer<typeof dealLogInputSchema>;

export const dealFollowUpOutcomeSchema = z.enum(["done", "cleared"]);

export const dealOwnerInputSchema = z.string().uuid().nullable();

export const dealQuestionInputSchema = z.string().trim().min(3, "Write the question").max(200);

export const dealAnswerInputSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  // A resolved decision records at least a few characters of rationale.
  answer: z.string().trim().min(3, "Write the client's answer").max(6000),
});

export const DEAL_LOST_REASONS = [
  "Price was too high",
  "Went with another builder",
  "Timing or financing",
  "Project cancelled",
] as const;
export const dealLostInputSchema = z.enum(DEAL_LOST_REASONS);
