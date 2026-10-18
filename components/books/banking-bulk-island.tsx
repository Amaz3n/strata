"use client";

import { BulkSelectionIsland } from "@/components/ui/bulk-selection-island";
import { Button } from "@/components/ui/button";
import { BankingPicker } from "./banking-picker";

export function BankingBulkIsland({
  count,
  category,
  project,
  categories,
  projects,
  busy,
  onCategoryChange,
  onProjectChange,
  onApply,
  onPost,
  onExclude,
  onClear,
}: {
  count: number;
  category: string | null;
  project: string | null;
  categories: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  busy: boolean;
  onCategoryChange: (value: string | null) => void;
  onProjectChange: (value: string | null) => void;
  onApply: () => void;
  onPost: () => void;
  onExclude: () => void;
  onClear: () => void;
}) {
  return (
    <BulkSelectionIsland
      count={count}
      label="Selected transaction actions"
      onClear={onClear}
    >
      <div className="w-48">
        <BankingPicker
          value={category}
          options={categories}
          placeholder="Apply category"
          onChange={onCategoryChange}
        />
      </div>
      <div className="w-40">
        <BankingPicker
          value={project}
          options={projects}
          placeholder="Apply project"
          clearLabel="No project"
          onChange={onProjectChange}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={!category || busy}
        onClick={onApply}
      >
        Apply
      </Button>
      <Button size="sm" disabled={busy} onClick={onPost}>
        Post
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onExclude}>
        Exclude
      </Button>
    </BulkSelectionIsland>
  );
}
