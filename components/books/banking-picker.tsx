"use client";
import { useId, useState } from "react";
import { Brain, Check, ChevronsUpDown, ListFilter, Plus, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
export function BankingPicker({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled,
  onCreate,
  className,
  clearLabel = "Clear selection",
  suggestedOption,
  suggestionSource = "learned_pattern",
}: {
  value: string | null;
  options: Array<{ id: string; name: string }>;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  onCreate?: (name: string) => Promise<void>;
  className?: string;
  clearLabel?: string;
  suggestedOption?: { id: string; name: string } | null;
  suggestionSource?: "manual_rule" | "learned_pattern" | "ai";
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const suggestionLabel = suggestionSource === "ai"
    ? "AI suggestion"
    : suggestionSource === "manual_rule"
      ? "Set by a bank rule"
      : "Learned from your coding";
  const SuggestionIcon = suggestionSource === "ai" ? Sparkles : suggestionSource === "manual_rule" ? ListFilter : Brain;
  const suggestionIcon = (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-label={suggestionLabel} className="shrink-0">
            <SuggestionIcon
              className={cn(
                "size-3",
                suggestionSource === "ai" ? "text-chart-5" : "text-primary",
              )}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>{suggestionLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={placeholder}
          disabled={disabled}
          className={cn(
            "flex min-h-9 w-full items-center gap-1 px-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            !value && "text-muted-foreground",
            className,
          )}
        >
          {!value && suggestedOption ? (
            suggestionIcon
          ) : null}
          <span className="truncate">
            {options.find((o) => o.id === value)?.name ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-auto size-3 shrink-0 opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={`Search ${placeholder.toLowerCase()}`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList id={listId}>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading={value ? "Selected" : suggestedOption ? "Suggested" : undefined}>
              {(value || suggestedOption) ? (() => {
                const pinned = options.find((option) => option.id === value) ?? (!value ? suggestedOption : null);
                return pinned ? (
                  <CommandItem
                    value={`pinned ${pinned.name} ${pinned.id}`}
                    onSelect={() => {
                      onChange(pinned.id);
                      setOpen(false);
                    }}
                  >
                    {!value && suggestedOption ? suggestionIcon : null}
                    {pinned.name}
                    <Check className="ml-auto size-3 text-primary" />
                  </CommandItem>
                ) : null;
              })() : null}
            </CommandGroup>
            <CommandGroup>
              {options.filter((option) => option.id !== value && (!suggestedOption || value ? true : option.id !== suggestedOption.id)).map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.name} ${option.id}`}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  {option.id === suggestedOption?.id
                    ? suggestionIcon
                    : <Check className="mr-2 size-3 opacity-0" />}
                  {option.name}
                </CommandItem>
              ))}
              <CommandItem
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <Check className="mr-2 size-3 opacity-0" />
                {clearLabel}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        {onCreate && query.trim().length >= 2 && (
          <button
            disabled={creating}
            className="flex w-full items-center gap-2 border-t p-3 text-sm"
            onClick={async () => {
              setCreating(true);
              try {
                await onCreate(query.trim());
                setOpen(false);
              } finally {
                setCreating(false);
              }
            }}
          >
            <Plus className="size-4" />
            {creating ? "Creating…" : `Create “${query.trim()}”`}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
