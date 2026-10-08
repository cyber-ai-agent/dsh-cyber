import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validatePackageManifest } from '@dsh-cyber/package-runtime'

import { importSkillMarkdownPackage, parseSkillMarkdown } from '../src/services/skill-markdown-import.js'

const markdown = '---\nname: evidence-review\ndescription: >\n  Review evidence for project\n  decisions.\nlicense: Apache-2.0\nmetadata:\n  author: Example Author\n  source: https://example.test/skills\n  commit: "abc123"\n---\n# Review\n\nKeep the original evidence.\n'

describe('SKILL.md compatibility import', () => {
  it('parses safe YAML and keeps the entire Markdown body', () => {
    expect(parseSkillMarkdown(markdown)).toMatchObject({
      name: 'evidence-review', description: 'Review evidence for project decisions.\n',
      license: 'Apache-2.0', metadata: { author: 'Example Author', source: 'https://example.test/skills', commit: 'abc123' },
      body: '# Review\n\nKeep the original evidence.\n', warnings: [],
    })
    expect(parseSkillMarkdown(markdown.replaceAll('\n', '\r\n')).body).toContain('# Review\r\n')
  })

  it('preserves source, license, attribution, commit and binary resources byte for byte in an immutable native package', () => {
    const source = Buffer.from(markdown)
    const license = Buffer.from('Copyright Original Author\r\nLicense terms\r\n')
    const asset = Buffer.from([0, 1, 0xff, 2, 0x1b])
    const originals = [{ path: 'SKILL.md', bytes: source }, { path: 'LICENSE', bytes: license }, { path: 'assets/reference.bin', bytes: asset }]
    const imported = importSkillMarkdownPackage(originals)
    expect(() => validatePackageManifest(imported.manifest)).not.toThrow()
    expect(imported.manifest).toMatchObject({ kind: 'skill', license: 'Apache-2.0', publisher: 'Example Author', capabilities: ['skill:recipe'], dataEgress: [] })
    const skill = JSON.parse(imported.files.find((file) => file.path === 'skill.json')!.bytes.toString())
    expect(skill).toMatchObject({ integrationId: 'builtin.recipe', dependencies: [], dataEgress: [], instructionFile: 'source/SKILL.md', resources: ['source/LICENSE', 'source/assets/reference.bin'] })
    expect(skill.instructions).not.toContain('Keep the original evidence')
    for (const original of originals) {
      expect(imported.files.find((file) => file.path === `source/${original.path}`)?.bytes).toEqual(original.bytes)
      expect(imported.manifest.files).toContainEqual({ path: `source/${original.path}`, sha256: createHash('sha256').update(original.bytes).digest('hex') })
    }
    expect(importSkillMarkdownPackage([...originals].reverse()).manifest).toEqual(imported.manifest)
    expect(importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: Buffer.from(`${markdown}Changed.\n`) }]).manifest.id).not.toBe(imported.manifest.id)
  })

  it('preserves an oversized-for-native description and body without injecting them into metadata', () => {
    const description = 'A'.repeat(1024)
    const body = '# Details\n' + 'Preserve this paragraph.\n'.repeat(1000)
    const original = Buffer.from(`---\nname: long-guide\ndescription: ${description}\n---\n${body}`)
    const imported = importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: original }])
    expect(imported.manifest.summary).toHaveLength(500)
    expect(imported.files.find((file) => file.path === 'source/SKILL.md')?.bytes).toEqual(original)
    expect(parseSkillMarkdown(original).body).toBe(body)
    expect(imported.files.find((file) => file.path === 'skill.json')!.bytes.length).toBeLessThan(2000)
  })

  it('keeps unsupported declarations inert and warns without inventing permissions or attribution', () => {
    const original = Buffer.from('---\nname: unsafe-request\ndescription: Inspect data.\nallowed-tools: Bash(*) Read\ncompatibility: Requires network and npm install\nmodel: custom-model\n---\nRun scripts/tool.js\n')
    const imported = importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: original }, { path: 'scripts/tool.js', bytes: Buffer.from('throw new Error("must never run")') }])
    expect(imported.warnings.join('\n')).toContain('allowed-tools')
    expect(imported.warnings.join('\n')).toContain('compatibility')
    expect(imported.warnings.join('\n')).toContain('model')
    expect(imported.manifest).toMatchObject({ license: 'LicenseRef-Unknown', publisher: '来源未声明', capabilities: ['skill:recipe'], dataEgress: [] })
    expect(imported.files.find((file) => file.path === 'source/scripts/tool.js')?.bytes.toString()).toContain('must never run')
  })

  it('supports standard empty metadata strings and warns about preserved resources beyond the text read limit', () => {
    const source = Buffer.from('---\nname: simple-guide\ndescription: A guide.\nmetadata:\n  note: ""\n  author: ""\n---\n')
    expect(parseSkillMarkdown(source).metadata.note).toBe('')
    const large = Buffer.alloc(512 * 1024 + 1, 'x')
    const imported = importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: source }, { path: 'assets/large.txt', bytes: large }])
    expect(imported.manifest.publisher).toBe('来源未声明')
    expect(imported.files.find((file) => file.path === 'source/assets/large.txt')?.bytes).toEqual(large)
    expect(imported.warnings.join('\n')).toContain('512 KiB')
  })

  it('preserves license file references and prose without assigning an invented SPDX license', () => {
    for (const license of ['LICENSE.txt', 'Proprietary. LICENSE.txt has complete terms']) {
      const imported = importSkillMarkdownPackage([
        { path: 'SKILL.md', bytes: Buffer.from(markdown.replace('Apache-2.0', license)) },
        { path: 'LICENSE.txt', bytes: Buffer.from('Original licensing terms.') },
      ])
      expect(imported.manifest.license).toBe('LicenseRef-Source')
    }
  })

  it.each([
    ['missing frontmatter', '# Title\n'],
    ['unclosed frontmatter', '---\nname: valid\n'],
    ['duplicate field', '---\nname: first\nname: second\ndescription: text\n---\n'],
    ['unsafe YAML tag', '---\nname: valid\ndescription: !custom text\n---\n'],
    ['YAML alias', '---\nname: valid\ndescription: &text text\nmodel: *text\n---\n'],
    ['YAML merge', '---\nname: valid\ndescription: text\nmetadata:\n  <<: { author: fake }\n---\n'],
    ['prototype key', '---\nname: valid\ndescription: text\nmetadata:\n  __proto__: unsafe\n---\n'],
    ['non-string metadata', '---\nname: valid\ndescription: text\nmetadata:\n  version: 1\n---\n'],
    ['non-string description', '---\nname: valid\ndescription: [text]\n---\n'],
    ['invalid name', '---\nname: Bad--Name\ndescription: text\n---\n'],
    ['control characters', '---\nname: valid\ndescription: text\n---\n\u001b[31m'],
    ['multiple YAML documents', '---\nname: valid\ndescription: text\n...\nname: other\n---\n'],
  ])('rejects %s', (_label, source) => { expect(() => parseSkillMarkdown(source)).toThrow() })

  it('rejects invalid UTF-8 and bounds YAML and document size', () => {
    expect(() => parseSkillMarkdown(Buffer.from([0xff]))).toThrow('UTF-8')
    expect(() => parseSkillMarkdown(`${markdown}${'x'.repeat(512 * 1024)}`)).toThrow('512 KiB')
    expect(() => parseSkillMarkdown(`---\nname: valid\ndescription: text\n#${'x'.repeat(64 * 1024)}\n---\n`)).toThrow('64 KiB')
  })

  it.each(['../outside', '/etc/file', 'C:/file', 'folder\\file', '.git/config', 'file\u0000.txt', 'folder/../file', 'file:alternate', 'CON', 'a./file'])('rejects unsafe source path %s', (path) => {
    expect(() => importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: Buffer.from(markdown) }, { path, bytes: Buffer.from('data') }])).toThrow('Unsafe')
  })

  it('rejects case-ambiguous resource paths', () => {
    expect(() => importSkillMarkdownPackage([{ path: 'SKILL.md', bytes: Buffer.from(markdown) }, { path: 'LICENSE', bytes: Buffer.from('A') }, { path: 'license', bytes: Buffer.from('B') }])).toThrow('ambiguous')
  })

  it('rejects resource counts and paths beyond the lazy-reader contract', () => {
    const skill = { path: 'SKILL.md', bytes: Buffer.from(markdown) }
    expect(() => importSkillMarkdownPackage([skill, ...Array.from({ length: 257 }, (_, index) => ({ path: `refs/${index}.md`, bytes: Buffer.from('data') }))])).toThrow('256')
    expect(() => importSkillMarkdownPackage([skill, { path: 'a'.repeat(234), bytes: Buffer.from('data') }])).toThrow('Unsafe')
    expect(() => importSkillMarkdownPackage([skill, { path: 'nested/SKILL.md', bytes: Buffer.from(markdown) }])).toThrow('unambiguous')
  })
})
