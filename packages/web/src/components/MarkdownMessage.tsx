import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { mentionPlugin } from './mention-plugin.js'

export function MarkdownMessage({ value }: { value: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm, mentionPlugin]}>{value}</ReactMarkdown></div>
}
