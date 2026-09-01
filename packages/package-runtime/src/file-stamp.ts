import type { Stats } from 'node:fs'

/**
 * Identity of one already content-verified file on disk.
 *
 * Package integrity is established by reading a file and comparing its SHA-256
 * against the declared manifest hash. That read is expensive (the shared Base
 * VRM is 6+ MiB), so a verified result may be reused only while the file is
 * provably the *same* inode with the same contents. A stamp records everything
 * a filesystem changes when a file is rewritten, replaced, truncated or
 * swapped for a symlink: device + inode, size, mtime and ctime.
 *
 * ctime matters: a writer that deliberately restores mtime after tampering
 * still bumps ctime, which userland cannot set. Any mismatch forces a full
 * re-read and re-hash, so the SHA-256 check is deferred, never dropped.
 */
export interface FileStamp {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  kind: 'file' | 'directory'
}

export function fileStamp(stats: Stats, kind: 'file' | 'directory' = 'file'): FileStamp {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    kind,
  }
}

export function sameFileStamp(stats: Stats, stamp: FileStamp): boolean {
  if (stats.isSymbolicLink()) return false
  if (stamp.kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) return false
  return stats.dev === stamp.dev
    && stats.ino === stamp.ino
    && stats.size === stamp.size
    && stats.mtimeMs === stamp.mtimeMs
    && stats.ctimeMs === stamp.ctimeMs
}
