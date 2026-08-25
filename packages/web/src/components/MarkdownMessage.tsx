import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { mentionPlugin } from './mention-plugin.js'

export function MarkdownMessage({ value, worldId }: { value: string; worldId: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm, mentionPlugin]} components={{ a: ({ href, children, ...props }) => <ArtifactAwareLink href={href} worldId={worldId} {...props}>{children}</ArtifactAwareLink> }}>{linkArtifactPaths(value, worldId)}</ReactMarkdown></div>
}

function ArtifactAwareLink({ href, worldId, children, ...props }: ComponentPropsWithoutRef<'a'> & { worldId: string; children?: ReactNode }) {
  const artifactUrl = href === undefined ? undefined : artifactUrlForPath(href, worldId)
  const className = [props.className, 'artifact-aware-link'].filter(Boolean).join(' ')
  return <a {...props} className={className} href={artifactUrl ?? href} target="_blank" rel="noreferrer">{children}</a>
}

function linkArtifactPaths(value: string, worldId: string): string {
  const absolutePattern = new RegExp(`(?:[A-Za-z]:[\\\\/]|/)[^\\n\\r<>"']*?${escapeRegExp(worldId)}[\\\\/]files[\\\\/][^\\n\\r<>"']+`, 'gi')
  const withAbsoluteLinks = value.replace(absolutePattern, (match) => {
    const cleaned = trimPathPunctuation(match)
    const url = artifactUrlForPath(cleaned, worldId)
    return url === undefined ? match : `[打开产物：${fileName(cleaned)}](${url})`
  })
  const relativePattern = new RegExp(`(^|[\\s\\[{(：:])(${escapeRegExp(worldId)}[\\\\/]files[\\\\/][^\\n\\r<>"']+)`, 'gi')
  return withAbsoluteLinks.replace(relativePattern, (match, prefix: string, path: string) => {
    const cleaned = trimPathPunctuation(path)
    const url = artifactUrlForPath(cleaned, worldId)
    return url === undefined ? match : `${prefix}[打开产物：${fileName(cleaned)}](${url})`
  })
}

function artifactUrlForPath(value: string, worldId: string): string | undefined {
  const normalized = decodeMaybeUri(value).replaceAll('\\', '/')
  const marker = `/${worldId}/files/`
  const markerIndex = normalized.toLocaleLowerCase().lastIndexOf(marker.toLocaleLowerCase())
  if (markerIndex < 0) return undefined
  const relative = normalized.slice(markerIndex + marker.length).replace(/^\/+/, '')
  if (!relative || relative.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return undefined
  return `/api/worlds/${encodeURIComponent(worldId)}/file?path=${encodeURIComponent(relative)}`
}

function decodeMaybeUri(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function trimPathPunctuation(value: string): string {
  return value.replace(/[。，、；：！？）】》」』,.;:!?\]}>]+$/g, '')
}

function fileName(value: string): string {
  return value.replaceAll('\\', '/').split('/').pop() ?? '产物文件'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
