import { Fragment } from "react"
import Link from "next/link"
import { FileText, FolderOpen } from "@/components/icons"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import {
  helpArticleHref,
  helpCollectionHref,
  helpTopicHref,
} from "@/lib/help/paths"
import type { HelpCollection, HelpTopic } from "@/lib/help/types"

export function HelpTopicDirectory({ topic }: { topic: HelpTopic }) {
  return (
    <DirectoryFrame
      breadcrumbs={[{ title: "Help Center", href: "/help" }, { title: topic.title }]}
      title={topic.title}
      description={topic.description}
    >
      {topic.collections.length > 0 ? (
        <div className="grid border-t border-border md:grid-cols-2 md:gap-x-16">
          {topic.collections.map((collection) => (
            <section key={collection.slug} className="flex flex-col gap-5 border-b border-border py-9">
              <div className="flex flex-col gap-2">
                <Link
                  href={helpCollectionHref(topic.slug, collection.slug)}
                  className="text-xl font-medium underline decoration-border underline-offset-4 hover:text-[#8fb5ff]"
                >
                  {collection.title}
                </Link>
                <p className="text-sm leading-6 text-muted-foreground">
                  {collection.description}
                </p>
              </div>
              <ArticleLinks topic={topic} collection={collection} />
            </section>
          ))}
        </div>
      ) : (
        <DirectoryEmpty noun="collections" />
      )}
    </DirectoryFrame>
  )
}

export function HelpCollectionDirectory({
  topic,
  collection,
}: {
  topic: HelpTopic
  collection: HelpCollection
}) {
  return (
    <DirectoryFrame
      breadcrumbs={[
        { title: "Help Center", href: "/help" },
        { title: topic.title, href: helpTopicHref(topic.slug) },
        { title: collection.title },
      ]}
      title={collection.title}
      description={collection.description}
    >
      {collection.articles.length > 0 ? (
        <div className="flex flex-col border-t border-border">
          {collection.articles.map((article) => (
            <Link
              key={article.slug}
              href={helpArticleHref(topic.slug, collection.slug, article.slug)}
              className="group flex items-start gap-4 border-b border-border py-6"
            >
              <FileText className="mt-1 size-5 shrink-0 text-[#8fb5ff]" />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium underline decoration-border underline-offset-4 group-hover:text-[#8fb5ff]">
                  {article.title}
                </span>
                <span className="text-sm leading-6 text-muted-foreground">
                  {article.description}
                </span>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <DirectoryEmpty noun="articles" />
      )}
    </DirectoryFrame>
  )
}

function DirectoryFrame({
  breadcrumbs,
  title,
  description,
  children,
}: {
  breadcrumbs: Array<{ title: string; href?: string }>
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <main className="mx-auto min-h-svh w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((crumb, index) => (
              <Fragment key={`${crumb.title}:${index}`}>
                {index > 0 ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem>
                  {crumb.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={crumb.href}>{crumb.title}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>

        <header className="flex flex-col gap-4 pb-10 pt-12">
          <h1 className="text-4xl font-medium tracking-[-0.035em] sm:text-5xl">{title}</h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">{description}</p>
        </header>

        {children}
    </main>
  )
}

function ArticleLinks({
  topic,
  collection,
}: {
  topic: HelpTopic
  collection: HelpCollection
}) {
  if (collection.articles.length === 0) {
    return <p className="text-sm text-muted-foreground">No articles published yet.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {collection.articles.map((article) => (
        <Link
          key={article.slug}
          href={helpArticleHref(topic.slug, collection.slug, article.slug)}
          className="text-sm text-foreground/80 underline underline-offset-4 hover:text-foreground"
        >
          {article.title}
        </Link>
      ))}
    </div>
  )
}

function DirectoryEmpty({ noun }: { noun: string }) {
  return (
    <>
      <Separator />
      <Empty className="min-h-[300px] rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpen />
          </EmptyMedia>
          <EmptyTitle>No {noun} published yet.</EmptyTitle>
          <EmptyDescription>This directory is ready for new Help Center content.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Separator />
    </>
  )
}
