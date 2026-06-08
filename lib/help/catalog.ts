import { helpTopics } from "@/content/help/catalog"
import {
  helpArticleHref,
  helpCollectionHref,
  helpTopicHref,
} from "@/lib/help/paths"
import type {
  HelpNavigationTopic,
  HelpRoute,
  HelpSearchItem,
} from "@/lib/help/types"

validateHelpCatalog()

export function getHelpNavigation(): HelpNavigationTopic[] {
  return helpTopics.map((topic) => ({
    slug: topic.slug,
    title: topic.title,
    description: topic.description,
    collections: topic.collections.map((collection) => ({
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      articles: collection.articles.map(({ content: _content, ...article }) => article),
    })),
  }))
}

export function getHelpSearchItems(): HelpSearchItem[] {
  return helpTopics.flatMap((topic) => {
    const topicItem: HelpSearchItem = {
      type: "topic",
      title: topic.title,
      description: topic.description,
      href: helpTopicHref(topic.slug),
      topicTitle: topic.title,
    }

    const collectionItems = topic.collections.flatMap((collection) => {
      const collectionItem: HelpSearchItem = {
        type: "collection",
        title: collection.title,
        description: collection.description,
        href: helpCollectionHref(topic.slug, collection.slug),
        topicTitle: topic.title,
      }

      const articleItems: HelpSearchItem[] = collection.articles.map((article) => ({
        type: "article",
        title: article.title,
        description: article.description,
        href: helpArticleHref(topic.slug, collection.slug, article.slug),
        topicTitle: topic.title,
        collectionTitle: collection.title,
      }))

      return [collectionItem, ...articleItems]
    })

    return [topicItem, ...collectionItems]
  })
}

export function resolveHelpRoute(slugs: string[]): HelpRoute | null {
  const [topicSlug, collectionSlug, articleSlug] = slugs
  if (!topicSlug || slugs.length > 3) return null

  const topic = helpTopics.find((item) => item.slug === topicSlug)
  if (!topic) return null
  if (!collectionSlug) return { type: "topic", topic }

  const collection = topic.collections.find((item) => item.slug === collectionSlug)
  if (!collection) return null
  if (!articleSlug) return { type: "collection", topic, collection }

  const article = collection.articles.find((item) => item.slug === articleSlug)
  if (!article) return null

  return { type: "article", topic, collection, article }
}

export function getHelpStaticParams() {
  return helpTopics.flatMap((topic) => [
    { slug: [topic.slug] },
    ...topic.collections.flatMap((collection) => [
      { slug: [topic.slug, collection.slug] },
      ...collection.articles.map((article) => ({
        slug: [topic.slug, collection.slug, article.slug],
      })),
    ]),
  ])
}

export function getAdjacentArticles(
  topicSlug: string,
  collectionSlug: string,
  articleSlug: string,
) {
  const articles = helpTopics.flatMap((topic) =>
    topic.collections.flatMap((collection) =>
      collection.articles.map((article) => ({
        title: article.title,
        href: helpArticleHref(topic.slug, collection.slug, article.slug),
        topicSlug: topic.slug,
        collectionSlug: collection.slug,
        articleSlug: article.slug,
      })),
    ),
  )
  const index = articles.findIndex(
    (item) =>
      item.topicSlug === topicSlug &&
      item.collectionSlug === collectionSlug &&
      item.articleSlug === articleSlug,
  )

  return {
    previous: index > 0 ? articles[index - 1] : null,
    next: index >= 0 && index < articles.length - 1 ? articles[index + 1] : null,
  }
}

function validateHelpCatalog() {
  const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const topicSlugs = new Set<string>()

  for (const topic of helpTopics) {
    assertRecord(topic.title, topic.slug, "topic", slugPattern)
    if (topicSlugs.has(topic.slug)) throw new Error(`Duplicate help topic slug: ${topic.slug}`)
    topicSlugs.add(topic.slug)

    const collectionSlugs = new Set<string>()
    for (const collection of topic.collections) {
      assertRecord(collection.title, collection.slug, "collection", slugPattern)
      if (collectionSlugs.has(collection.slug)) {
        throw new Error(`Duplicate help collection slug in ${topic.slug}: ${collection.slug}`)
      }
      collectionSlugs.add(collection.slug)

      const articleSlugs = new Set<string>()
      for (const article of collection.articles) {
        assertRecord(article.title, article.slug, "article", slugPattern)
        if (articleSlugs.has(article.slug)) {
          throw new Error(
            `Duplicate help article slug in ${topic.slug}/${collection.slug}: ${article.slug}`,
          )
        }
        articleSlugs.add(article.slug)
      }
    }
  }
}

function assertRecord(
  title: string,
  slug: string,
  type: string,
  slugPattern: RegExp,
) {
  if (!title.trim()) throw new Error(`Help ${type} title cannot be empty.`)
  if (!slugPattern.test(slug)) {
    throw new Error(`Invalid help ${type} slug "${slug}". Use lowercase kebab-case.`)
  }
}
