import { describe, expect, it } from 'vitest'
import { StreamingSentenceChunker } from '../src/features/voice/StreamingSentenceChunker.js'

describe('StreamingSentenceChunker', () => {
  it('emits the first natural Chinese sentence before the full response', () => {
    const chunker = new StreamingSentenceChunker()
    expect(chunker.push('我先检查昨天的服务日志。后面')).toEqual(['我先检查昨天的服务日志。'])
    expect(chunker.flush()).toEqual(['后面'])
  })

  it('uses bounded soft splits and does not split decimal points', () => {
    const chunker = new StreamingSentenceChunker()
    const input = '当前版本是 2.5.1，服务在凌晨两点出现内存持续增长，但进程仍然继续运行并等待检查'
    const chunks = chunker.push(input)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('2.5.1')
    expect(chunks[0]!.length).toBeLessThanOrEqual(35)
    expect([...chunks, ...chunker.flush()].join('')).toBe(input)
  })

  it('resets cleanly when a turn is interrupted', () => {
    const chunker = new StreamingSentenceChunker(); chunker.push('不会完成的旧回复'); chunker.reset()
    expect(chunker.push('这是新回复。')).toEqual(['这是新回复。'])
  })
})
