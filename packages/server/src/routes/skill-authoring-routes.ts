import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { dirname, resolve, sep } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { JsonObject, SkillAuthoringDraft, SkillAuthoringPublishResult, SkillAuthoringSource } from '@dsh-cyber/contracts'
import type { LocalPackageCatalog, PackageManager, ReversiblePackageInstallation } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { optionalString, packageManifest, readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import { commitGeneratedPackage, prepareGeneratedPackagePaths, type GeneratedPackagePaths } from '../services/generated-package-publish.js'
import { normalizeSkillDraft, normalizeSkillSource, type SkillAuthoringAnalyzerPort } from '../services/skill-authoring-analyzer.js'
import { compileSkillPackage } from '../services/skill-package-compiler.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'

export interface SkillAuthoringRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  analyzer: SkillAuthoringAnalyzerPort
  packageManager: PackageManager
  worldPackages: Pick<WorldPackageInstanceService, 'instantiate'>
  worldAccess: Pick<WorldAccessService, 'assertUnlocked'>
  resolveMarketplaceRoot(workspaceId: string): string
  containmentRoot?: string
}

export function registerSkillAuthoringRoutes(router: Router, dependencies: SkillAuthoringRoutesDependencies): void {
  const containment = dependencies.containmentRoot === undefined ? undefined : resolve(dependencies.containmentRoot)

  router.post(/^\/api\/workspaces\/([^/]+)\/skill-authoring\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(dependencies.store, workspaceId)
    const body = await readJson(request)
    const source = sourceInput(body.source)
    const current = body.current === undefined ? undefined : normalizeSkillDraft(body.current)
    writeJson(response, 200, await dependencies.analyzer.analyze({ workspaceId, source, ...(current === undefined ? {} : { current }) }))
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/skill-authoring\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(dependencies.store, workspaceId)
    const body = await readJson(request)
    const source = normalizeSkillSource(sourceInput(body.source))
    const draft = normalizeSkillDraft(body.draft, source)
    const base = basePackage(dependencies.store, workspaceId, body.basePackageId, body.basePackageVersion, draft)
    const packageId = base?.packageId ?? `generated.skill.${randomUUID().replaceAll('-', '')}`
    const packageVersion = base === undefined ? '1.0.0' : nextPatch(base.version)
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = containment ?? marketplaceRoot
    const storageId = `${packageId}-${packageVersion.replaceAll('.', '-')}`
    let paths: GeneratedPackagePaths | undefined
    let committed = false
    try {
      paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'plugins', storageId, token())
      const { manifest } = await compileSkillPackage({
        sourceDirectory: paths.stagingDirectory, packageId, packageVersion, draft,
        source: { originalText: source.text, originalFormat: source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt', analysis: draft as unknown as JsonObject },
      })
      await commitGeneratedPackage(containmentRoot, paths); committed = true
      const item = await dependencies.packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified || item.manifest.kind !== 'skill') throw new Error('Generated skill package failed catalog verification')
      const output: SkillAuthoringPublishResult = { item, draft }
      writeJson(response, 201, output)
    } catch (error) {
      if (paths !== undefined) await rm(committed ? paths.installedDirectory : paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'skill_publish_failed', error instanceof Error ? error.message : '技能包发布失败')
    }
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/skill-authoring\/import$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(dependencies.store, workspaceId)
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')) {
      throw new HttpError(415, 'skill_import_multipart_required', '技能包导入需要 ZIP 或文件夹文件流。')
    }
    const form = await parseSkillPackageMultipart(request)
    const worldId = optionalString(form.fields.worldId)
    if (worldId !== undefined) {
      const world = dependencies.store.getWorld(worldId)
      if (world === undefined || world.workspaceId !== workspaceId) throw new HttpError(422, 'skill_import_world_invalid', '目标世界与工作区不匹配。')
      await dependencies.worldAccess.assertUnlocked(worldId, request)
    }
    const uploaded = form.files.length === 1 && isZipName(form.files[0]!.fileName)
      ? readZipPackageFiles(form.files[0]!.bytes)
      : form.files.map((file, index) => ({ path: form.relativePaths[index] ?? file.fileName, bytes: file.bytes }))
    const files = normalizePackageRoot(uploaded)
    const manifestFile = files.find((file) => file.path === 'dsh-cyber.package.json')
    if (manifestFile === undefined) throw new HttpError(422, 'skill_import_manifest_missing', '技能包根目录需要 dsh-cyber.package.json。')
    let manifest: ReturnType<typeof packageManifest>
    try { manifest = packageManifest(JSON.parse(manifestFile.bytes.toString('utf8'))) }
    catch (error) { throw new HttpError(422, 'skill_import_manifest_invalid', error instanceof Error ? error.message : '技能包清单无效。') }
    if (manifest.kind !== 'skill') throw new HttpError(422, 'skill_import_kind_invalid', '导入入口只接受 kind=skill 的技能包。')

    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = dependencies.containmentRoot === undefined ? marketplaceRoot : dependencies.containmentRoot
    const paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'plugins', `imported-skill-${token()}`, token())
    let installation: ReversiblePackageInstallation | undefined
    let committed = false
    try {
      await writePackageUpload(paths.stagingDirectory, files)
      const approval = dependencies.packageManager.preview(workspaceId, manifest)
      installation = await dependencies.packageManager.installReversible({
        workspaceId,
        manifest,
        sourceDirectory: paths.stagingDirectory,
        approvalToken: approval.approvalToken,
        actorId: 'owner',
      })
      await commitGeneratedPackage(containmentRoot, paths)
      committed = true
      dependencies.packageCatalog.invalidate()
      const instance = worldId === undefined ? undefined : await dependencies.worldPackages.instantiate({ worldId, packageId: manifest.id, version: manifest.version, actorId: 'owner' })
      writeJson(response, 201, { installed: installation.installed, ...(instance === undefined ? {} : { instance }) })
    } catch (error) {
      if (!committed && installation !== undefined) await dependencies.packageManager.compensate(installation, 'skill_import_failed').catch(() => undefined)
      if (!committed) await rm(paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'skill_import_failed', error instanceof Error ? error.message : '技能包导入失败。')
    }
  })
}

