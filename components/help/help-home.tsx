import Link from "next/link"
import { ArrowUpRight, Folder, MessageSquare } from "@/components/icons"
import { HelpSearch } from "@/components/help/help-search"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { helpArticleHref, helpTopicHref } from "@/lib/help/paths"
import type { HelpNavigationTopic, HelpSearchItem } from "@/lib/help/types"

export function HelpHome({
  topics,
  searchItems,
}: {
  topics: HelpNavigationTopic[]
  searchItems: HelpSearchItem[]
}) {
  return (
    <>
      <section className="border-b bg-card">
        <div className="mx-auto w-full max-w-7xl px-5 py-14 sm:px-8 sm:py-20 lg:px-12">
          <p className="microlabel">Arc Help Center</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-medium tracking-[-0.04em] sm:text-5xl">
            How can we help?
          </h1>

          <div className="mt-8 flex w-full max-w-3xl flex-col gap-3">
            <HelpSearch items={searchItems} />
            <Button variant="outline" className="h-12 justify-start px-5 text-sm" asChild>
              <a href="mailto:support@arcnaples.com">
                <MessageSquare data-icon="inline-start" />
                <span className="flex-1 text-left">Contact Arc support</span>
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
        <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
          Browse help by topic
        </h2>

        {topics.length > 0 ? (
          <div className="mt-7 grid border-t border-border md:grid-cols-2 md:gap-x-16">
            {topics.map((topic) => (
              <article key={topic.slug} className="flex flex-col gap-4 border-b border-border py-9">
                <div className="flex flex-col gap-2">
                  <Link
                    href={helpTopicHref(topic.slug)}
                    className="text-xl font-medium underline decoration-border underline-offset-4 transition-colors hover:text-primary"
                  >
                    {topic.title}
                  </Link>
                  <p className="text-sm leading-6 text-muted-foreground">{topic.description}</p>
                </div>
                <div className="flex flex-col gap-2">
                  {topic.collections.flatMap((collection) =>
                    collection.articles.slice(0, 4).map((article) => (
                      <Link
                        key={`${collection.slug}:${article.slug}`}
                        href={helpArticleHref(topic.slug, collection.slug, article.slug)}
                        className="text-sm text-foreground/80 underline underline-offset-4 hover:text-foreground"
                      >
                        {article.title}
                      </Link>
                    )),
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty className="mt-7 min-h-[310px] rounded-none border-x-0 border-y border-solid border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Folder />
              </EmptyMedia>
              <EmptyTitle>No help topics have been published yet.</EmptyTitle>
              <EmptyDescription>
                The directory is ready for Arc guides and instructions.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </>
  )
}
