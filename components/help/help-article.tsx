import Link from "next/link"
import { ArrowLeft, ArrowRight, CalendarDays } from "@/components/icons"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  getAdjacentArticles,
} from "@/lib/help/catalog"
import { helpCollectionHref, helpTopicHref } from "@/lib/help/paths"
import type { HelpArticle, HelpCollection, HelpTopic } from "@/lib/help/types"

export function HelpArticlePage({
  topic,
  collection,
  article,
}: {
  topic: HelpTopic
  collection: HelpCollection
  article: HelpArticle
}) {
  const ArticleContent = article.content
  const adjacent = getAdjacentArticles(topic.slug, collection.slug, article.slug)

  return (
    <main className="mx-auto min-h-svh w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/help">Help Center</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={helpTopicHref(topic.slug)}>{topic.title}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={helpCollectionHref(topic.slug, collection.slug)}>
                  {collection.title}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{article.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <article className="max-w-3xl pb-16 pt-12">
          <header className="flex flex-col gap-5">
            <h1 className="text-4xl font-medium tracking-[-0.04em] sm:text-5xl">
              {article.title}
            </h1>
            <p className="text-lg leading-8 text-muted-foreground">{article.description}</p>
            {article.updatedAt ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarDays className="size-4" />
                Updated{" "}
                {new Intl.DateTimeFormat("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                }).format(new Date(article.updatedAt))}
              </p>
            ) : null}
          </header>

          <Separator className="my-10" />

          <div className="help-article-body">
            <ArticleContent />
          </div>
        </article>

        {(adjacent.previous || adjacent.next) ? (
          <nav className="grid gap-4 border-t border-border py-8 sm:grid-cols-2" aria-label="Articles">
            <div>
              {adjacent.previous ? (
                <Button variant="ghost" className="h-auto justify-start px-0 text-left" asChild>
                  <Link href={adjacent.previous.href}>
                    <ArrowLeft data-icon="inline-start" />
                    <span className="flex flex-col items-start gap-1">
                      <span className="text-xs text-muted-foreground">Previous article</span>
                      <span>{adjacent.previous.title}</span>
                    </span>
                  </Link>
                </Button>
              ) : null}
            </div>
            <div className="sm:text-right">
              {adjacent.next ? (
                <Button variant="ghost" className="h-auto justify-end px-0 text-right" asChild>
                  <Link href={adjacent.next.href}>
                    <span className="flex flex-col items-end gap-1">
                      <span className="text-xs text-muted-foreground">Next article</span>
                      <span>{adjacent.next.title}</span>
                    </span>
                    <ArrowRight data-icon="inline-end" />
                  </Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
    </main>
  )
}
