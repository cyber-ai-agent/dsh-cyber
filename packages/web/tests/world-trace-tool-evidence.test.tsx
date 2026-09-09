import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldTraceToolStep } from '@dsh-cyber/contracts'
import { WorldTraceToolItem } from '../src/components/world-trace/WorldTraceToolItem.js'

let root: Root | undefined
let container: HTMLDivElement
const base: WorldTraceToolStep = { callId: 'c', name: 'pwsh', label: '执行本地命令', status: 'success', input: 'Get-ChildItem src', output: 'file-a.ts\nfile-b.ts', durationMs: 11 }
function mount(patch: Partial<WorldTraceToolStep> = {}) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<ul><WorldTraceToolItem tool={{ ...base, ...patch }} /></ul>))
  return container
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks() })

describe('owner-facing tool evidence', () => {
  it('keeps the label + tool name heading, and drops the redundant target command line', () => {
    const view = mount()
    expect(view.textContent).toContain('执行本地命令')
    expect(view.textContent).toContain('pwsh')
    expect(view.querySelector('.world-trace-tool__target')).toBeNull()
    // No copy affordances at all: the owner selects text in the box.
    expect(view.querySelector('button')).toBeNull()
  })
  it('shows command and result in one box, collapsed to five lines by default', () => {
    const view = mount({ output: Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join('\n') })
    const box = view.querySelector('.world-trace-tool__evidence')!
    expect(box).not.toBeNull()
    // Collapsed: a five-line preview without section labels.
    expect(box.querySelector('pre')!.textContent).toContain('Get-ChildItem src')
    expect(box.textContent).toContain('line-4')
    expect(box.textContent).not.toContain('line-8')
    expect(box.classList.contains('is-clickable')).toBe(true)
    act(() => box.querySelector('pre')!.click())
    // Expanded: the full raw command and the full raw result, labeled.
    expect(box.textContent).toContain('line-8')
    expect(box.textContent).toContain('命令')
    expect(box.textContent).toContain('结果')
    act(() => box.querySelector('pre')!.click())
    expect(box.textContent).not.toContain('line-8')
  })
  it('shows short content in full without an expand affordance', () => {
    const view = mount()
    const box = view.querySelector('.world-trace-tool__evidence')!
    expect(box.classList.contains('is-clickable')).toBe(false)
    expect(box.querySelector('pre')!.textContent).toBe('Get-ChildItem src\nfile-a.ts\nfile-b.ts')
  })
  it('renders only the available side when the result is missing', () => {
    const view = mount({ output: undefined, status: 'running' })
    const box = view.querySelector('.world-trace-tool__evidence')!
    expect(box.querySelector('pre')!.textContent).toBe('Get-ChildItem src')
    expect(box.textContent).not.toContain('结果')
  })
  it('does not equate writing an artifact manifest with publishing an artifact', () => {
    const view = mount({ name: 'write', label: '写入文件', input: '.dsh/artifacts/run-123.json' })
    expect(view.textContent).toContain('写入产物登记清单')
    expect(view.textContent).toContain('不同步骤')
    expect(view.textContent).not.toContain('登记成功')
  })
  it('shows a nonzero exit as a warning rather than successful execution', () => {
    const view = mount({ name: 'bash', exitCode: 3 })
    expect(view.textContent).toContain('退出码：3')
    expect(view.textContent).toContain('非零退出')
    expect(view.querySelector('.has-warning')).not.toBeNull()
  })
})
