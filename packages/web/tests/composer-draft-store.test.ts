import { beforeEach, describe, expect, it } from 'vitest'

import type { ChatAttachment } from '@dsh-cyber/contracts'

import {
  ComposerDraftStore,
  composerDraftOwnerKey,
  type ComposerAttachmentDraft,
} from '../src/composer-draft-store.js'

const ownerA = composerDraftOwnerKey('world-a', 'conversation-a')
const ownerB = composerDraftOwnerKey('world-b', 'conversation-a')

function attachment(assetId: string, url = `/api/worlds/world-a/assets/${assetId}`): ChatAttachment {
  return {
    assetId,
    name: `${assetId}.txt`,
    mimeType: 'text/plain',
    byteLength: 12,
    url,
  }
}

function ready(id: string, value = attachment(id)): ComposerAttachmentDraft {
  return { id, name: value.name, byteLength: value.byteLength, mimeType: value.mimeType, status: 'ready', attachment: value }
}

describe('ComposerDraftStore', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('uses a structured world and conversation owner key', () => {
    expect(composerDraftOwnerKey('world:a', 'conversation:b')).not.toBe(composerDraftOwnerKey('world', 'a:conversation:b'))
    expect(JSON.parse(ownerA)).toEqual(['world-a', 'conversation-a'])
  })

  it('persists the stable intent alias for a bound group session', () => {
    const store = new ComposerDraftStore()
    store.setSessionOwnerAlias('world-a', 'session-created-later', 'intent:group:a,b:短会')
    const restored = new ComposerDraftStore()
    expect(restored.getSessionOwnerAlias('world-a', 'session-created-later')).toBe('intent:group:a,b:短会')
  })

  it('isolates text and attachments between worlds with the same conversation key', () => {
    const store = new ComposerDraftStore()
    store.setText(ownerA, '世界 A 的草稿')
    store.setText(ownerB, '世界 B 的草稿')
    store.setAttachments(ownerA, [ready('asset-a')])
    store.setModelProfile(ownerA, 'temporary-model-a')

    expect(store.get(ownerA)).toMatchObject({ text: '世界 A 的草稿', modelProfileId: 'temporary-model-a' })
    expect(store.get(ownerA).attachments.map((item) => item.attachment?.assetId)).toEqual(['asset-a'])
    expect(store.get(ownerB)).toMatchObject({ text: '世界 B 的草稿', attachments: [] })
  })

  it('does not silently truncate an over-limit draft before server validation', () => {
    const store = new ComposerDraftStore()
    const text = 'a'.repeat(32_001)
    store.setText(ownerA, text)
    expect(store.get(ownerA).text).toBe(text)
  })

  it('persists text, model id, and server attachment refs while restoring uploads as interrupted', () => {
    const store = new ComposerDraftStore()
    store.setText(ownerA, '刷新后仍要保留')
    store.setModelProfile(ownerA, 'temporary-model-a')
    store.setAttachments(ownerA, [
      ready('server-asset'),
      ready('blob-asset', attachment('blob-asset', 'blob:http://localhost/one')),
      { id: 'upload-1', name: '进行中的文件.txt', byteLength: 20, status: 'uploading' },
    ])

    const restored = new ComposerDraftStore()
    const draft = restored.get(ownerA)
    expect(draft.text).toBe('刷新后仍要保留')
    expect(draft.modelProfileId).toBe('temporary-model-a')
    expect(draft.attachments).toEqual([
      expect.objectContaining({ id: 'server-asset', status: 'ready', attachment: expect.objectContaining({ assetId: 'server-asset' }) }),
      expect.objectContaining({ id: 'upload-1', status: 'interrupted', error: '页面刷新时上传未完成，请重新选择文件。' }),
    ])
  })

  it('consumes only the submitted snapshot and keeps newer typing or uploads', () => {
    const store = new ComposerDraftStore()
    store.setText(ownerA, '已提交文本')
    store.setAttachments(ownerA, [ready('submitted'), ready('newer')])
    const submittedRevision = store.get(ownerA).revision
    store.setText(ownerA, '新的文本')
    store.consume(ownerA, { text: '已提交文本', attachmentIds: ['submitted'], revision: submittedRevision })

    expect(store.get(ownerA).text).toBe('新的文本')
    expect(store.get(ownerA).attachments.map((item) => item.attachment?.assetId)).toEqual(['newer'])

    store.setText(ownerA, '已提交文本')
    const abaRevision = store.get(ownerA).revision
    store.setText(ownerA, '临时改动')
    store.setText(ownerA, '已提交文本')
    store.consume(ownerA, { text: '已提交文本', attachmentIds: [], revision: abaRevision })
    expect(store.get(ownerA).text).toBe('已提交文本')
  })

  it('clears only the selected owner draft and its temporary model selection', () => {
    const store = new ComposerDraftStore()
    store.setText(ownerA, '清空我')
    store.setAttachments(ownerA, [ready('asset-a')])
    store.setModelProfile(ownerA, 'temporary-model-a')
    store.setText(ownerB, '保留我')

    store.clear(ownerA)
    expect(store.get(ownerA)).toMatchObject({ text: '', attachments: [] })
    expect(store.get(ownerA).modelProfileId).toBeUndefined()
    expect(store.get(ownerB).text).toBe('保留我')
  })

  it('notifies subscribers when a world draft set is explicitly discarded', () => {
    const store = new ComposerDraftStore()
    store.setText(ownerA, '世界 A')
    store.setText(ownerB, '世界 B')
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    store.clearWorld('world-a')
    unsubscribe()
    expect(notifications).toBe(1)
    expect(store.get(ownerA)).toMatchObject({ text: '', attachments: [] })
    expect(store.get(ownerB).text).toBe('世界 B')
  })
})
