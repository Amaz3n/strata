"use client";

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

export type RequestPickerOption = {
  id: string;
  name: string;
  detail?: string;
  group?: string;
  exclusiveGroup?: string;
  disabled?: boolean;
};

export function PricingRequestPicker({
  kind,
  applyLabel = "Apply selection",
  options,
  selected,
  email,
  onApply,
  onClose,
}: {
  kind: "files" | "contacts";
  applyLabel?: string;
  options: RequestPickerOption[];
  selected: string[];
  email?: string;
  onApply: (ids: string[], email: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(selected);
  const [draftEmail, setDraftEmail] = useState(email ?? "");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("All");
  const emailInput = useRef<HTMLInputElement>(null);
  const filtered = options.filter(
    (option) =>
      (group === "All" || option.group === group) &&
      `${option.name} ${option.detail ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = [
    ...new Set(
      options.flatMap((option) => (option.group ? [option.group] : [])),
    ),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader className="border-b p-6">
          <DialogTitle>
            {kind === "files"
              ? "Choose drawings & documents"
              : "Choose bid contacts"}
          </DialogTitle>
          <DialogDescription>
            {kind === "files"
              ? "Select the workspace files to share with bidders."
              : "Choose one bid contact per company, or add an email address."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 border-b px-6 py-4">
          <Input
            aria-label={
              kind === "files"
                ? "Search workspace files"
                : "Search bid contacts"
            }
            placeholder={
              kind === "files"
                ? "Find a drawing or document…"
                : "Find a person or company…"
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {groups.length > 0 && (
            <div className="flex gap-1" aria-label="File type">
              {["All", ...groups].map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={group === value ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={group === value}
                  onClick={() => setGroup(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6"
          style={{ height: 320 }}
        >
          <div className="divide-y">
            {filtered.map((option) => (
              <label
                key={option.id}
                className={`flex items-start gap-3 py-3 text-sm ${option.disabled ? "opacity-50" : "cursor-pointer"}`}
              >
                <Checkbox
                  className="mt-0.5 rounded-none"
                  disabled={option.disabled}
                  checked={draft.includes(option.id)}
                  onCheckedChange={(checked) =>
                    setDraft((ids) =>
                      checked
                        ? [
                            ...ids.filter(
                              (id) =>
                                id !== option.id &&
                                (!option.exclusiveGroup ||
                                  options.find(
                                    (candidate) => candidate.id === id,
                                  )?.exclusiveGroup !== option.exclusiveGroup),
                            ),
                            option.id,
                          ]
                        : ids.filter((id) => id !== option.id),
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block break-words">
                    {option.name}
                    {option.disabled ? " · Already invited" : ""}
                  </span>
                  {option.detail && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {option.detail}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {!filtered.length && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {search
                ? "No matches found."
                : kind === "files"
                  ? "No files in this workspace yet."
                  : "No contacts with an email address."}
            </p>
          )}
        </div>
        {kind === "contacts" && (
          <div className="border-t px-6 py-4">
            <Input
              ref={emailInput}
              aria-label="Additional invite email"
              type="email"
              placeholder="Or invite by email…"
              value={draftEmail}
              onChange={(event) => setDraftEmail(event.target.value)}
            />
          </div>
        )}
        <DialogFooter className="items-center border-t px-6 py-4">
          <span className="mr-auto text-xs text-muted-foreground">
            {draft.length + (draftEmail.trim() ? 1 : 0)} selected
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (emailInput.current && !emailInput.current.reportValidity())
                return;
              onApply(draft, draftEmail.trim());
              onClose();
            }}
          >
            {applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
