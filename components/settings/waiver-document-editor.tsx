"use client";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { templateFields } from "@/lib/templates/waiver-template";
import {
  newWaiverBlock,
  type WaiverDocument,
  type WaiverBlock,
} from "@/lib/templates/waiver-document";
const selectClass = "h-9 w-full border bg-background px-2 text-xs";
export function WaiverDocumentEditor({
  document: d,
  onChange,
  source,
}: {
  document: WaiverDocument;
  onChange: (d: WaiverDocument) => void;
  source?: string;
}) {
  const fields = {
    ...templateFields,
    ...Object.fromEntries(d.fields.map((f) => [f.key, f.label])),
  };
  function block(id: string, patch: Partial<WaiverBlock>) {
    onChange({
      ...d,
      blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    });
  }
  const textInput = (
    value: string,
    onValue: (value: string) => void,
    label: string,
  ) => (
    <Textarea
      placeholder="Enter the exact wording from your form…"
      aria-label={label}
      value={value}
      onChange={(e) => onValue(e.target.value)}
      className="min-h-28 text-sm leading-7"
    />
  );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-xs">
          Document format
          <select
            className={selectClass}
            value={d.mode}
            onChange={(e) =>
              onChange({ ...d, mode: e.target.value as WaiverDocument["mode"] })
            }
          >
            <option value="editable">Editable Arc document</option>
            <option value="original" disabled={!source}>
              Keep original PDF layout
            </option>
          </select>
        </label>
        <label className="space-y-1.5 text-xs">
          Text size
          <Input
            aria-label="Document text size"
            type="number"
            min={8}
            max={16}
            value={d.fontSize}
            onChange={(e) =>
              onChange({ ...d, fontSize: Number(e.target.value) })
            }
          />
        </label>
      </div>
      {d.mode === "editable" ? (
        <>
          <label className="flex items-center gap-3 text-xs">
            Page size
            <select
              className={selectClass}
              value={d.pageSize}
              onChange={(e) =>
                onChange({ ...d, pageSize: e.target.value as "LETTER" | "A4" })
              }
            >
              <option>LETTER</option>
              <option>A4</option>
            </select>
          </label>
          {d.blocks.map((b, index) => (
            <section key={b.id} className="space-y-3 border p-4">
              <div className="flex items-center gap-2">
                <span className="mr-auto text-xs font-medium capitalize">
                  {b.kind.replace("_", " ")} {index + 1}
                </span>
                {[-1, 1].map((delta) => (
                  <Button
                    key={delta}
                    aria-label={
                      delta === -1 ? "Move section up" : "Move section down"
                    }
                    variant="ghost"
                    size="icon"
                    disabled={
                      index + delta < 0 || index + delta >= d.blocks.length
                    }
                    onClick={() => {
                      const blocks = [...d.blocks];
                      [blocks[index], blocks[index + delta]] = [
                        blocks[index + delta],
                        blocks[index],
                      ];
                      onChange({ ...d, blocks });
                    }}
                  >
                    {delta === -1 ? (
                      <ArrowUp className="size-3.5" />
                    ) : (
                      <ArrowDown className="size-3.5" />
                    )}
                  </Button>
                ))}
                <Button
                  aria-label="Remove section"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    onChange({
                      ...d,
                      blocks: d.blocks.filter((x) => x.id !== b.id),
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {(b.kind === "paragraph" || b.kind === "heading") && (
                <>
                  {textInput(
                    b.text,
                    (text) => block(b.id, { text }),
                    `${b.kind} wording`,
                  )}
                  <select
                    className={selectClass}
                    value=""
                    aria-label="Insert document field"
                    onChange={(e) =>
                      block(b.id, { text: b.text + `{{${e.target.value}}}` })
                    }
                  >
                    <option value="">Insert a field…</option>
                    {Object.entries(fields).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {b.kind === "table" && (
                <>
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={b.repeat === "covered_items"}
                      onChange={(e) =>
                        block(b.id, {
                          repeat: e.target.checked ? "covered_items" : "none",
                        })
                      }
                    />
                    Repeat rows for each covered invoice / payable
                  </label>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          {b.columns.map((c, i) => (
                            <th key={i}>
                              <Input
                                aria-label={`Column ${i + 1}`}
                                value={c}
                                onChange={(e) =>
                                  block(b.id, {
                                    columns: b.columns.map((v, j) =>
                                      j === i ? e.target.value : v,
                                    ),
                                  })
                                }
                              />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.rows.map((r, i) => (
                          <tr key={i}>
                            {r.map((c, j) => (
                              <td key={j}>
                                <Input
                                  aria-label={`Row ${i + 1} column ${j + 1}`}
                                  value={c}
                                  onChange={(e) =>
                                    block(b.id, {
                                      rows: b.rows.map((row, k) =>
                                        k === i
                                          ? row.map((v, l) =>
                                              l === j ? e.target.value : v,
                                            )
                                          : row,
                                      ),
                                    })
                                  }
                                />
                              </td>
                            ))}
                            <td>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove row ${i + 1}`}
                                onClick={() =>
                                  block(b.id, {
                                    rows: b.rows.filter((_, j) => j !== i),
                                  })
                                }
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        block(b.id, {
                          rows: [...b.rows, b.columns.map(() => "")],
                        })
                      }
                    >
                      Add row
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={b.columns.length >= 8}
                      onClick={() =>
                        block(b.id, {
                          columns: [...b.columns, "Column"],
                          rows: b.rows.map((r) => [...r, ""]),
                        })
                      }
                    >
                      Add column
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Table cells support the same fields as wording, such as{" "}
                    {"{{amount}}"}.
                  </p>
                </>
              )}
              {b.kind === "signature" && (
                <label className="block space-y-2 text-xs">
                  Signer role
                  <Input
                    value={b.signerRole ?? "claimant"}
                    placeholder="claimant, witness, …"
                    onChange={(e) =>
                      block(b.id, {
                        signerRole: e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9_]/g, "_"),
                      })
                    }
                  />
                </label>
              )}
              {b.kind === "signature" && (
                <p className="text-xs text-muted-foreground">
                  Claimant signature and signing date. Arc positions the signing
                  fields on the generated page.
                </p>
              )}
              {!["signature", "page_break"].includes(b.kind) && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Show this section conditionally
                  </summary>
                  <div className="mt-3 space-y-2">
                    <select
                      aria-label="Condition field"
                      className={selectClass}
                      value={b.condition?.field ?? ""}
                      onChange={(e) =>
                        block(b.id, {
                          condition: e.target.value
                            ? {
                                field: e.target.value,
                                operator: "present",
                                value: "",
                              }
                            : null,
                        })
                      }
                    >
                      <option value="">Always show</option>
                      {Object.entries(fields).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {b.condition && (
                      <>
                        <select
                          aria-label="Condition operator"
                          className={selectClass}
                          value={b.condition.operator}
                          onChange={(e) =>
                            block(b.id, {
                              condition: {
                                ...b.condition!,
                                operator: e.target.value as
                                  | "present"
                                  | "equals"
                                  | "not_equals",
                              },
                            })
                          }
                        >
                          <option value="present">Has a value</option>
                          <option value="equals">Equals</option>
                          <option value="not_equals">Does not equal</option>
                        </select>
                        {b.condition.operator !== "present" && (
                          <Input
                            aria-label="Condition value"
                            value={b.condition.value}
                            onChange={(e) =>
                              block(b.id, {
                                condition: {
                                  ...b.condition!,
                                  value: e.target.value,
                                },
                              })
                            }
                          />
                        )}
                      </>
                    )}
                  </div>
                </details>
              )}
            </section>
          ))}
          <div className="flex flex-wrap gap-2">
            {(
              [
                "paragraph",
                "heading",
                "table",
                "page_break",
                "signature",
              ] as const
            ).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange({
                    ...d,
                    blocks: [...d.blocks, newWaiverBlock(kind)],
                  })
                }
              >
                <Plus className="mr-1 size-3" />
                {kind.replace("_", " ")}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            Map blank areas on the original. Positions are percentages from the
            top-left of each page. Use a blank form; existing content is
            preserved.
          </p>
          {d.placements.map((p, i) => (
            <div className="space-y-2 border p-3" key={p.id}>
              <div className="flex gap-2">
                <select
                  aria-label="PDF field type"
                  className={selectClass}
                  value={p.kind}
                  onChange={(e) =>
                    onChange({
                      ...d,
                      placements: d.placements.map((v, j) =>
                        j === i
                          ? { ...v, kind: e.target.value as typeof p.kind }
                          : v,
                      ),
                    })
                  }
                >
                  <option value="text">Data field</option>
                  <option value="signature">Signature</option>
                  <option value="date">Signing date</option>
                  <option value="initials">Initials</option>
                </select>
                {p.kind === "text" && (
                  <select
                    aria-label="PDF data source"
                    className={selectClass}
                    value={p.key}
                    onChange={(e) =>
                      onChange({
                        ...d,
                        placements: d.placements.map((v, j) =>
                          j === i ? { ...v, key: e.target.value } : v,
                        ),
                      })
                    }
                  >
                    {Object.entries(fields).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove PDF field"
                  onClick={() =>
                    onChange({
                      ...d,
                      placements: d.placements.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {p.kind !== "text" && (
                <Input
                  aria-label="PDF signer role"
                  placeholder="claimant"
                  value={p.signerRole ?? "claimant"}
                  onChange={(e) =>
                    onChange({
                      ...d,
                      placements: d.placements.map((v, j) =>
                        j === i ? { ...v, signerRole: e.target.value } : v,
                      ),
                    })
                  }
                />
              )}
              <div className="grid grid-cols-5 gap-2">
                {(["page", "x", "y", "width", "height"] as const).map((k) => (
                  <label key={k} className="text-[10px] capitalize">
                    {k === "page" ? "Page" : `${k} %`}
                    <Input
                      aria-label={`PDF field ${k}`}
                      className="px-2"
                      type="number"
                      value={
                        k === "page" ? p[k] + 1 : Math.round(p[k] * 1000) / 10
                      }
                      min={k === "page" ? 1 : 0}
                      max={k === "page" ? 50 : 100}
                      step={k === "page" ? 1 : 0.1}
                      onChange={(e) =>
                        onChange({
                          ...d,
                          placements: d.placements.map((v, j) =>
                            j === i
                              ? {
                                  ...v,
                                  [k]:
                                    k === "page"
                                      ? Number(e.target.value) - 1
                                      : Number(e.target.value) / 100,
                                }
                              : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              onChange({
                ...d,
                placements: [
                  ...d.placements,
                  {
                    id: crypto.randomUUID(),
                    key: "project_name",
                    kind: "text",
                    page: 0,
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.04,
                  },
                ],
              })
            }
          >
            <Plus className="mr-2 size-4" />
            Place a field
          </Button>
        </div>
      )}
      <details className="border-t pt-5">
        <summary className="cursor-pointer text-sm font-medium">
          Custom fields{" "}
          <span className="ml-2 text-muted-foreground">{d.fields.length}</span>
        </summary>
        <div className="mt-4 space-y-4">
          {d.fields.map((f, index) => {
            const patch = (v: Partial<typeof f>) =>
              onChange({
                ...d,
                fields: d.fields.map((x, i) =>
                  i === index ? { ...x, ...v } : x,
                ),
              });
            return (
              <div key={index} className="space-y-3 border p-4">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Custom field label"
                    placeholder="Field label"
                    value={f.label}
                    onChange={(e) => patch({ label: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove custom field"
                    onClick={() =>
                      onChange({
                        ...d,
                        fields: d.fields.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <label className="block text-xs">
                  Field key
                  <Input
                    value={f.key}
                    onChange={(e) => patch({ key: e.target.value })}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    aria-label="Custom field type"
                    className={selectClass}
                    value={f.type}
                    onChange={(e) =>
                      patch({ type: e.target.value as typeof f.type })
                    }
                  >
                    {["text", "currency", "date", "choice"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Custom field source"
                    className={selectClass}
                    value={f.source}
                    onChange={(e) => patch({ source: e.target.value })}
                  >
                    <option value="manual">Ask when preparing</option>
                    <option value="constant">Company constant</option>
                    {Object.entries(templateFields).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                {["manual", "constant"].includes(f.source) && (
                  <Input
                    aria-label="Custom field default value"
                    placeholder={
                      f.source === "constant"
                        ? "Company value"
                        : "Default value (optional)"
                    }
                    value={f.value}
                    onChange={(e) => patch({ value: e.target.value })}
                  />
                )}{" "}
                {f.type === "choice" && (
                  <Textarea
                    aria-label="Choices, one per line"
                    placeholder="One choice per line"
                    value={f.options.join("\n")}
                    onChange={(e) =>
                      patch({ options: e.target.value.split("\n") })
                    }
                  />
                )}
                <label className="flex gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => patch({ required: e.target.checked })}
                  />
                  Required when this field appears
                </label>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...d,
                fields: [
                  ...d.fields,
                  {
                    key: `custom_${d.fields.length + 1}`,
                    label: "New field",
                    type: "text",
                    source: "manual",
                    value: "",
                    required: true,
                    options: [],
                  },
                ],
              })
            }
          >
            <Plus className="mr-2 size-3" />
            Add custom field
          </Button>
        </div>
      </details>
    </div>
  );
}
