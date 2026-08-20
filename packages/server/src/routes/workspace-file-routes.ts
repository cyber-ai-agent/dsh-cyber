import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { writeJson, writeWorkspaceFile } from '../http/response.js'
import { isMissingFile } from '../http/static-files.js'

const MAX_WORKSPACE_PREVIEW_BYTES = 2 * 1024 * 1024

export interface WorkspaceFileRoutesDependencies {
  workspaceRoot: string
}

export function registerWorkspaceFileRoutes(
  router: Router,
  dependencies: WorkspaceFileRoutesDependencies,
): void {
  const { workspaceRoot } = dependencies

  router.get('/api/workspace/files', async ({ response, url }) => {
    const directory = await resolveWorkspaceEntry(workspaceRoot, url.searchParams.get('path') ?? '')
    const directoryInfo = await stat(directory.absolutePath)
    if (!directoryInfo.isDirectory()) {
      throw new HttpError(422, 'workspace_directory_required', 'Workspace path is not a directory')
    }
    const items = await Promise.all((await readdir(directory.absolutePath, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map(async (entry) => {
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
    writeJson(response, 200, {
      path: directory.relativePath,
      parentPath: directory.relativePath.includes('/')
        ? directory.relativePath.slice(0, directory.relativePath.lastIndexOf('/'))
        : directory.relativePath ? '' : undefined,
      items: items
        .filter((entry) => entry !== undefined)
        .sort((left, right) => left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === 'directory' ? -1 : 1),
    })
  })

  router.get('/api/workspace/file', async ({ response, url }) => {
    const file = await resolveWorkspaceEntry(workspaceRoot, url.searchParams.get('path') ?? '')
    const fileInfo = await stat(file.absolutePath)
    if (!fileInfo.isFile()) throw new HttpError(422, 'workspace_file_required', 'Workspace path is not a file')
    if (fileInfo.size > MAX_WORKSPACE_PREVIEW_BYTES) {
      throw new HttpError(413, 'workspace_file_too_large', 'Workspace preview is limited to 2 MiB')
    }
    const preview = workspacePreviewKind(file.relativePath)
    if (preview === undefined) throw new HttpError(415, 'workspace_file_unsupported', 'File type cannot be previewed')
    writeWorkspaceFile(response, await readFile(file.absolutePath), preview.contentType)
  })
}

async function resolveWorkspaceEntry(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const normalized = requestedPath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..') ||
    workspaceEntryIsHidden(normalized)
  ) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path is not accessible')
  }
  const candidate = resolve(workspaceRoot, ...normalized.split('/').filter(Boolean))
  let absolutePath: string
  try {
    absolutePath = await realpath(candidate)
  } catch (error) {
    if (isMissingFile(error)) throw new HttpError(404, 'workspace_entry_not_found', 'Workspace entry not found')
    throw error
  }
  if (!pathIsInside(workspaceRoot, absolutePath)) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path escapes the configured root')
  }
  const relativePath = relative(workspaceRoot, absolutePath).split(sep).join('/')
  if (workspaceEntryIsHidden(relativePath)) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path is not accessible')
  }
  return { absolutePath, relativePath }
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