interface UploadedPackageFile { fileName: string; bytes: Buffer }
interface NormalizedPackageFile { path: string; bytes: Buffer }
interface SkillPackageMultipart { fields: Record<string, string>; files: UploadedPackageFile[]; relativePaths: Array<string | undefined> }

const MAX_SKILL_UPLOAD_BYTES = 256 * 1024 * 1024
const MAX_SKILL_UPLOAD_FILES = 2_048
const MAX_SKILL_UPLOAD_FILE_BYTES = 64 * 1024 * 1024

async function parseSkillPackageMultipart(request: IncomingMessage): Promise<SkillPackageMultipart> {
  const contentType = String(request.headers['content-type'] ?? '')
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (boundary === undefined || boundary.length > 120 || /[\r\n]/u.test(boundary)) throw new HttpError(400, 'skill_import_boundary_invalid', '技能包导入边界无效。')
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SKILL_UPLOAD_BYTES) throw new HttpError(413, 'skill_import_too_large', '技能包导入内容超过 256 MiB。')
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (total > MAX_SKILL_UPLOAD_BYTES) throw new HttpError(413, 'skill_import_too_large', '技能包导入内容超过 256 MiB。')
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  const marker = Buffer.from(`--${boundary}`)
  const files: UploadedPackageFile[] = []
  const fields: Record<string, string> = {}
  let cursor = body.indexOf(marker)
  while (cursor >= 0 && files.length <= MAX_SKILL_UPLOAD_FILES) {
    let partStart = cursor + marker.length
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') break
    if (body.subarray(partStart, partStart + 2).toString('ascii') !== '\r\n') throw new HttpError(400, 'skill_import_multipart_invalid', '技能包导入分段无效。')
    partStart += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart)
    if (headerEnd < 0) throw new HttpError(400, 'skill_import_multipart_invalid', '技能包导入分段头无效。')
    const headers = parseMultipartHeaders(body.subarray(partStart, headerEnd).toString('latin1'))
    const contentStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart)
    if (nextBoundary < 0) throw new HttpError(400, 'skill_import_multipart_invalid', '技能包导入缺少结束边界。')
    const content = body.subarray(contentStart, nextBoundary)
    const disposition = headers['content-disposition'] ?? ''
    const name = /(?:^|;)\s*name="([^"]+)"/iu.exec(disposition)?.[1]
    if (name === undefined) throw new HttpError(400, 'skill_import_multipart_invalid', '技能包导入字段缺少名称。')
    const fileName = /(?:^|;)\s*filename="([^"]*)"/iu.exec(disposition)?.[1]
    if (fileName !== undefined && fileName !== '') {
      if (content.length > MAX_SKILL_UPLOAD_FILE_BYTES) throw new HttpError(413, 'skill_import_file_too_large', '技能包单文件超过 64 MiB。')
      files.push({ fileName: fileName.replaceAll('\\', '/').split('/').pop() ?? 'upload', bytes: Buffer.from(content) })
    } else {
      const value = content.toString('utf8')
      if (value.includes('\uFFFD') || value.length > 1_000_000) throw new HttpError(422, 'skill_import_field_invalid', '技能包导入字段无效。')
      fields[name] = value
    }
    cursor = nextBoundary + 2
  }
  if (files.length === 0) throw new HttpError(422, 'skill_import_file_required', '请选择 ZIP 或技能包文件夹。')
  if (files.length > MAX_SKILL_UPLOAD_FILES) throw new HttpError(413, 'skill_import_file_count_rejected', '技能包文件数量超过限制。')
  return { fields, files, relativePaths: parseRelativePaths(fields.relativePaths, files.length) }
}

