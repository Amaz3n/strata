"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { FileText, Folder, Layers, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import type { HelpSearchItem } from "@/lib/help/types"

export function HelpSearch({
  items,
  variant = "hero",
}: {
  items: HelpSearchItem[]
  variant?: "hero" | "sidebar"
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  function choose(item: HelpSearchItem) {
    setOpen(false)
    router.push(item.href)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className={cn(
          "justify-start rounded-none",
          variant === "hero"
            ? "h-12 w-full px-5 text-base text-muted-foreground"
            : "h-10 w-full border-border bg-transparent px-3 text-muted-foreground",
        )}
      >
        <Search data-icon="inline-start" />
        <span className="flex-1 text-left">Search</span>
        <Kbd>⌘ K</Kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search the Arc Help Center"
        description="Search topics, collections, and articles."
        className="border-border bg-popover sm:max-w-2xl"
      >
        <CommandInput placeholder="Search topics and articles..." />
        <CommandList className="max-h-[min(28rem,70svh)]">
          <CommandEmpty>
            {items.length === 0
              ? "No help content has been published yet."
              : "No matching help content."}
          </CommandEmpty>
          <CommandGroup heading="Help Center">
            {items.map((item) => {
              const Icon =
                item.type === "topic" ? Folder : item.type === "collection" ? Layers : FileText
              return (
                <CommandItem
                  key={`${item.type}:${item.href}`}
                  value={`${item.title} ${item.description} ${item.topicTitle} ${item.collectionTitle ?? ""}`}
                  onSelect={() => choose(item)}
                  className="items-start py-3"
                >
                  <Icon className="mt-0.5" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span>{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[item.topicTitle, item.collectionTitle].filter(Boolean).join(" / ")}
                    </span>
                  </div>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
