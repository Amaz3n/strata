export const WAIVER_SIGNATURE_CONSENT =
  "I agree to use electronic records and signatures for this document, I can access and retain the document electronically, and I intend my electronic signature to be legally binding.";

export function selfSignatureValues(
  fields: {
    id: string;
    field_type: string;
    signer_role: string | null;
    required: boolean;
  }[],
  signature: string,
  consent: boolean,
  date: string,
): Record<string, string> {
  if (consent !== true)
    throw new Error("Agree to electronic signing before signing this waiver");
  if (
    typeof signature !== "string" ||
    signature.length > 500_000 ||
    !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(signature)
  ) {
    throw new Error("Add your signature before signing this waiver");
  }
  const values: Record<string, string> = {};
  const own = fields.filter(
    (field) => !field.signer_role || field.signer_role === "claimant",
  );
  if (!own.some((field) => field.field_type === "signature"))
    throw new Error("This waiver has no signature field");
  for (const field of own) {
    if (field.field_type === "signature") values[field.id] = signature;
    else if (field.field_type === "date") values[field.id] = date;
    else if (field.required)
      throw new Error("This waiver requires additional signing fields");
  }
  return values;
}
