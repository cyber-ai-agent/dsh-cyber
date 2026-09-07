import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldTraceToolStep } from '@dsh-cyber/contracts'
import { WorldTraceToolItem } from '../src/components/world-trace/WorldTraceToolItem.js'

let root: Root | undefined
let container: HTMLDivElement
const base: WorldTraceToolStep = { callId: 'c', name: 'read', label: '读取文件', status: 'success', description: 'src/character-profile-runtime.ts', input: 'src/character-profile-runtime.ts', durationMs: 11 }
function mount(patch: Partial<WorldTraceToolStep> = {}) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<ul><WorldTraceToolItem tool={{ ...base, ...patch }} /></ul>))
  return container
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks() })

describe('owner-facing tool evidence', () => {
  it('shows a path once instead of repeating summary and input', () => {
    const view = mount()
    expect(view.textContent!.split(base.input!).length - 1).toBe(1)
    expect(view.querySelector('details')).toBeNull()
    expect(view.textContent).not.toContain('匹配')
  })
  it('expands distinct parameters and actual result, with truthful truncation notices', () => {
    const view = mount({ input: `${base.input} · offset=20 · limit=5`, output: '20 export const value = 1\n21 // next', outputTruncated: true, outputRedacted: true })
    const details = [...view.querySelectorAll('details')]
    expect(details).toHaveLength(2)
    expect(details[1]?.textContent).toContain('已截断')
    expect(details[1]?.textContent).toContain('已脱敏')
    act(() => details[1]!.querySelector('summary')!.click())
    expect(details[1]!.open).toBe(true)
    expect(details[1]!.querySelector('pre')!.textContent).toContain('20 export const value')
  })
  it('copies only displayed sanitized result and reports copy failure', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText: copy } as unknown as Clipboard)
    const view = mount({ output: 'token=[已隐藏敏感信息]' })
    const button = [...view.querySelectorAll('button')].find((entry) => entry.textContent?.includes('复制结果'))!
    await act(async () => button.click())
    expect(copy).toHaveBeenCalledWith('token=[已隐藏敏感信息]')
    expect(view.querySelector('[role=status]')?.textContent).toBe('已复制')
    copy.mockRejectedValue(new Error('denied'))
    await act(async () => button.click())
    expect(view.querySelector('[role=status]')?.textContent).toContain('复制失败')
  })
  it('does not equate writing an artifact manifest with publishing an artifact', () => {
    const view = mount({ name: 'write', label: '写入文件', input: '.dsh/artifacts/run-123.json', description: '.dsh/artifacts/run-123.json' })
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
