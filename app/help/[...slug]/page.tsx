import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { HelpArticlePage } from "@/components/help/help-article"
import {
  HelpCollectionDirectory,
  HelpTopicDirectory,
} from "@/components/help/help-directory"
import { HelpShell } from "@/components/help/help-shell"
import {
  getHelpNavigation,
  getHelpSearchItems,
  getHelpStaticParams,
  resolveHelpRoute,
} from "@/lib/help/catalog"

type HelpRoutePageProps = {
  params: Promise<{ slug: string[] }>
}

export function generateStaticParams() {
  return getHelpStaticParams()
}

export async function generateMetadata({
  params,
}: HelpRoutePageProps): Promise<Metadata> {
  const { slug } = await params
  const route = resolveHelpRoute(slug)
  if (!route) return {}

  const title =
    route.type === "topic"
      ? route.topic.title
      : route.type === "collection"
        ? route.collection.title
        : route.article.title
  const description =
    route.type === "topic"
      ? route.topic.description
      : route.type === "collection"
        ? route.collection.description
        : route.article.description

  return {
    title: `${title} | Arc Help Center`,
    description,
  }
}

export default async function HelpRoutePage({ params }: HelpRoutePageProps) {
  const { slug } = await params
  const route = resolveHelpRoute(slug)
  if (!route) notFound()

  const navigation = getHelpNavigation()
  const searchItems = getHelpSearchItems()

  return (
    <HelpShell navigation={navigation} searchItems={searchItems} activeSlugs={slug}>
      {route.type === "topic" ? (
        <HelpTopicDirectory topic={route.topic} />
      ) : route.type === "collection" ? (
        <HelpCollectionDirectory topic={route.topic} collection={route.collection} />
      ) : (
        <HelpArticlePage
          topic={route.topic}
          collection={route.collection}
          article={route.article}
        />
      )}
    </HelpShell>
  )
}
