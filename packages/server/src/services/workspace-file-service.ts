import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

import { ServiceError } from './service-error.js'

const MAX_WORKSPACE_PREVIEW_BYTES = 2 * 1024 * 1024

export interface WorkspaceFileListItem {
  name: string
  path: string
  kind: 'directory' | 'file'
  size: number
  updatedAt: string
  previewKind: 'text' | 'image' | undefined
}

export interface WorkspaceFileList {
  path: string
  parentPath?: string
  items: WorkspaceFileListItem[]
}

export interface WorkspaceFilePreview {
  body: Buffer
  contentType: string
}

export class WorkspaceFileService {
  readonly #workspaceRoot: string
  #resolvedWorkspaceRoot: Promise<string> | undefined

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot
  }

  #resolveWorkspaceRoot(): Promise<string> {
    // realpath 会把 Windows 8.3 短名（如 C:\Users\ADMINI~1\...）展开为完整路径；
    // target 侧同样经过 realpath，两侧必须基于同一展开结果比较，否则前缀比对会误判"逃逸"。
    this.#resolvedWorkspaceRoot ??= realpath(this.#workspaceRoot).catch(() => resolve(this.#workspaceRoot))
    return this.#resolvedWorkspaceRoot
  }

  async list(requestedPath: string): Promise<WorkspaceFileList> {
    const directory = await this.#resolveEntry(requestedPath)
    const directoryInfo = await stat(directory.absolutePath)
    if (!directoryInfo.isDirectory()) {
      throw new ServiceError('invalid', 'workspace_directory_required', 'Workspace path is not a directory')
    }
    const items = await Promise.all((await readdir(directory.absolutePath, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map(async (entry): Promise<WorkspaceFileListItem | undefined> => {
        const entryPath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name
        if (workspaceEntryIsHidden(entryPath)) return undefined
        const entryInfo = await stat(join(directory.absolutePath, entry.name))
        return {
          name: entry.name,
          path: entryPath,
          kind: entryInfo.isDirectory() ? 'directory' : 'file',
          size: entryInfo.isFile() ? entryInfo.size : 0,
          updatedAt: entryInfo.mtime.toISOString(),
          previewKind: entryInfo.isFile() ? workspacePreviewKind(entry.name)?.kind : undefined,
        }
      }))
    return {
      path: directory.relativePath,
      ...(directory.relativePath.includes('/')
        ? { parentPath: directory.relativePath.slice(0, directory.relativePath.lastIndexOf('/')) }
        : directory.relativePath ? { parentPath: '' } : {}),
      items: items
        .filter((entry): entry is WorkspaceFileListItem => entry !== undefined)
        .sort((left, right) => left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === 'directory' ? -1 : 1),
    }
  }

  async preview(requestedPath: string): Promise<WorkspaceFilePreview> {
    const file = await this.#resolveEntry(requestedPath)
    const fileInfo = await stat(file.absolutePath)
    if (!fileInfo.isFile()) throw new ServiceError('invalid', 'workspace_file_required', 'Workspace path is not a file')
    if (fileInfo.size > MAX_WORKSPACE_PREVIEW_BYTES) {
      throw new ServiceError('too-large', 'workspace_file_too_large', 'Workspace preview is limited to 2 MiB')
    }
    const preview = workspacePreviewKind(file.relativePath)
    if (preview === undefined) throw new ServiceError('unsupported', 'workspace_file_unsupported', 'File type cannot be previewed')
    return { body: await readFile(file.absolutePath), contentType: preview.contentType }
  }

  async #resolveEntry(requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
    const normalized = requestedPath.replaceAll('\\', '/').replace(/^\.\//, '')
    if (
      normalized.includes('\0') ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => part === '..') ||
      workspaceEntryIsHidden(normalized)
    ) {
      throw new ServiceError('forbidden', 'workspace_path_rejected', 'Workspace path is not accessible')
    }
    const candidate = resolve(this.#workspaceRoot, ...normalized.split('/').filter(Boolean))
    let absolutePath: string
    try {
      absolutePath = await realpath(candidate)
    } catch (error) {
      if (isMissingFile(error)) throw new ServiceError('not-found', 'workspace_entry_not_found', 'Workspace entry not found')
      throw error
    }
    const workspaceRoot = await this.#resolveWorkspaceRoot()
    if (!pathIsInside(workspaceRoot, absolutePath)) {
      throw new ServiceError('forbidden', 'workspace_path_rejected', 'Workspace path escapes the configured root')
    }
    const relativePath = relative(workspaceRoot, absolutePath).split(sep).join('/')
    if (workspaceEntryIsHidden(relativePath)) {
      throw new ServiceError('forbidden', 'workspace_path_rejected', 'Workspace path is not accessible')
    }
    return { absolutePath, relativePath }
  }
}

function pathIsInside(root: string, target: string): boolean {
  const normalizeCase = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const normalizedRoot = normalizeCase(resolve(root))
  const normalizedTarget = normalizeCase(resolve(target))
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

function workspaceEntryIsHidden(relativePath: string): boolean {
  if (!relativePath) return false
  const segments = relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  const hiddenDirectories = new Set(['node_modules', 'dist', 'coverage', '.git', '.ssh'])
  const sensitiveFiles = new Set(['credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'])
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    return segment.startsWith('.') || hiddenDirectories.has(lower) || sensitiveFiles.has(lower)
  })
}

function workspacePreviewKind(fileName: string): { kind: 'text' | 'image'; contentType: string } | undefined {
  const extension = extname(fileName).toLowerCase()
  const images: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  const imageType = images[extension]
  if (imageType !== undefined) return { kind: 'image', contentType: imageType }
  const textExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
    '.css', '.scss', '.html', '.yaml', '.yml', '.toml', '.sql', '.py', '.rs',
    '.go', '.java', '.kt', '.swift', '.sh', '.ps1', '.bat', '.cmd', '.xml',
    '.svg', '.csv',
  ])
  return textExtensions.has(extension)
    ? { kind: 'text', contentType: 'text/plain; charset=utf-8' }
    : undefined
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
