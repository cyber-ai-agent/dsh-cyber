import { FirecrawlClient, type FirecrawlSearchItem } from '../integrations/firecrawl-client.js'
import { WorldKnowledgeLibraryService, type KnowledgeDocument } from './world-knowledge-library-service.js'

export interface KnowledgeWebImportServiceOptions {
  client: FirecrawlClient
  library: WorldKnowledgeLibraryService
}

export class KnowledgeWebImportService {
  readonly #client: FirecrawlClient
  readonly #library: WorldKnowledgeLibraryService

  constructor(options: KnowledgeWebImportServiceOptions) {
    this.#client = options.client
    this.#library = options.library
  }

  search(input: { workspaceId: string; query: string; limit?: number }): Promise<FirecrawlSearchItem[]> {
    return this.#client.search(input)
  }

  async importUrl(input: {
    workspaceId: string
    worldId: string
    url: string
    collectionId?: string
    collectionName?: string
    title?: string
  }): Promise<KnowledgeDocument> {
    const scraped = await this.#client.scrape({ workspaceId: input.workspaceId, url: input.url })
    const title = input.title?.trim() || scraped.title || scraped.url
    const collectionId = input.collectionId
    const collectionName = input.collectionName
    return this.#library.createFromText({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      title,
      text: renderImportedPage(scraped.markdown, scraped.url),
      relativePath: `web/${safeFileName(title)}-${shortHash(scraped.url)}.md`,
      ...(collectionId === undefined ? {} : { collectionId }),
      ...(collectionName === undefined ? {} : { collectionName }),
      collectionOrigin: 'web',
      sourceUrl: scraped.url,
    })
  }
}

function renderImportedPage(markdown: string, url: string): string {
  // The URL is host-authored metadata; page markdown remains quoted external
  // data and is never interpreted as a prompt or a command.
  return `来源：${url}\n\n${markdown}`
}

function safeFileName(value: string): string {
  return value.replace(/[\0\r\n]/g, ' ').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'web-page'
}

function shortHash(value: string): string {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