function parseMultipartHeaders(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of value.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return result
}

function parseRelativePaths(value: string | undefined, count: number): Array<string | undefined> {
  if (value === undefined || value.trim() === '') return Array.from({ length: count }, () => undefined)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => item !== null && typeof item !== 'string')) throw new Error()
    return Array.from({ length: count }, (_, index) => typeof parsed[index] === 'string' ? parsed[index] : undefined)
  } catch { throw new HttpError(422, 'skill_import_relative_paths_invalid', '技能包文件相对路径无效。') }
}

function isZipName(fileName: string): boolean { return fileName.toLowerCase().endsWith('.zip') }

function normalizePackageRoot(files: Array<{ path: string; bytes: Buffer }>): NormalizedPackageFile[] {
  const normalized = files.map((file) => ({ path: normalizePackagePath(file.path), bytes: file.bytes }))
  const manifestPaths = normalized.filter((file) => file.path === 'dsh-cyber.package.json' || file.path.endsWith('/dsh-cyber.package.json'))
  if (manifestPaths.length !== 1) throw new HttpError(422, 'skill_import_manifest_count_invalid', '技能包需要且只能包含一个 dsh-cyber.package.json。')
  const manifestPath = manifestPaths[0]!.path
  const prefix = manifestPath === 'dsh-cyber.package.json' ? '' : manifestPath.slice(0, -'dsh-cyber.package.json'.length)
  const result = normalized.map((file) => {
    if (prefix !== '' && !file.path.startsWith(prefix)) throw new HttpError(422, 'skill_import_root_invalid', '技能包文件必须位于同一个包目录中。')
    return { path: prefix === '' ? file.path : file.path.slice(prefix.length), bytes: file.bytes }
  })
  if (!result.some((file) => file.path === 'dsh-cyber.package.json')) throw new HttpError(422, 'skill_import_manifest_missing', '技能包根目录缺少清单。')
  if (new Set(result.map((file) => file.path)).size !== result.length) throw new HttpError(422, 'skill_import_duplicate_file', '技能包包含重复文件路径。')
  return result
}

function normalizePackagePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) throw new HttpError(422, 'skill_import_path_invalid', '技能包文件路径必须是相对路径。')
  const parts = normalized.split('/').filter((part) => part.length > 0)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) throw new HttpError(422, 'skill_import_path_invalid', `技能包文件路径无效：${value}`)
  return parts.join('/')
}

async function writePackageUpload(directory: string, files: readonly NormalizedPackageFile[]): Promise<void> {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  for (const file of files) {
    const target = resolve(directory, ...file.path.split('/'))
    if (!target.startsWith(`${resolve(directory)}${sep}`)) throw new HttpError(422, 'skill_import_path_invalid', '技能包文件路径越界。')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 })
  }
}

