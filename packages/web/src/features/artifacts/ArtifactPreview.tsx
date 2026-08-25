import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ClipboardText, Code, FilePdf, LinkSimple, List, SpinnerGap } from '@phosphor-icons/react'
import { useEffect, useState, type ReactNode } from 'react'

import type { WorldArtifactKind } from '@dsh-cyber/contracts'

import {
  artifactFileUrl,
  artifactKindFromPath,
  artifactKindLabel,
  fetchArtifactPreview,
  type ArtifactFileEntry,
  type ArtifactPreviewPayload,
  type ArtifactRecord,
} from './useWorldArtifacts.js'

export interface ArtifactPreviewProps {
  worldId: string
  artifact: ArtifactRecord
  preview?: ArtifactPreviewPayload
  file?: ArtifactFileEntry
}

export function ArtifactPreview({ worldId, artifact, preview: providedPreview, file }: ArtifactPreviewProps) {
  const hasInlineFilePreview = file?.content !== undefined || file?.src !== undefined
  const filePreview = file === undefined || !hasInlineFilePreview ? undefined : {
    ...(file.content === undefined ? {} : { content: file.content }),
    ...(file.src === undefined ? {} : { src: file.src }),
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    ...(file.byteLength === undefined ? {} : { byteLength: file.byteLength }),
  }
  const [preview, setPreview] = useState<ArtifactPreviewPayload | undefined>(providedPreview ?? artifact.preview ?? filePreview)
  const [loading, setLoading] = useState(providedPreview === undefined && artifact.preview === undefined && filePreview === undefined)
  const [error, setError] = useState<string>()
  const [showOriginal, setShowOriginal] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ownedObjectUrl, setOwnedObjectUrl] = useState<string>()

  useEffect(() => {
    setPreview(providedPreview ?? artifact.preview ?? filePreview)
    setError(undefined)
    setShowOriginal(false)
  }, [artifact.id, artifact.preview, file?.byteLength, file?.content, file?.mimeType, file?.path, file?.src, providedPreview])

  useEffect(() => {
    if (providedPreview !== undefined || artifact.preview !== undefined || filePreview !== undefined) {
      setLoading(false)
      return
    }
    let current = true
    setLoading(true)
    void fetchArtifactPreview(worldId, artifact, artifact.currentVersion, file?.path).then((value) => {
      if (!current) return
      setPreview(value)
      if (value.src?.startsWith('blob:')) setOwnedObjectUrl(value.src)
      setLoading(false)
    }).catch((cause) => {
      if (!current) return
      setError(cause instanceof Error ? cause.message : '产物预览加载失败')
      setLoading(false)
    })
    return () => { current = false }
  }, [artifact, file?.byteLength, file?.content, file?.mimeType, file?.path, file?.src, providedPreview, worldId])

  useEffect(() => () => {
    if (ownedObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(ownedObjectUrl)
  }, [ownedObjectUrl])

  const content = preview?.content
  const mimeType = preview?.mimeType ?? artifact.currentVersionInfo?.mimeType ?? mimeTypeForArtifact(artifact)
  const path = file?.path ?? artifact.currentVersionInfo?.relativePath ?? artifact.title
  const kind = file?.kind ?? (artifact.kind === 'project' ? 'project' : artifactKindFromPath(path, mimeType))
  const openHref = artifactFileUrl(worldId, artifact.id, artifact.currentVersion, file?.path)
  const source = preview?.src ?? (kind === 'image' || mimeType === 'application/pdf' || kind === 'html' ? openHref : undefined)
  const rawValue = content ?? ''

  const copy = async () => {
    if (rawValue.length === 0 || typeof navigator === 'undefined' || navigator.clipboard === undefined) return
    try {
      await navigator.clipboard.writeText(rawValue)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      setError('复制失败，请使用查看原文')
    }
  }

  if (loading) return <div className="artifact-preview-state" role="status"><SpinnerGap size={22} className="spin" /><span>正在读取产物…</span></div>
  if (error !== undefined && preview === undefined) {
    return <div className="artifact-preview-state artifact-preview-state--error" role="alert"><strong>无法打开这个产物</strong><span>{error}</span><a href={artifactFileUrl(worldId, artifact.id, artifact.currentVersion)} target="_blank" rel="noreferrer">打开文件</a></div>
  }
  if (showOriginal && rawValue.length > 0) {
    return <div className="artifact-reader">
      <ReaderToolbar copied={copied} onCopy={() => void copy()} onOriginal={() => setShowOriginal(false)} openHref={openHref} />
      <pre className="artifact-source-view" tabIndex={0}>{rawValue}</pre>
    </div>
  }
  if (kind === 'image') return <div className="artifact-reader artifact-reader--media"><ReaderToolbar copied={copied} onCopy={() => void copy()} onOriginal={rawValue.length > 0 ? () => setShowOriginal(true) : undefined} openHref={openHref} /><img src={source} alt={`${artifact.title}预览`} className="artifact-image-preview" /></div>
  if (mimeType === 'application/pdf' || path.toLocaleLowerCase().endsWith('.pdf')) return <div className="artifact-reader artifact-reader--media"><ReaderToolbar copied={copied} onCopy={() => void copy()} onOriginal={rawValue.length > 0 ? () => setShowOriginal(true) : undefined} openHref={openHref} /><iframe className="artifact-pdf-preview" title={`${artifact.title} PDF 预览`} src={source} /></div>
  if (kind === 'html') return <HtmlReader artifact={artifact} source={source} content={content} copied={copied} onCopy={() => void copy()} onOriginal={rawValue.length > 0 ? () => setShowOriginal(true) : undefined} openHref={openHref} />
  if (kind === 'project') return <ProjectReader worldId={worldId} artifact={artifact} {...(preview === undefined ? {} : { preview })} />
  if (kind === 'markdown') return <MarkdownReader value={rawValue} copied={copied} onCopy={() => void copy()} onOriginal={() => setShowOriginal(true)} openHref={openHref} />
  if (kind === 'json') return <JsonReader value={rawValue} copied={copied} onCopy={() => void copy()} onOriginal={() => setShowOriginal(true)} openHref={openHref} />
  if (kind === 'code') return <CodeReader value={rawValue} language={languageForPath(path)} copied={copied} onCopy={() => void copy()} onOriginal={() => setShowOriginal(true)} openHref={openHref} />
  if (rawValue.length > 0) return <TextReader value={rawValue} copied={copied} onCopy={() => void copy()} onOriginal={() => setShowOriginal(true)} openHref={openHref} />
  return <div className="artifact-preview-state"><FilePdf size={22} /><strong>暂无可用预览</strong><span>可以打开原始文件查看完整内容。</span><a href={artifactFileUrl(worldId, artifact.id, artifact.currentVersion)} target="_blank" rel="noreferrer">打开文件</a></div>
}

