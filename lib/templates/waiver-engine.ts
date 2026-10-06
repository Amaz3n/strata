import type { WaiverTemplateDraft } from "./waiver-template";
import { templateFields, sampleValues } from "./waiver-template";
import { blockText, type WaiverBlock } from "./waiver-document";

export function resolveWaiverValues(
  template: WaiverTemplateDraft,
  base: Record<string, string>,
  custom: Record<string, string> = {},
  preview = false,
) {
  const values: Record<string, string> = { ...base };
  for (const field of template.document?.fields ?? []) {
    let value =
      field.source === "constant"
        ? field.value
        : field.source === "manual"
          ? (custom[field.key] ?? field.value)
          : (base[field.source] ?? "");
    value = value.trim();
    if (
      value &&
      !/^\[.*\]$/.test(value) &&
      ["manual", "constant"].includes(field.source)
    ) {
      if (field.type === "currency") {
        const raw = value.replace(/[$,]/g, "");
        if (!/^-?\d+(\.\d{1,2})?$/.test(raw) || !Number.isFinite(Number(raw)))
          throw new Error(`Enter a valid amount for ${field.label}`);
        value = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(Number(raw));
      }
      if (field.type === "date") {
        const d = new Date(`${value}T12:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(d.getTime()) ||
          d.toISOString().slice(0, 10) !== value
        )
          throw new Error(`Enter a valid date for ${field.label}`);
        value = d.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
      }
      if (field.type === "choice" && !field.options.includes(value))
        throw new Error(`Choose a valid option for ${field.label}`);
    }
    values[field.key] = value || (preview ? `[${field.label}]` : "");
  }
  return values;
}
export function visibleWaiverBlock(
  block: WaiverBlock,
  values: Record<string, string>,
) {
  if (!block.condition) return true;
  const { field, operator, value } = block.condition;
  const actual = values[field] ?? "";
  const present = !!actual && actual !== "None" && !/^\[.*\]$/.test(actual);
  return operator === "present"
    ? present
    : operator === "equals"
      ? actual === value
      : actual !== value;
}
export function renderWaiverText(
  text: string,
  values: Record<string, string>,
  preview = false,
) {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      if (preview) return `[${key}]`;
      throw new Error(`Unresolved field: ${key}`);
    }
    return value;
  });
}
export function validateWaiverValues(
  template: WaiverTemplateDraft,
  values: Record<string, string>,
) {
  const text =
    template.document?.mode === "editable"
      ? template.document.blocks
          .filter((b) => visibleWaiverBlock(b, values))
          .map(blockText)
          .join("\n")
      : template.document?.mode === "original"
        ? template.document.placements
            .filter((p) => p.kind === "text")
            .map((p) => `{{${p.key}}}`)
            .join(" ")
        : template.body;
  const items = values.covered_items
    ? (JSON.parse(values.covered_items) as Record<string, string>[])
    : [];
  const repeated =
    template.document?.blocks.filter(
      (b) =>
        b.kind === "table" &&
        b.repeat === "covered_items" &&
        visibleWaiverBlock(b, values),
    ) ?? [];
  if (repeated.length && !items.length)
    throw new Error("This template requires covered payment items");
  for (const b of repeated)
    for (const item of items)
      for (const token of blockText(b).matchAll(/\{\{(item_[^{}]+)\}\}/g))
        if (!item[token[1]])
          throw new Error(`Missing ${token[1]} in covered items`);
  const optional = new Set(
    template.document?.fields.filter((f) => !f.required).map((f) => f.key) ??
      [],
  );
  for (const token of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const key = token[1];
    if (key.startsWith("item_") && repeated.length) continue;
    const value = values[key];
    if (!optional.has(key) && (!value?.trim() || /^\[.*\]$/.test(value))) {
      const label =
        template.document?.fields.find((f) => f.key === key)?.label ??
        templateFields[key as keyof typeof templateFields] ??
        key;
      throw new Error(`Enter ${label.toLowerCase()} required by this template`);
    }
  }
  if (
    values.exceptions &&
    values.exceptions !== "None" &&
    !text.includes("{{exceptions}}")
  )
    throw new Error(
      "This template has no exceptions field. Add one before including exceptions.",
    );
}
export function waiverPreviewValues(
  template: WaiverTemplateDraft,
  sample: boolean,
) {
  const base = Object.fromEntries(
    Object.entries(templateFields).map(([key, label]) => [
      key,
      sample ? sampleValues[key as keyof typeof templateFields] : `[${label}]`,
    ]),
  );
  return resolveWaiverValues(template, base, {}, true);
}
export function templateMatches(
  template: WaiverTemplateDraft,
  context: {
    direction: "incoming" | "outgoing";
    jurisdiction?: string;
    projectId?: string | null;
    customerName?: string;
  },
) {
  const direction = template.applicability ?? "outgoing";
  return (
    template.status === "published" &&
    (direction === "both" || direction === context.direction) &&
    (!template.jurisdiction ||
      template.jurisdiction === context.jurisdiction) &&
    (!template.defaults?.projectIds.length ||
      (!!context.projectId &&
        template.defaults.projectIds.includes(context.projectId))) &&
    (!template.defaults?.customerName ||
      template.defaults.customerName.toLowerCase() ===
        context.customerName?.toLowerCase())
  );
}
export function templatePriority(template: WaiverTemplateDraft) {
  return (
    (template.defaults?.projectIds.length ? 8 : 0) +
    (template.defaults?.customerName ? 4 : 0) +
    (template.jurisdiction ? 2 : 0) +
    (template.defaults?.enabled ? 1 : 0)
  );
}

export function waiverSignerRoles(template?: WaiverTemplateDraft): string[] {
  const d = template?.document;
  return [
    ...new Set(
      d?.mode === "original"
        ? d.placements
            .filter((p) => p.kind !== "text")
            .map((p) => p.signerRole ?? "claimant")
        : (d?.blocks
            .filter((b) => b.kind === "signature")
            .map((b) => b.signerRole ?? "claimant") ?? []),
    ),
  ].filter((r) => r !== "claimant");
}
export function validateWaiverSigners(
  template: WaiverTemplateDraft,
  signers: { role: string; name: string; email: string }[] = [],
) {
  const roles = waiverSignerRoles(template);
  if (
    new Set(signers.map((s) => s.role)).size !== signers.length ||
    signers.some((s) => !roles.includes(s.role))
  )
    throw new Error("Signer roles do not match this template");
  for (const role of roles)
    if (!signers.some((s) => s.role === role && s.name && s.email))
      throw new Error(
        `Add the ${role.replaceAll("_", " ")} signer required by this template`,
      );
}

/** An ambiguous match needs a choice; never select a different waiver type. */
export function chooseCompanyWaiver<T extends WaiverTemplateDraft>(
  templates: T[],
  kind: WaiverTemplateDraft["waiverType"],
): T | undefined {
  const matches = templates
    .filter((t) => t.waiverType === kind && t.status === "published")
    .sort((a, b) => templatePriority(b) - templatePriority(a));
  return matches.length === 1 ||
    (matches.length > 1 &&
      templatePriority(matches[0]) > templatePriority(matches[1]))
    ? matches[0]
    : undefined;
}

export function waiverNeedsSigningLinks(template?: WaiverTemplateDraft) {
  return (
    waiverSignerRoles(template).length > 0 ||
    !!template?.document?.placements.some((p) => p.kind === "initials")
  );
}
