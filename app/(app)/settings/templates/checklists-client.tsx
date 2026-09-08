"use client";

import { PresetTemplateWorkspace } from "@/components/settings/preset-template-workspace";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { unwrapAction } from "@/lib/action-result";
import type { ChecklistTemplate } from "@/lib/services/inspections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createChecklistTemplateAction,
  listChecklistTemplateItemsAction,
  seedChecklistTemplatesAction,
  setChecklistTemplateActiveAction,
  updateChecklistTemplateAction,
} from "./checklists-actions";

// Editor grammar: one checklist item per line; a line ending in ":" starts a
// new section that applies to the lines after it.
function parseItems(text: string) {
  const items: Array<{
    section?: string | null;
    prompt: string;
    response_type: "pass_fail";
  }> = [];
  let section: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.endsWith(":")) {
      section = line.slice(0, -1).trim() || null;
      continue;
    }
    items.push({ section, prompt: line, response_type: "pass_fail" });
  }
  return items;
}

function itemsToText(items: Array<{ section: string | null; prompt: string }>) {
  const lines: string[] = [];
  let section: string | null = null;
  for (const item of items) {
    if ((item.section ?? null) !== section) {
      section = item.section ?? null;
      if (section) lines.push(`${section}:`);
    }
    lines.push(item.prompt);
  }
  return lines.join("\n");
}

export function ChecklistsClient({
  templates,
}: {
  templates: ChecklistTemplate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ChecklistTemplate | null>(null);
  const [itemsText, setItemsText] = useState("");
  const [previewName, setPreviewName] = useState("");
  const [previewDescription, setPreviewDescription] = useState("");
  const [previewTrade, setPreviewTrade] = useState("");
  const [previewKind, setPreviewKind] = useState("quality");

  const submit = (work: () => Promise<void>) =>
    startTransition(async () => {
      await work().catch((error) =>
        toast.error(
          error instanceof Error ? error.message : "Something went wrong",
        ),
      );
    });

  const openNew = () => {
    setEditing(null);
    setPreviewName("");
    setPreviewDescription("");
    setPreviewTrade("");
    setPreviewKind("quality");
    setItemsText("");
    setEditorOpen(true);
  };

  const openEdit = (template: ChecklistTemplate) => {
    setEditing(template);
    setPreviewName(template.name);
    setPreviewDescription(template.description ?? "");
    setPreviewTrade(template.trade ?? "");
    setPreviewKind(template.kind);
    setItemsText("");
    setEditorOpen(true);
    submit(async () => {
      const items = unwrapAction(
        await listChecklistTemplateItemsAction(template.id),
      );
      setItemsText(itemsToText(items));
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {templates.length} template{templates.length === 1 ? "" : "s"}
        </p>
        <div className="flex gap-2">
          {templates.length === 0 ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                submit(async () => {
                  const seeded = unwrapAction(
                    await seedChecklistTemplatesAction(),
                  );
                  toast.success(
                    seeded > 0
                      ? `Seeded ${seeded} starter templates`
                      : "Templates already exist",
                  );
                  router.refresh();
                })
              }
            >
              Seed starter templates
            </Button>
          ) : null}
          <Button onClick={openNew} disabled={pending}>
            New template
          </Button>
        </div>
      </div>

      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-24">Type</TableHead>
              <TableHead className="w-32">Trade</TableHead>
              <TableHead className="w-20 text-center">Items</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.length ? (
              templates.map((template) => (
                <TableRow
                  key={template.id}
                  className="cursor-pointer"
                  onClick={() => openEdit(template)}
                >
                  <TableCell>
                    <span className="font-medium">{template.name}</span>
                    {template.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {template.description}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">
                    {template.kind}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {template.trade ?? "—"}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {template.item_count}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={template.is_active ? "outline" : "secondary"}
                    >
                      {template.is_active ? "Active" : "Archived"}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        submit(async () => {
                          unwrapAction(
                            await setChecklistTemplateActiveAction(
                              template.id,
                              !template.is_active,
                            ),
                          );
                          router.refresh();
                        })
                      }
                    >
                      {template.is_active ? "Archive" : "Restore"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No checklist templates yet. Seed the starter library or create
                  one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {editorOpen && (
        <PresetTemplateWorkspace
          kind="Checklist"
          name={previewName}
          description={[
            previewKind === "quality" ? "Quality" : "Safety",
            previewTrade,
            previewDescription,
          ]
            .filter(Boolean)
            .join(" · ")}
          rows={itemsText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => ({
              label: l.endsWith(":") ? l.slice(0, -1) : `[  ]  ${l}`,
              heading: l.endsWith(":"),
            }))}
          onClose={() => setEditorOpen(false)}
          saveForm="checklist-template-form"
          busy={pending}
        >
          <form
            id="checklist-template-form"
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const items = parseItems(itemsText);
              if (items.length === 0) {
                toast.error("Add at least one checklist item");
                return;
              }
              const input = {
                name: form.get("name"),
                kind: form.get("kind"),
                trade: form.get("trade") || null,
                description: form.get("description") || null,
                items,
              };
              submit(async () => {
                if (editing) {
                  unwrapAction(
                    await updateChecklistTemplateAction(editing.id, input),
                  );
                  toast.success("Template updated");
                } else {
                  unwrapAction(await createChecklistTemplateAction(input));
                  toast.success("Template created");
                }
                setEditorOpen(false);
                router.refresh();
              });
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    name="name"
                    aria-label="Template name"
                    required
                    value={previewName}
                    onChange={(event) => setPreviewName(event.target.value)}
                    placeholder="Pre-Pour Concrete"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select
                    name="kind"
                    value={previewKind}
                    onValueChange={setPreviewKind}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quality">Quality</SelectItem>
                      <SelectItem value="safety">Safety</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Trade (optional)</Label>
                  <Input
                    name="trade"
                    aria-label="Trade"
                    value={previewTrade}
                    onChange={(event) => setPreviewTrade(event.target.value)}
                    placeholder="Concrete"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description (optional)</Label>
                  <Input
                    name="description"
                    aria-label="Template description"
                    value={previewDescription}
                    onChange={(event) =>
                      setPreviewDescription(event.target.value)
                    }
                    placeholder="When to run this checklist"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="checklist-items">Checklist items</Label>
                <p className="text-xs text-muted-foreground">
                  One item per line. End a heading with a colon to create a
                  section.
                </p>
                <Textarea
                  id="checklist-items"
                  value={itemsText}
                  onChange={(event) => setItemsText(event.target.value)}
                  rows={16}
                  className="font-mono text-xs"
                  placeholder={
                    "Formwork:\nForm dimensions match structural drawings\nForms braced and oiled\nReinforcing:\nRebar size and spacing per plans"
                  }
                />
              </div>
            </div>
          </form>
        </PresetTemplateWorkspace>
      )}
    </div>
  );
}
