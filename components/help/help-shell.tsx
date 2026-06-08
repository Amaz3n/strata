"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ChevronRight, ExternalLink, Menu, MessageSquare } from "@/components/icons"
import { HelpSearch } from "@/components/help/help-search"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import {
  helpArticleHref,
  helpCollectionHref,
  helpTopicHref,
} from "@/lib/help/paths"
import type { HelpNavigationTopic, HelpSearchItem } from "@/lib/help/types"

type HelpShellProps = {
  children: React.ReactNode
  navigation: HelpNavigationTopic[]
  searchItems: HelpSearchItem[]
  activeSlugs?: string[]
}

export function HelpShell({
  children,
  navigation,
  searchItems,
  activeSlugs = [],
}: HelpShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const activeRouteKey = activeSlugs.join("/")

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [activeRouteKey])

  return (
    <div className="dark min-h-svh bg-[#0b1018] text-foreground">
      <header className="flex h-16 items-center justify-between border-b border-border bg-[#080d14] px-5 lg:hidden">
        <Link href="/help" className="flex items-center gap-3">
          <img src="/arc-logo2.svg" alt="Arc" className="h-7 w-8 object-contain" />
          <span className="text-sm font-medium">Help Center</span>
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open help navigation"
          onClick={() => setMobileMenuOpen(true)}
        >
          <Menu />
        </Button>
      </header>

      <HelpSidebar
        className="hidden lg:flex"
        navigation={navigation}
        searchItems={searchItems}
        activeSlugs={activeSlugs}
      />

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-[min(22rem,88vw)] gap-0 border-border bg-[#080d14] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Help Center navigation</SheetTitle>
            <SheetDescription>Browse Arc help topics and articles.</SheetDescription>
          </SheetHeader>
          <HelpSidebarContent
            navigation={navigation}
            searchItems={searchItems}
            activeSlugs={activeSlugs}
          />
        </SheetContent>
      </Sheet>

      <div className="min-h-svh lg:pl-60">{children}</div>
    </div>
  )
}

function HelpSidebar({
  navigation,
  searchItems,
  activeSlugs,
  className,
}: {
  navigation: HelpNavigationTopic[]
  searchItems: HelpSearchItem[]
  activeSlugs: string[]
  className?: string
}) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 w-60 flex-col border-r border-border bg-[#080d14]",
        className,
      )}
    >
      <HelpSidebarContent
        navigation={navigation}
        searchItems={searchItems}
        activeSlugs={activeSlugs}
      />
    </aside>
  )
}

function HelpSidebarContent({
  navigation,
  searchItems,
  activeSlugs,
}: {
  navigation: HelpNavigationTopic[]
  searchItems: HelpSearchItem[]
  activeSlugs: string[]
}) {
  const [activeTopicSlug, activeCollectionSlug, activeArticleSlug] = activeSlugs

  return (
    <>
      <div className="flex h-16 shrink-0 items-center border-b border-border px-5">
        <Link href="/help" className="flex items-center gap-3">
          <img src="/arc-logo2.svg" alt="Arc" className="h-7 w-8 object-contain" />
          <span className="font-medium">Arc</span>
        </Link>
      </div>

      <div className="shrink-0 border-b border-border p-3">
        <HelpSearch items={searchItems} variant="sidebar" />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-5 p-4" aria-label="Help topics">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Topics
          </p>

          {navigation.length === 0 ? (
            <p className="px-1 text-sm leading-6 text-muted-foreground">
              No topics published yet
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {navigation.map((topic) => {
                const topicActive = topic.slug === activeTopicSlug
                return (
                  <Collapsible
                    key={topic.slug}
                    defaultOpen={topicActive}
                    className="group/topic flex flex-col"
                  >
                    <div
                      className={cn(
                        "flex items-center transition-colors hover:bg-accent",
                        topicActive && "bg-accent",
                      )}
                    >
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Toggle ${topic.title}`}
                          className="size-8 shrink-0 text-muted-foreground hover:bg-transparent"
                        >
                          <ChevronRight className="transition-transform group-data-[state=open]/topic:rotate-90" />
                        </Button>
                      </CollapsibleTrigger>
                      <Link
                        href={helpTopicHref(topic.slug)}
                        className={cn(
                          "min-w-0 flex-1 py-2 pr-2 text-sm transition-colors",
                          topicActive ? "text-accent-foreground" : "text-muted-foreground",
                        )}
                      >
                        {topic.title}
                      </Link>
                    </div>

                    <CollapsibleContent>
                      <div className="ml-4 flex flex-col border-l border-border pl-2">
                        {topic.collections.map((collection) => {
                          const collectionActive = collection.slug === activeCollectionSlug
                          return (
                            <Collapsible
                              key={collection.slug}
                              defaultOpen={collectionActive}
                              className="group/collection flex flex-col"
                            >
                              <div className="flex items-center">
                                <CollapsibleTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Toggle ${collection.title}`}
                                    className="size-7 shrink-0 text-muted-foreground hover:bg-transparent"
                                  >
                                    <ChevronRight className="transition-transform group-data-[state=open]/collection:rotate-90" />
                                  </Button>
                                </CollapsibleTrigger>
                                <Link
                                  href={helpCollectionHref(topic.slug, collection.slug)}
                                  className={cn(
                                    "min-w-0 flex-1 py-1.5 pr-2 text-xs transition-colors hover:text-foreground",
                                    collectionActive
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {collection.title}
                                </Link>
                              </div>
                              <CollapsibleContent>
                                <div className="ml-3 flex flex-col border-l border-border/70 pl-2">
                                  {collection.articles.map((article) => (
                                    <Link
                                      key={article.slug}
                                      href={helpArticleHref(
                                        topic.slug,
                                        collection.slug,
                                        article.slug,
                                      )}
                                      className={cn(
                                        "px-4 py-1.5 text-xs transition-colors hover:text-foreground",
                                        article.slug === activeArticleSlug
                                          ? "text-[#8fb5ff]"
                                          : "text-muted-foreground",
                                      )}
                                    >
                                      {article.title}
                                    </Link>
                                  ))}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          )
                        })}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          )}
        </nav>
      </ScrollArea>

      <div className="mt-auto shrink-0">
        <Separator />
        <nav className="flex flex-col p-3" aria-label="Help center utilities">
          <Button variant="ghost" className="justify-start text-muted-foreground" asChild>
            <a href="mailto:support@arcnaples.com">
              <MessageSquare data-icon="inline-start" />
              Contact support
            </a>
          </Button>
          <Button variant="ghost" className="justify-start text-muted-foreground" asChild>
            <Link href="/">
              <ExternalLink data-icon="inline-start" />
              Go to Arc
            </Link>
          </Button>
        </nav>
      </div>
    </>
  )
}
