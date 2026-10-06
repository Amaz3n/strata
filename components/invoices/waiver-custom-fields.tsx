"use client";
import { waiverSignerRoles } from "@/lib/templates/waiver-engine";
import { Input } from "@/components/ui/input";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
export function WaiverCustomFields({
  template,
  values,
  onChange,
}: {
  template?: WaiverTemplateDraft;
  values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const fields =
    template?.document?.fields.filter((f) => f.source === "manual") ?? [];
  if (!fields.length) return null;
  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-xs font-medium">Details required by this form</p>
      {fields.map((f) => (
        <label key={f.key} className="block space-y-1.5 text-xs">
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          {f.type === "choice" ? (
            <select
              className="h-9 w-full border bg-background px-3"
              required={f.required}
              value={values?.[f.key] ?? f.value}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
            >
              <option value="">Choose…</option>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <Input
              required={f.required}
              type={f.type === "date" ? "date" : "text"}
              inputMode={f.type === "currency" ? "decimal" : undefined}
              value={values?.[f.key] ?? f.value}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
    </div>
  );
}

export function WaiverAdditionalSigners({
  template,
  values = [],
  onChange,
}: {
  template?: WaiverTemplateDraft;
  values?: { role: string; name: string; email: string }[];
  onChange: (v: { role: string; name: string; email: string }[]) => void;
}) {
  const roles = waiverSignerRoles(template);
  if (!roles.length) return null;
  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-xs font-medium">Additional signers</p>
      {roles.map((role) => {
        const signer = values.find((s) => s.role === role) ?? {
          role,
          name: "",
          email: "",
        };
        const patch = (v: Partial<typeof signer>) =>
          onChange([
            ...values.filter((s) => s.role !== role),
            { ...signer, ...v },
          ]);
        return (
          <div className="space-y-2" key={role}>
            <p className="text-xs capitalize">{role.replaceAll("_", " ")}</p>
            <Input
              aria-label={`${role} name`}
              placeholder="Full name"
              value={signer.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <Input
              aria-label={`${role} email`}
              type="email"
              placeholder="Email"
              value={signer.email}
              onChange={(e) => patch({ email: e.target.value })}
            />
          </div>
        );
      })}
      <p className="text-xs leading-5 text-muted-foreground">
        Each person receives their own secure signing link. Notarization, when
        required, must be arranged through an appropriate notarial process.
      </p>
    </div>
  );
}
