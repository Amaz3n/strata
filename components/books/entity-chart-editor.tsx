"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  constructionEntityChart,
  entityChartDefinitionSchema,
  ENTITY_CONTROL_ROLES,
} from "@/lib/services/books/entity-chart";
import { ENTITY_CHART_CLASSIFICATIONS_V1 } from "@/lib/services/books/entity-chart-policy-v1";
import {
  readBooksEntityChartEditorContextAction,
  readBooksEntityChartAction,
  prepareBooksEntityChartAction,
} from "@/app/(app)/books/actions";
type Definition = z.infer<typeof entityChartDefinitionSchema>;
type Context = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").readBooksEntityChartEditorContext
  >
>;
/** A code rename preserves references in the draft; committed canonical IDs remain immutable. */
export function renameChartAccount(
  definition: Definition,
  index: number,
  code: string,
): Definition {
  const old = definition.accounts[index].code;
  return {
    ...definition,
    accounts: definition.accounts.map((a, i) => ({
      ...a,
      code: i === index ? code : a.code,
      parent_code: old && a.parent_code === old ? code : a.parent_code,
    })),
    controls: Object.fromEntries(
      Object.entries(definition.controls).map(([r, c]) => [
        r,
        old && c === old ? code : c,
      ]),
    ),
  };
}
export function BooksEntityChartEditor({
  entityId,
  today,
  onPrepared,
}: {
  entityId: string;
  today: string;
  onPrepared: () => Promise<void>;
}) {
  const [context, setContext] = useState<Context | null>(null),
    [definition, setDefinition] = useState<Definition | null>(null),
    [error, setError] = useState(""),
    [pending, start] = useTransition();
  const intent = useRef<{ body: string; id: string } | null>(null);
  async function initial(live: () => boolean) {
    try {
      const r = await readBooksEntityChartEditorContextAction({ entityId });
      if (!live()) return;
      if (!r.success) {
        setContext(null);
        setDefinition(null);
        setError(r.error);
        return;
      }
      let d = constructionEntityChart();
      if (r.data.latestReviewedChartId) {
        const old = await readBooksEntityChartAction({
          entityId,
          chartId: r.data.latestReviewedChartId,
        });
        if (!live()) return;
        if (!old.success) {
          setContext(null);
          setDefinition(null);
          setError(old.error);
          return;
        }
        if (!old.data.review) {
          setError(
            "The reviewed chart changed. Refresh before preparing a revision.",
          );
          return;
        }
        d = entityChartDefinitionSchema.parse(
          JSON.parse(old.data.chart.definition_text),
        );
      }
      setContext(r.data);
      setDefinition(d);
      setError("");
    } catch {
      if (live()) {
        setContext(null);
        setDefinition(null);
        setError("Chart preparation could not load. Refresh to retry.");
      }
    }
  }
  useEffect(() => {
    let live = true;
    void initial(() => live);
    return () => {
      live = false;
    };
  }, [entityId]);
  const update = (
    index: number,
    patch: Partial<Definition["accounts"][number]>,
  ) => {
    if (definition)
      setDefinition({
        ...definition,
        accounts: definition.accounts.map((a, i) =>
          i === index ? { ...a, ...patch } : a,
        ),
      });
  };
  const classifications = ENTITY_CHART_CLASSIFICATIONS_V1 as Record<
    string,
    {
      account_type: Definition["accounts"][number]["account_type"];
      normal_balance: Definition["accounts"][number]["normal_balance"];
    }
  >;
  return (
    <details className="border p-4">
      <summary className="cursor-pointer font-semibold">
        Prepare or revise entity chart
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Edit accounts and control mappings, retain your reasons, then submit a
          new version for independent review. Revisions start from the latest
          reviewed chart.
        </p>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => start(() => initial(() => true))}
        >
          Reload reviewed chart
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {context && definition && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const validated =
                entityChartDefinitionSchema.safeParse(definition);
              if (!validated.success) {
                setError(validated.error.issues[0].message);
                return;
              }
              const body = {
                  entityId,
                  profileId: String(data.get("profile")),
                  previousChartId: context.latestReviewedChartId,
                  effectiveOn: String(data.get("effective")),
                  definition: validated.data,
                  notes: String(data.get("notes")).trim(),
                },
                text = JSON.stringify(body);
              if (intent.current?.body !== text)
                intent.current = { body: text, id: crypto.randomUUID() };
              const id = intent.current.id;
              start(async () => {
                try {
                  const r = await prepareBooksEntityChartAction({
                    ...body,
                    chartId: id,
                  });
                  if (!r.success) {
                    setError(r.error);
                    return;
                  }
                  setError("");
                  toast.success("Chart prepared for independent review");
                  await onPrepared();
                  await initial(() => true);
                } catch {
                  setError(
                    "Preparation outcome is uncertain. Retry the unchanged form to recover its receipt.",
                  );
                }
              });
            }}
          >
            <fieldset disabled={pending} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`chart-profile-${entityId}`}>
                    Reviewed legal identity
                  </Label>
                  <select
                    id={`chart-profile-${entityId}`}
                    name="profile"
                    required
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {context.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.legal_name} · revision {p.revision} · effective{" "}
                        {p.effective_on}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`chart-date-${entityId}`}>
                    Effective date
                  </Label>
                  <Input
                    id={`chart-date-${entityId}`}
                    name="effective"
                    type="date"
                    defaultValue={today}
                    min={
                      context.latestReviewedEffectiveOn
                        ? new Date(
                            Date.parse(
                              context.latestReviewedEffectiveOn + "T00:00:00Z",
                            ) + 86400000,
                          )
                            .toISOString()
                            .slice(0, 10)
                        : "1900-01-01"
                    }
                    max="9997-12-31"
                    required
                  />
                </div>
              </div>
              {context.nextProfileCursor && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      try {
                        const r = await readBooksEntityChartEditorContextAction(
                          {
                            entityId,
                            before: context.nextProfileCursor!,
                          },
                        );
                        if (!r.success) {
                          setContext(null);
                          setDefinition(null);
                          setError(r.error);
                          return;
                        }
                        if (
                          r.data.latestReviewedChartId !==
                          context.latestReviewedChartId
                        ) {
                          setContext(null);
                          setDefinition(null);
                          setError(
                            "Reviewed chart changed. Reload to prepare against its current version.",
                          );
                          return;
                        }
                        setContext({
                          ...r.data,
                          profiles: [...context.profiles, ...r.data.profiles],
                        });
                      } catch {
                        setError(
                          "Older reviewed identities could not load. Retry.",
                        );
                      }
                    })
                  }
                >
                  Load older reviewed identities
                </Button>
              )}
              <div className="max-h-[32rem] overflow-auto border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background">
                    <tr>
                      <th className="p-2 text-left">Account</th>
                      <th className="p-2 text-left">Classification</th>
                      <th className="p-2 text-left">Hierarchy / cash flow</th>
                      <th className="p-2">Remove</th>
                    </tr>
                  </thead>
                  <tbody>
                    {definition.accounts.map((a, i) => (
                      <tr key={i} className="border-t">
                        <td className="space-y-2 p-2">
                          <Input
                            aria-label={`Account ${i + 1} code`}
                            value={a.code}
                            maxLength={32}
                            required
                            onChange={(e) =>
                              setDefinition(
                                renameChartAccount(
                                  definition,
                                  i,
                                  e.target.value,
                                ),
                              )
                            }
                          />
                          <Input
                            aria-label={`Account ${i + 1} name`}
                            value={a.name}
                            maxLength={160}
                            minLength={2}
                            required
                            onChange={(e) =>
                              update(i, { name: e.target.value })
                            }
                          />
                        </td>
                        <td className="space-y-2 p-2">
                          <select
                            aria-label={`Account ${i + 1} classification`}
                            className="h-9 w-full rounded-md border bg-background px-2"
                            value={a.subtype}
                            onChange={(e) => {
                              const subtype = e.target.value;
                              update(i, {
                                subtype,
                                ...classifications[subtype],
                              });
                            }}
                          >
                            {Object.keys(classifications).map((s) => (
                              <option key={s} value={s}>
                                {s.replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                          <p>
                            {a.account_type} · {a.normal_balance}
                          </p>
                        </td>
                        <td className="space-y-2 p-2">
                          <Input
                            aria-label={`Account ${i + 1} parent`}
                            list={`chart-parents-${entityId}-${a.account_type}`}
                            placeholder="No parent"
                            value={a.parent_code ?? ""}
                            onChange={(e) =>
                              update(i, { parent_code: e.target.value || null })
                            }
                          />
                          <select
                            aria-label={`Account ${i + 1} cash flow`}
                            className="h-9 w-full rounded-md border bg-background px-2"
                            value={a.cash_flow_category ?? ""}
                            onChange={(e) =>
                              update(i, {
                                cash_flow_category: (e.target.value ||
                                  null) as typeof a.cash_flow_category,
                              })
                            }
                          >
                            {[
                              "",
                              "cash",
                              "operating",
                              "investing",
                              "financing",
                            ].map((c) => (
                              <option key={c} value={c}>
                                {c || "Unclassified"}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={
                              pending ||
                              definition.accounts.length === 1 ||
                              Object.values(definition.controls).includes(
                                a.code,
                              ) ||
                              definition.accounts.some(
                                (p) => p.parent_code === a.code,
                              )
                            }
                            onClick={() =>
                              setDefinition({
                                ...definition,
                                accounts: definition.accounts.filter(
                                  (_, j) => j !== i,
                                ),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={pending || definition.accounts.length >= 1000}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    accounts: [
                      ...definition.accounts,
                      {
                        code: "",
                        name: "",
                        account_type: "expense",
                        subtype: "other_expense",
                        normal_balance: "debit",
                        cash_flow_category: "operating",
                        parent_code: null,
                      },
                    ],
                  })
                }
              >
                Add account
              </Button>
              <details className="border p-3">
                <summary className="cursor-pointer font-medium">
                  Control mappings
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {Object.entries(ENTITY_CONTROL_ROLES).map(
                    ([role, expected]) => (
                      <div key={role}>
                        <Label htmlFor={`control-${entityId}-${role}`}>
                          {role.replace(/([A-Z])/g, " $1")}
                        </Label>
                        <select
                          id={`control-${entityId}-${role}`}
                          required
                          className="h-9 w-full rounded-md border bg-background px-2"
                          value={definition.controls[role] ?? ""}
                          onChange={(e) =>
                            setDefinition({
                              ...definition,
                              controls: {
                                ...definition.controls,
                                [role]: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">Choose account</option>
                          {definition.accounts
                            .filter(
                              (a) =>
                                a.subtype === expected.subtype &&
                                a.account_type === expected.account_type &&
                                a.normal_balance === expected.normal_balance,
                            )
                            .map((a) => (
                              <option key={a.code} value={a.code}>
                                {a.code} · {a.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    ),
                  )}
                </div>
              </details>
              <Label htmlFor={`chart-reasons-${entityId}`}>
                Preparation notes and reasons for changes
              </Label>
              <Textarea
                id={`chart-reasons-${entityId}`}
                name="notes"
                minLength={10}
                maxLength={2000}
                required
              />
              <Button disabled={pending || context.profiles.length === 0}>
                Prepare chart for review
              </Button>
              {["asset", "liability", "equity", "income", "expense"].map(
                (type) => (
                  <datalist key={type} id={`chart-parents-${entityId}-${type}`}>
                    {definition.accounts
                      .filter((a) => a.account_type === type && a.code)
                      .map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.name}
                        </option>
                      ))}
                  </datalist>
                ),
              )}
            </fieldset>
          </form>
        )}
      </div>
    </details>
  );
}
