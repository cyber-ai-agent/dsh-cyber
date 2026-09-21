import { beforeEach, describe, expect, it } from 'vitest'
import { ChatSubmissionStore, type ChatSubmission } from '../src/chat-submission-store.js'

function submission(id: string, worldId = 'world-a'): ChatSubmission {
  return {
    id, worldId, queueKey: 'direct:character', ownerKey: JSON.stringify([worldId, 'direct:character']),
    title: '管家', employeeIds: ['character'], createdAt: new Date(0).toISOString(), status: 'sending',
    body: JSON.stringify({ clientTurnId: id, prompt: '检查资料', queueMode: 'normal', modelProfileId: 'model-a' }),
    draft: { text: '检查资料', modelProfileId: 'model-a', attachments: [{ id: 'attachment-a', name: '资料.txt', status: 'ready', attachment: { assetId: 'asset-a', name: '资料.txt', mimeType: 'text/plain', byteLength: 8, url: '/api/worlds/world-a/assets/asset-a' } }] },
  }
}

describe('chat submission recovery', () => {
  beforeEach(() => window.sessionStorage.clear())

  it('retains the exact request and original draft across reload while marking unfinished delivery uncertain', () => {
    const store = new ChatSubmissionStore()
    const item = submission('first')
    store.put(item)
    const reloaded = new ChatSubmissionStore().getSnapshot()[0]!
    expect(reloaded).toEqual({ ...item, status: 'uncertain' })
    expect(reloaded.body).toBe(item.body)
    expect(reloaded.draft.attachments[0]?.attachment?.assetId).toBe('asset-a')
    expect(reloaded.draft.modelProfileId).toBe('model-a')
  })

  it('settles only the acknowledged submission and keeps other worlds and newer submissions recoverable', () => {
    const store = new ChatSubmissionStore()
    store.put(submission('first'))
    store.put({ ...submission('second'), status: 'rejected', error: '请检查内容' })
    store.put(submission('other-world', 'world-b'))
    store.remove('first')
    expect(new ChatSubmissionStore().getSnapshot().map((item) => [item.id, item.status])).toEqual([
      ['second', 'rejected'], ['other-world', 'uncertain'],
    ])
  })

  it('refuses a corrupted receipt whose request id or world differs from its owner', () => {
    window.sessionStorage.setItem('dsh-cyber:chat-submissions:v1', JSON.stringify([
      { ...submission('bad-id'), body: JSON.stringify({ clientTurnId: 'another-id', prompt: '检查' }) },
      { ...submission('bad-owner'), ownerKey: JSON.stringify(['another-world', 'direct:character']) },
    ]))
    expect(new ChatSubmissionStore().getSnapshot()).toEqual([])
  })
})