function ReaderToolbar({ copied, onCopy, onOriginal, openHref }: { copied: boolean; onCopy(): void; onOriginal: (() => void) | undefined; openHref: string | undefined }) {
  return <div className="artifact-reader-toolbar" role="toolbar" aria-label="产物阅读操作">
    {onOriginal === undefined ? null : <button type="button" onClick={onOriginal}><Code size={16} />查看原文</button>}
    <button type="button" onClick={onCopy} disabled={onOriginal === undefined && !copied}><ClipboardText size={16} />{copied ? '已复制' : '复制'}</button>
    {openHref === undefined ? null : <a href={openHref} target="_blank" rel="noreferrer"><LinkSimple size={16} />打开文件</a>}
  </div>
}

function MarkdownReader({ value, copied, onCopy, onOriginal, openHref }: { value: string; copied: boolean; onCopy(): void; onOriginal(): void; openHref: string | undefined }) {
  return <div className="artifact-reader artifact-markdown-reader">
    <ReaderToolbar copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} />
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...props }) => <a {...props} href={safeHref(href)} target="_blank" rel="noreferrer">{children}</a>,
        code: ({ className, children, ...props }) => <code {...props} className={className}>{children}</code>,
      }}
    >{value}</ReactMarkdown>
  </div>
}

