import { describe, expect, it } from 'vitest'

import { packageManifest } from '../src/http/request.js'

describe('package manifest parser', () => {
  it('accepts skin packages through the generic preview and install contract', () => {
    const manifest = packageManifest({
      schemaVersion: 1,
      id: 'generated.skin.example',
      version: '1.0.0',
      kind: 'skin',
      displayName: 'Example skin',
      summary: 'A declaration-only skin package.',
      license: 'LicenseRef-DSH-Cyber-Local',
      publisher: 'Test',
      capabilities: ['ui:skin'],
      dataEgress: [],
      files: [{ path: 'skin.json', sha256: 'a'.repeat(64) }],
      entrypoints: [{ id: 'generated.skin.example', kind: 'skin', path: 'skin.json' }],
    })

    expect(manifest).toMatchObject({
      kind: 'skin',
      entrypoints: [{ kind: 'skin', path: 'skin.json' }],
    })
  })
})