function readZipPackageFiles(bytes: Buffer): Array<{ path: string; bytes: Buffer }> {
  const eocd = findZipEnd(bytes)
  const count = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new HttpError(422, 'skill_import_zip64_unsupported', '暂不支持 ZIP64 技能包。')
  if (count > MAX_SKILL_UPLOAD_FILES || centralOffset + centralSize > eocd) throw new HttpError(413, 'skill_import_zip_too_large', 'ZIP 技能包目录超过限制。')
  const files: Array<{ path: string; bytes: Buffer }> = []
  let cursor = centralOffset
  let expanded = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包中央目录无效。')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const externalAttributes = bytes.readUInt32LE(cursor + 38)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8')
    cursor = nameStart + nameLength + extraLength + commentLength
    if (name.includes('\uFFFD')) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包文件名编码无效。')
    if ((externalAttributes >>> 16 & 0xf000) === 0xa000) throw new HttpError(422, 'skill_import_zip_symlink', 'ZIP 技能包不能包含符号链接。')
    if (name.endsWith('/')) continue
    if ((flags & 1) !== 0) throw new HttpError(422, 'skill_import_zip_encrypted', '不支持加密 ZIP 技能包。')
    if (uncompressedSize > MAX_SKILL_UPLOAD_FILE_BYTES || compressedSize > MAX_SKILL_UPLOAD_FILE_BYTES) throw new HttpError(413, 'skill_import_file_too_large', 'ZIP 技能包单文件超过 64 MiB。')
    if (compressedSize > 0 && uncompressedSize / compressedSize > 1000) throw new HttpError(413, 'skill_import_zip_bomb', 'ZIP 技能包压缩比超过限制。')
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包本地文件头无效。')
    if (bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包本地文件头与中央目录不一致。')
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')
    if (localName !== name || dataStart > centralOffset || dataEnd > centralOffset) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包数据越界。')
    const compressed = bytes.subarray(dataStart, dataEnd)
    let body: Buffer
    if (method === 0) body = Buffer.from(compressed)
    else if (method === 8) {
      try { body = inflateRawSync(compressed) }
      catch { throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包无法解压。') }
    } else throw new HttpError(422, 'skill_import_zip_method_unsupported', 'ZIP 技能包仅支持 Store 和 Deflate。')
    if (body.length !== uncompressedSize || crc32(body) !== expectedCrc) {
      throw new HttpError(422, 'skill_import_zip_integrity_failed', 'ZIP 技能包完整性校验失败。')
    }
    expanded += body.length
    if (expanded > MAX_SKILL_UPLOAD_BYTES) throw new HttpError(413, 'skill_import_zip_expanded_too_large', 'ZIP 技能包解压后超过 256 MiB。')
    files.push({ path: normalizePackagePath(name), bytes: body })
  }
  if (cursor !== centralOffset + centralSize) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包中央目录长度无效。')
  return files
}

function findZipEnd(bytes: Buffer): number {
  if (bytes.length < 22) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包过短。')
  const start = Math.max(0, bytes.length - 65_557)
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes.readUInt32LE(index) !== 0x06054b50) continue
    const commentLength = bytes.readUInt16LE(index + 20)
    if (index + 22 + commentLength !== bytes.length) continue
    if (bytes.readUInt16LE(index + 4) !== 0 || bytes.readUInt16LE(index + 6) !== 0) throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包多磁盘结构无效。')
    return index
  }
  throw new HttpError(422, 'skill_import_zip_invalid', 'ZIP 技能包缺少结束记录。')
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function sourceInput(value: unknown): SkillAuthoringSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'skill_source_invalid', '技能来源必须是对象。')
  return { kind: source.kind as SkillAuthoringSource['kind'], text: source.text as string, ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }) }
}

function basePackage(store: SqliteStore, workspaceId: string, packageIdValue: unknown, versionValue: unknown, draft: SkillAuthoringDraft): { packageId: string; version: string } | undefined {
  if (packageIdValue === undefined && versionValue === undefined) return undefined
  if (typeof packageIdValue !== 'string' || typeof versionValue !== 'string' || !packageIdValue.startsWith('generated.skill.')) throw new HttpError(422, 'skill_edit_source_invalid', '只能为技能中心创建的技能发布新版本。')
  const installed = store.getInstalledPackage(workspaceId, packageIdValue, versionValue)
  const ownsSkill = installed?.manifest.entrypoints?.some((entrypoint) => entrypoint.kind === 'skill' && entrypoint.id === draft.id) === true
  if (installed === undefined || installed.kind !== 'skill' || !ownsSkill) throw new HttpError(422, 'skill_edit_source_invalid', '技能编辑来源与当前草稿不匹配。')
  return { packageId: installed.packageId, version: installed.version }
}

function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) throw new HttpError(422, 'skill_version_invalid', '当前技能版本无法自动递增。')
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}
function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void { if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found') }
function token(): string { return randomUUID().replaceAll('-', '') }
