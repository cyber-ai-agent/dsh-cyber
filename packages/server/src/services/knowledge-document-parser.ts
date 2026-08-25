export const KNOWLEDGE_DOCUMENT_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxExtractedChars: 2_000_000,
  maxChunks: 4_000,
  maxPdfPages: 2_000,
  chunkTargetChars: 1_000,
  chunkOverlapChars: 120,
} as const

export type KnowledgeDocumentMimeType = 'text/markdown' | 'text/plain' | 'application/json' | 'application/pdf'

export interface ParsedKnowledgeDocument {
  title: string
  mimeType: KnowledgeDocumentMimeType
  content: string
  chunks: ParsedKnowledgeChunk[]
}

export interface ParsedKnowledgeChunk {
  ordinal: number
  content: string
  startOffset: number
  endOffset: number
  contentHash?: string
}

export interface ParseKnowledgeDocumentInput {
  bytes: Buffer
  fileName: string
  mimeType?: string
  title?: string
}

/** Parse the supported source formats without shipping a browser/PDF parser. */
export async function parseKnowledgeDocument(input: ParseKnowledgeDocumentInput): Promise<ParsedKnowledgeDocument> {
  if (input.bytes.byteLength === 0) throw new KnowledgeParseError('empty_document', '知识文档不能为空')
  if (input.bytes.byteLength > KNOWLEDGE_DOCUMENT_LIMITS.maxSourceBytes) throw new KnowledgeParseError('source_too_large', '知识文档超过大小限制')
  const mimeType = detectMimeType(input.fileName, input.mimeType)
  const raw = mimeType === 'application/pdf' ? await extractPdfText(input.bytes) : decodeText(input.bytes)
  const content = normalizeDocumentText(mimeType === 'application/json' ? jsonToText(raw) : raw)
  if (content.length === 0) throw new KnowledgeParseError('empty_document', '知识文档没有可索引正文')
  if (content.length > KNOWLEDGE_DOCUMENT_LIMITS.maxExtractedChars) throw new KnowledgeParseError('extracted_too_large', '解析后的知识文档超过字符限制')
  const chunks = chunkKnowledgeText(content)
  const title = normalizeTitle(input.title) ?? titleFromContent(content) ?? fileTitle(input.fileName)
  return { title, mimeType, content, chunks }
}

export function chunkKnowledgeText(
  content: string,
  options: { targetChars?: number; overlapChars?: number; maxChunks?: number } = {},
): ParsedKnowledgeChunk[] {
  const target = bounded(options.targetChars, KNOWLEDGE_DOCUMENT_LIMITS.chunkTargetChars, 32, 4_000)
  const overlap = bounded(options.overlapChars, KNOWLEDGE_DOCUMENT_LIMITS.chunkOverlapChars, 0, Math.floor(target / 2))
  const maxChunks = bounded(options.maxChunks, KNOWLEDGE_DOCUMENT_LIMITS.maxChunks, 1, KNOWLEDGE_DOCUMENT_LIMITS.maxChunks)
  const normalized = normalizeDocumentText(content)
  if (!normalized) return []

  const paragraphs = splitParagraphs(normalized)
  const chunks: ParsedKnowledgeChunk[] = []
  let current = ''
  let currentStart = 0
  let lastEnd = 0

  const emit = (value: string, start: number, end: number): void => {
    const text = value.trim()
    if (!text) return
    if (chunks.length >= maxChunks) throw new KnowledgeParseError('chunk_limit', '知识文档分块数量超过限制')
    chunks.push({ ordinal: chunks.length, content: text, startOffset: start, endOffset: end })
    lastEnd = end
  }

  const flush = (): void => {
    if (current.trim()) emit(current, currentStart, currentStart + current.length)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.text.length <= target) {
      const candidate = current ? `${current}\n\n${paragraph.text}` : paragraph.text
      if (current && candidate.length > target) {
        flush()
        const tail = overlapTail(chunks.at(-1)?.content ?? '', overlap)
        current = tail ? `${tail}\n\n${paragraph.text}` : paragraph.text
        currentStart = Math.max(0, paragraph.start - tail.length)
      } else {
        if (!current) currentStart = paragraph.start
        current = candidate
      }
      continue
    }

    flush()
    const points = Array.from(paragraph.text)
    let cursor = 0
    while (cursor < points.length) {
      const tail = overlapTail(chunks.at(-1)?.content ?? '', overlap)
      const room = Math.max(1, target - (tail ? tail.length + 2 : 0))
      const slice = points.slice(cursor, cursor + room).join('')
      const value = tail ? `${tail}\n\n${slice}` : slice
      emit(value, paragraph.start + cursor - (tail ? Math.min(tail.length, cursor) : 0), paragraph.start + cursor + slice.length)
      cursor += slice.length
    }
    lastEnd = paragraph.end
  }
  flush()
  return chunks
}