function TextReader({ value, copied, onCopy, onOriginal, openHref }: { value: string; copied: boolean; onCopy(): void; onOriginal(): void; openHref: string | undefined }) {
  return <div className="artifact-reader artifact-text-reader"><ReaderToolbar copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} /><pre tabIndex={0}>{value}</pre></div>
}

function CodeReader({ value, language, copied, onCopy, onOriginal, openHref }: { value: string; language: string; copied: boolean; onCopy(): void; onOriginal(): void; openHref: string | undefined }) {
  return <div className="artifact-reader artifact-code-reader">
    <header className="artifact-code-reader__header"><span><Code size={16} />{language}</span><ReaderToolbar copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} /></header>
    <pre tabIndex={0} aria-label={`代码预览，${language}`}><code>{value.split('\n').map((line, index) => <span className="artifact-code-line" key={`${index}-${line}`}><i aria-hidden="true">{String(index + 1).padStart(3, ' ')}</i><span>{highlightCodeLine(line, language)}</span>{index < value.split('\n').length - 1 ? '\n' : ''}</span>)}</code></pre>
  </div>
}

function JsonReader({ value, copied, onCopy, onOriginal, openHref }: { value: string; copied: boolean; onCopy(): void; onOriginal(): void; openHref: string | undefined }) {
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch { return <TextReader value={value} copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} /> }
  return <div className="artifact-reader artifact-json-reader"><header><span><List size={16} />JSON 结构</span><ReaderToolbar copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} /></header><JsonTree value={parsed} /></div>
}

function JsonTree({ value, label, depth = 0 }: { value: unknown; label?: string; depth?: number }): ReactNode {
  if (Array.isArray(value)) {
    return <details open={depth < 2} className="artifact-json-node"><summary>{label === undefined ? '数组' : label} <small>{value.length} 项</small></summary><div>{value.map((item, index) => <JsonTree key={index} value={item} label={String(index)} depth={depth + 1} />)}</div></details>
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return <details open={depth < 2} className="artifact-json-node"><summary>{label === undefined ? '对象' : label} <small>{entries.length} 个字段</small></summary><div>{entries.map(([key, item]) => <JsonTree key={key} value={item} label={key} depth={depth + 1} />)}</div></details>
  }
  return <div className="artifact-json-value"><span className="artifact-json-key">{label}</span><strong className={`artifact-json-value--${value === null ? 'null' : typeof value}`}>{formatJsonValue(value)}</strong></div>
}

function HtmlReader({ artifact, source, content, copied, onCopy, onOriginal, openHref }: { artifact: ArtifactRecord; source: string | undefined; content: string | undefined; copied: boolean; onCopy(): void; onOriginal: (() => void) | undefined; openHref: string | undefined }) {
  return <div className="artifact-reader artifact-html-reader">
    <div className="artifact-html-reader__notice"><Code size={16} /><span>网页在隔离沙箱中打开，不能访问 DSH Cyber 应用数据。</span></div>
    <ReaderToolbar copied={copied} onCopy={onCopy} onOriginal={onOriginal} openHref={openHref} />
    <iframe className="artifact-html-preview" title={`${artifact.title}网页预览`} sandbox="allow-scripts" {...(content === undefined ? { src: source } : { srcDoc: withPreviewCsp(content) })} />
  </div>
}

