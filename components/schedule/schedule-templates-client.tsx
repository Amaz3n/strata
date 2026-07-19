"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  createScheduleTemplateAction,
  deleteScheduleTemplateAction,
  updateScheduleTemplateAction,
} from "@/app/(app)/settings/templates/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Edit, Plus, Trash2 } from "@/components/icons";
import { unwrapAction } from "@/lib/action-result";
import type { ScheduleTemplate } from "@/lib/types";

type ItemDraft = {
  name: string;
  phase: string;
  trade: string;
  startOffset: string;
  duration: string;
};
const newItem = (): ItemDraft => ({
  name: "",
  phase: "",
  trade: "",
  startOffset: "",
  duration: "1",
});

function toItems(template: ScheduleTemplate): ItemDraft[] {
  return template.items.map((item) => ({
    name: item.name ?? "",
    phase: item.phase ?? "",
    trade: item.trade ?? "",
    startOffset: item.start_offset_days?.toString() ?? "",
    duration: item.duration_days?.toString() ?? "1",
  }));
}

export function ScheduleTemplatesClient({
  initialTemplates,
}: {
  initialTemplates: ScheduleTemplate[];
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([newItem()]);
  const [pending, startTransition] = useTransition();

  const edit = (template?: ScheduleTemplate) => {
    setEditingId(template?.id ?? "new");
    setName(template?.name ?? "");
    setDescription(template?.description ?? "");
    setItems(
      template && toItems(template).length > 0
        ? toItems(template)
        : [newItem()],
    );
  };
  const patchItem = (index: number, patch: Partial<ItemDraft>) =>
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );

  const save = () => {
    if (!name.trim()) return toast.error("Template name is required");
    const populated = items.filter((item) => item.name.trim());
    if (populated.length === 0)
      return toast.error("Add at least one schedule item");
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      items: populated.map((item, index) => ({
        name: item.name.trim(),
        item_type: "task",
        status: "planned",
        phase: item.phase.trim() || undefined,
        trade: item.trade.trim() || undefined,
        start_offset_days:
          item.startOffset === ""
            ? undefined
            : Math.trunc(Number(item.startOffset)),
        duration_days:
          item.duration === ""
            ? undefined
            : Math.max(1, Math.trunc(Number(item.duration))),
        sort_order: index,
      })),
      is_public: false,
    };
    startTransition(async () => {
      try {
        const saved =
          editingId === "new"
            ? unwrapAction(await createScheduleTemplateAction(payload))
            : unwrapAction(
                await updateScheduleTemplateAction(
                  editingId as string,
                  payload,
                ),
              );
        setTemplates((current) =>
          [
            ...current.filter((template) => template.id !== saved.id),
            saved,
          ].sort((a, b) => a.name.localeCompare(b.name)),
        );
        setEditingId(null);
        toast.success("Schedule template saved");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not save schedule template",
        );
      }
    });
  };

  const removeTemplate = (template: ScheduleTemplate) => {
    if (
      !window.confirm(
        `Delete “${template.name}”? Released plan snapshots are unchanged.`,
      )
    )
      return;
    startTransition(async () => {
      try {
        unwrapAction(await deleteScheduleTemplateAction(template.id));
        setTemplates((current) =>
          current.filter((item) => item.id !== template.id),
        );
        toast.success("Schedule template deleted");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not delete schedule template",
        );
      }
    });
  };

  return (
    <div className="space-y-4">
      {editingId ? (
        <div className="space-y-4 border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Activity</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Trade</TableHead>
                  <TableHead className="w-28 text-right">
                    Start offset
                  </TableHead>
                  <TableHead className="w-28 text-right">Duration</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <Input
                        value={item.name}
                        onChange={(event) =>
                          patchItem(index, { name: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.phase}
                        onChange={(event) =>
                          patchItem(index, { phase: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.trade}
                        onChange={(event) =>
                          patchItem(index, { trade: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="text-right tabular-nums"
                        value={item.startOffset}
                        onChange={(event) =>
                          patchItem(index, { startOffset: event.target.value })
                        }
                        placeholder="Undated"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        className="text-right tabular-nums"
                        value={item.duration}
                        onChange={(event) =>
                          patchItem(index, { duration: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={items.length === 1}
                        onClick={() =>
                          setItems((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setItems((current) => [...current, newItem()])}
            >
              <Plus className="h-4 w-4" />
              Activity
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save template"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button onClick={() => edit()}>
          <Plus className="h-4 w-4" />
          New schedule template
        </Button>
      )}
      <div className="overflow-hidden border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Activities</TableHead>
              <TableHead className="text-right">Dated</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  No schedule templates yet.
                </TableCell>
              </TableRow>
            ) : (
              templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <p className="font-medium">{template.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {template.description ?? "No description"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {template.items.length}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {
                      template.items.filter(
                        (item) => typeof item.start_offset_days === "number",
                      ).length
                    }
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(template)}
                    >
                      <Edit className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeTemplate(template)}
                      disabled={pending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
