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
      <section className="help-hero-gradient relative min-h-[470px] overflow-hidden border-b border-border sm:min-h-[500px]">
        <div className="help-hero-grid absolute inset-0" aria-hidden="true" />
        <svg
          aria-hidden="true"
          className="help-hero-arc absolute bottom-[-13%] right-[-4%] hidden h-[92%] w-[54%] lg:block"
          viewBox="0 0 581 521"
          fill="none"
          preserveAspectRatio="xMidYMid meet"
        >
          <path
            d="M1 296V1h579v295C522 196 414 128 290 128S58 196 1 296ZM63 520c-9-25-14-52-14-80 0-133 108-241 241-241s241 108 241 241c0 28-5 55-14 80H63Z"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div className="relative z-10 flex min-h-[470px] w-full flex-col items-start justify-center px-5 py-16 text-left sm:min-h-[500px] sm:px-8 lg:px-12 xl:px-16">
          <p className="text-base font-medium text-white/80">Arc Help Center</p>
          <h1 className="mt-3 max-w-2xl text-5xl font-medium tracking-[-0.05em] text-white sm:text-6xl lg:text-[4.75rem] lg:leading-[0.95]">
            How can we help?
          </h1>

          <div className="mt-10 flex w-full max-w-3xl flex-col gap-3">
            <HelpSearch items={searchItems} />
            <Button
              variant="outline"
              className="h-14 justify-start rounded-none border-[#4e82df] bg-[#0a0f16]/95 px-5 text-sm text-white/85 hover:border-[#7aa6f7] hover:bg-[#101827] hover:text-white sm:px-6 sm:text-base"
              asChild
            >
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
                    className="text-xl font-medium underline decoration-border underline-offset-4 transition-colors hover:text-[#8fb5ff]"
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