export class KnowledgeParseError extends Error {
  constructor(readonly code: 'empty_document' | 'source_too_large' | 'extracted_too_large' | 'chunk_limit' | 'unsupported_format' | 'invalid_json' | 'invalid_pdf' | 'pdf_text_unavailable', message: string) {
    super(message)
    this.name = 'KnowledgeParseError'
  }
}

function detectMimeType(fileName: string, hint: string | undefined): KnowledgeDocumentMimeType {
  const normalizedHint = hint?.split(';')[0]?.trim().toLowerCase()
  if (normalizedHint === 'text/markdown' || normalizedHint === 'text/plain' || normalizedHint === 'application/json' || normalizedHint === 'application/pdf') return normalizedHint
  const extension = fileName.toLowerCase().split('.').pop()
  if (extension === 'md' || extension === 'markdown') return 'text/markdown'
  if (extension === 'txt' || extension === 'text') return 'text/plain'
  if (extension === 'json') return 'application/json'
  if (extension === 'pdf') return 'application/pdf'
  throw new KnowledgeParseError('unsupported_format', '知识库仅支持 Markdown、TXT、JSON 和 PDF')
}

function decodeText(bytes: Buffer): string {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  if (text.includes('\uFFFD')) throw new KnowledgeParseError('unsupported_format', '文本文件不是有效 UTF-8')
  return text
}

function jsonToText(raw: string): string {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new KnowledgeParseError('invalid_json', 'JSON 文档格式无效') }
  // Do not pretty-print untrusted JSON before applying the extracted-size
  // limit. Deeply nested objects can expand dramatically with indentation and
  // turn a bounded upload into an avoidable memory spike.
  return JSON.stringify(value)
}

function normalizeDocumentText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitParagraphs(value: string): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = []
  const pattern = /\S[\s\S]*?(?=\n\n|$)/g
  for (const match of value.matchAll(pattern)) {
    const text = match[0]?.trim()
    const start = match.index ?? 0
    if (text) result.push({ text, start, end: start + text.length })
  }
  return result.length === 0 ? [{ text: value, start: 0, end: value.length }] : result
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new KnowledgeParseError('invalid_pdf', 'PDF 文档头无效')
  try {
    // Keep this import in the server parser.  A static web import would pull
    // a worker/PDF runtime into the browser bundle, which is precisely why
    // PDF parsing belongs behind the Host boundary.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      stopAtErrors: true,
    })
    const document = await loading.promise
    if (document.numPages > KNOWLEDGE_DOCUMENT_LIMITS.maxPdfPages) {
      await document.destroy()
      throw new KnowledgeParseError('extracted_too_large', 'PDF 页数超过知识库限制')
    }
    const pages: string[] = []
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        const textContent = await page.getTextContent({ includeMarkedContent: false })
        const strings = textContent.items
          .flatMap((item) => 'str' in item && typeof item.str === 'string' ? [item.str] : [])
        const characterItems = strings.filter((value) => Array.from(value).length <= 1).length
        const pageText = strings.length > 3 && characterItems / strings.length >= 0.6
          ? compactPdfCharacterItems(strings)
          : strings.join(' ')
        if (pageText.trim()) pages.push(pageText)
        page.cleanup()
        if (pages.join('\n').length > KNOWLEDGE_DOCUMENT_LIMITS.maxExtractedChars) {
          throw new KnowledgeParseError('extracted_too_large', '解析后的知识文档超过字符限制')
        }
      }
    } finally {
      await document.destroy()
    }
    const text = normalizeDocumentText(pages.join('\n\n'))
    if (!text) throw new KnowledgeParseError('pdf_text_unavailable', 'PDF 没有可提取的文本内容')
    return text
  } catch (error) {
    if (error instanceof KnowledgeParseError) throw error
    throw new KnowledgeParseError('invalid_pdf', `PDF 解析失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function compactPdfCharacterItems(values: readonly string[]): string {
  // Some Identity-H PDFs expose one TextItem per glyph. PDF.js preserves the
  // original space glyph and our separator would otherwise produce "P a g e".
  // Three or more spaces are the original word boundary; a single separator
  // between letters is an extraction artifact.
  return values.join(' ')
    .replace(/ {2,}/g, '\u0000')
    .replace(/(?<=\p{L}) (?=\p{L})/gu, '')
    .replaceAll('\u0000', ' ')
}

function titleFromContent(value: string): string | undefined {
  const heading = /^\s*#\s+(.+)$/m.exec(value)?.[1]
  return normalizeTitle(heading)
}

function fileTitle(value: string): string {
  const name = value.replaceAll('\\', '/').split('/').pop() ?? '未命名知识'
  return name.replace(/\.[^.]+$/, '').trim().slice(0, 240) || '未命名知识'
}

function normalizeTitle(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.replace(/[\r\n\0]/g, ' ').trim().slice(0, 240)
  return title || undefined
}

function overlapTail(value: string, count: number): string { return Array.from(value).slice(-count).join('') }

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)))
}
