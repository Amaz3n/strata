export function helpTopicHref(topicSlug: string) {
  return `/help/${topicSlug}`
}

export function helpCollectionHref(topicSlug: string, collectionSlug: string) {
  return `/help/${topicSlug}/${collectionSlug}`
}

export function helpArticleHref(
  topicSlug: string,
  collectionSlug: string,
  articleSlug: string,
) {
  return `/help/${topicSlug}/${collectionSlug}/${articleSlug}`
}
