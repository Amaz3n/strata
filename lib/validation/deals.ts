import { z } from "zod";

/** A deal starts from one field. Everything else is asked when it first matters. */
export const newDealInputSchema = z.object({
  name: z.string().trim().min(2, "Name the deal or the client").max(200),
});

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
