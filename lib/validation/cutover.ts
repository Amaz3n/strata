import { z } from "zod"

const signerSchema = z.object({
  name: z.string().trim().min(1, "Name each signer").max(200),
  email: z.string().trim().toLowerCase().email().max(320).nullable(),
})

/** Attaching the executed copy of an imported agreement from the home's documents. */
export const attachAgreementEvidenceSchema = z.object({
  evidenceId: z.string().uuid(),
  fileId: z.string().uuid(),
  signers: z.array(signerSchema).min(1, "Name who signed the agreement").max(20),
  signedOn: z.string().date(),
})

/** Accepting an imported agreement that has no executed copy, with the reason on record. */
export const acceptAgreementEvidenceSchema = z.object({
  evidenceId: z.string().uuid(),
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters").max(2000),
})
