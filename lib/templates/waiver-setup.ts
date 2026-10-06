import { templateFields, type WaiverTemplateDraft } from "./waiver-template";
import { documentText, type CustomWaiverField } from "./waiver-document";

export function waiverSetupFields(draft: WaiverTemplateDraft) {
  const doc = draft.document;
  const text =
    doc?.mode === "original"
      ? doc.placements
          .filter((p) => p.kind === "text")
          .map((p) => `{{${p.key}}}`)
          .join(" ")
      : documentText(draft.body, doc);
  const keys = [
    ...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1])),
  ];
  return keys
    .filter((key) => !key.startsWith("item_"))
    .map((key) => {
      const custom = doc?.fields.find((f) => f.key === key);
      return {
        key,
        label:
          custom?.label ??
          templateFields[key as keyof typeof templateFields] ??
          key,
        custom,
        source: custom?.source ?? key,
      };
    });
}

export function waiverConnectionDescription(source: string) {
  const descriptions: Record<string, string> = {
    project_name: "Project → name",
    property_address: "Project → property address",
    owner_name: "Waiver → owner",
    customer_name: "Waiver → customer",
    claimant_name: "Waiver → claimant company",
    company_name: "Waiver → claimant company",
    amount: "Waiver → amount",
    through_date: "Waiver → work through date",
    invoice_number: "Invoice or payable → number",
    exceptions: "Waiver → exceptions",
    signer_name: "Signing → authorized person",
    signer_title: "Signing → title",
    signed_date: "Signing → date signed",
    manual: "Ask when preparing the waiver",
    constant: "Use the same answer every time",
  };
  return descriptions[source] ?? "Connected to Arc";
}

// Changing a built-in connection creates a local alias; Arc's facts remain immutable.
export function connectWaiverField(
  draft: WaiverTemplateDraft,
  key: string,
  connection: Pick<CustomWaiverField, "source" | "value">,
) {
  if (!draft.document)
    throw new Error("Open a document before connecting fields");
  const doc = draft.document;
  const existing = doc.fields.find((f) => f.key === key);
  if (existing)
    return {
      draft: {
        ...draft,
        document: {
          ...doc,
          fields: doc.fields.map((f) =>
            f.key === key ? { ...f, ...connection } : f,
          ),
        },
      },
      key,
    };
  if (connection.source === key) return { draft, key };
  const reserved = new Set([
    ...Object.keys(templateFields),
    ...doc.fields.map((f) => f.key),
  ]);
  let alias = `form_${key}`;
  for (let i = 2; reserved.has(alias); i++) alias = `form_${key}_${i}`;
  const replace = (text: string) =>
    text.split(`{{${key}}}`).join(`{{${alias}}}`);
  const type = ["amount"].includes(key)
    ? "currency"
    : ["through_date", "signed_date"].includes(key)
      ? "date"
      : "text";
  return {
    key: alias,
    draft: {
      ...draft,
      body: replace(draft.body),
      document: {
        ...doc,
        fields: [
          ...doc.fields,
          {
            key: alias,
            label: templateFields[key as keyof typeof templateFields] ?? key,
            type,
            required: true,
            options: [],
            ...connection,
          } as CustomWaiverField,
        ],
        blocks: doc.blocks.map((b) => ({
          ...b,
          text: replace(b.text),
          columns: b.columns.map(replace),
          rows: b.rows.map((r) => r.map(replace)),
          condition:
            b.condition?.field === key
              ? { ...b.condition, field: alias }
              : b.condition,
        })),
        placements: doc.placements.map((p) =>
          p.kind === "text" && p.key === key ? { ...p, key: alias } : p,
        ),
      },
    },
  };
}

export function waiverNotaryFieldKeys(draft: WaiverTemplateDraft) {
  const keys = new Set<string>();
  let inNotarySection = false;
  for (const block of draft.document?.blocks ?? []) {
    if (block.kind === "heading")
      inNotarySection = /notari[sz]|notary/i.test(block.text);
    if (inNotarySection)
      for (const match of [block.text, ...block.columns, ...block.rows.flat()]
        .join(" ")
        .matchAll(/\{\{([^{}]+)\}\}/g))
        keys.add(match[1]);
  }
  // Explicit labels are useful for originals that have no transcribed headings.
  for (const field of draft.document?.fields ?? [])
    if (/notary|notari[sz]|commission expir/i.test(field.label))
      keys.add(field.key);
  return keys;
}

export function waiverReviewGroups(draft: WaiverTemplateDraft) {
  const groups = [
    {
      key: "wording",
      label: "Wording and transcription",
      issues: [] as NonNullable<WaiverTemplateDraft["document"]>["issues"],
    },
    {
      key: "signing",
      label: "Signing and notarization",
      issues: [] as NonNullable<WaiverTemplateDraft["document"]>["issues"],
    },
    {
      key: "original",
      label: "Original document and layout",
      issues: [] as NonNullable<WaiverTemplateDraft["document"]>["issues"],
    },
  ];
  for (const issue of draft.document?.issues ?? []) {
    const group = /notari[sz]|notary|signer|execution/i.test(issue.message)
      ? groups[1]
      : /original mode|blank original|layout|completed.source/i.test(
            issue.message,
          )
        ? groups[2]
        : groups[0];
    group.issues.push(issue);
  }
  return groups.filter((g) => g.issues.length);
}

export function replaceWaiverDocument(
  previous: WaiverTemplateDraft,
  incoming: WaiverTemplateDraft,
): WaiverTemplateDraft {
  if (!incoming.document)
    return {
      ...incoming,
      defaults: previous.defaults,
      reviewed: false,
      status: "draft",
    };
  let retained = 0;
  const normalized = (label: string) => label.trim().toLowerCase();
  let connected = incoming;
  for (const field of waiverSetupFields(incoming)) {
    const type =
      field.custom?.type ??
      (field.key === "amount"
        ? "currency"
        : ["through_date", "signed_date"].includes(field.key)
          ? "date"
          : "text");
    const matches = (previous.document?.fields ?? []).filter(
      (old) =>
        old.type === type && normalized(old.label) === normalized(field.label),
    );
    if (matches.length !== 1) continue;
    const old = matches[0];
    if (
      type === "choice" &&
      old.source === "constant" &&
      !field.custom?.options.includes(old.value)
    )
      continue;
    connected = connectWaiverField(connected, field.key, {
      source: old.source,
      value: old.value,
    }).draft;
    retained++;
  }
  return {
    ...connected,
    name: previous.name,
    defaults: previous.defaults,
    applicability: previous.applicability,
    jurisdiction: previous.jurisdiction,
    status: "draft",
    reviewed: false,
    document: {
      ...connected.document!,
      issues: [
        ...incoming.document.issues,
        {
          id: crypto.randomUUID(),
          message: `Updated PDF: ${retained} matching custom connections retained. Review the new wording, every connection, payment stage, and signing areas before using this revision.`,
          resolved: false,
        },
      ],
    },
  };
}

export function waiverActivationReviewMessage(draft: WaiverTemplateDraft) {
  const remaining = waiverReviewGroups(draft).filter((group) =>
    group.issues.some((issue) => !issue.resolved),
  );
  if (remaining.length)
    return `Review ${remaining.length} import ${remaining.length === 1 ? "section" : "sections"} in “Final review” before using this template.`;
  if (!draft.reviewed)
    return "Confirm the final review checkbox before using this template.";
  return null;
}
