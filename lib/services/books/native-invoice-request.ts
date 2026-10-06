import { z } from "zod";
import { nativeInvoiceEconomicSchema } from "./native-invoice-economics";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const expected = { expectedOrgId: uuid, expectedActorId: uuid };
export const nativeInvoicePostingRequestSchema = z
  .object({
    ...expected,
    id: uuid,
    entryId: uuid,
    economic: nativeInvoiceEconomicSchema,
    notes: z.string().trim().min(10).max(2000),
  })
  .strict()
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v.economic)) <= 4194304,
    "Native invoice economic request exceeds the supported size",
  );