function ProjectReader({ worldId, artifact, preview }: { worldId: string; artifact: ArtifactRecord; preview?: ArtifactPreviewPayload }) {
  const files = artifact.files ?? preview?.files ?? []
  const [selectedPath, setSelectedPath] = useState(files[0]?.path)
  const selected = files.find((file) => file.path === selectedPath) ?? files[0]
  if (files.length === 0) return <div className="artifact-preview-state"><Code size={22} /><strong>项目目录尚未返回文件树</strong><span>打开项目文件查看器，或等待服务端返回项目索引。</span><a href={artifactFileUrl(worldId, artifact.id, artifact.currentVersion)} target="_blank" rel="noreferrer">打开项目文件</a></div>
  const selectedKind = selected === undefined ? 'other' : selected.kind ?? artifactKindFromPath(selected.path, selected.mimeType)
  const fileArtifact: ArtifactRecord = { ...artifact, title: selected?.title ?? selected?.path ?? artifact.title, kind: selectedKind as WorldArtifactKind, ...(artifact.currentVersionInfo === undefined ? {} : { currentVersionInfo: { ...artifact.currentVersionInfo, relativePath: selected?.path ?? artifact.currentVersionInfo.relativePath, ...(selected?.mimeType === undefined ? {} : { mimeType: selected.mimeType }) } }) }
  return <div className="artifact-project-reader">
    <aside className="artifact-project-tree" aria-label="项目文件树"><header><strong>项目文件</strong><span>{files.length} 个文件</span></header><ul>{files.map((file) => <li key={file.path}><button type="button" className={file.path === selected?.path ? 'is-active' : ''} onClick={() => setSelectedPath(file.path)} title={file.path}><span>{file.path.split('/').pop()}</span><small>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '根目录'}</small></button></li>)}</ul></aside>
    <div className="artifact-project-reader__content">{selected === undefined ? null : <ArtifactPreview worldId={worldId} artifact={fileArtifact} file={selected} />}</div>
  </div>
}

function highlightCodeLine(line: string, language: string): ReactNode {
  const pattern = /(\/\/.*|#.*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|class|interface|type|import|export|from|if|else|for|while|new|async|await|public|private|true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)/g
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(line.slice(last, start))
    const className = match[1] !== undefined ? 'comment' : match[2] !== undefined ? 'string' : match[3] !== undefined ? 'keyword' : 'number'
    nodes.push(<mark className={`artifact-code-token artifact-code-token--${className}`} key={`${start}-${match[0]}`}>{match[0]}</mark>)
    last = start + match[0].length
  }
  if (last < line.length) nodes.push(line.slice(last))
  return <>{nodes.length === 0 ? line : nodes}</>
}

function withPreviewCsp(value: string): string {
  const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src data: blob:; style-src 'unsafe-inline\">"
  return /<head\b[^>]*>/i.test(value) ? value.replace(/<head\b[^>]*>/i, (match) => `${match}${csp}`) : `${csp}${value}`
}

function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined
  if (/^(?:https?:|mailto:|#|\/)/i.test(href)) return href
  return '#'
}

function formatJsonValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function mimeTypeForArtifact(artifact: ArtifactRecord): string | undefined {
  if (artifact.kind === 'image') return 'image/*'
  if (artifact.kind === 'html') return 'text/html'
  if (artifact.kind === 'markdown') return 'text/markdown'
  if (artifact.kind === 'code') return 'text/plain'
  if (artifact.kind === 'data') return 'application/json'
  return undefined
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLocaleLowerCase()
  const languages: Record<string, string> = { ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', css: 'CSS', scss: 'SCSS', html: 'HTML', htm: 'HTML', py: 'Python', java: 'Java', go: 'Go', rs: 'Rust', sql: 'SQL', sh: 'Shell', yml: 'YAML', yaml: 'YAML', xml: 'XML' }
  return extension === undefined ? '代码' : languages[extension] ?? extension.toUpperCase()
}

export function previewKindLabel(artifact: ArtifactRecord): string {
  return artifactKindLabel(artifact.kind)
}
