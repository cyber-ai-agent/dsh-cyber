import { realpath } from 'node:fs/promises'
import { join, parse, resolve, sep } from 'node:path'

import { isPathWithin } from './world-root-service.js'

/**
 * A path segment resolved through a symbolic link the caller never named.
 *
 * Thrown by {@link resolveCanonicalPathWithoutSymlinkHops} so every call site
 * keeps its own public error code instead of leaking a shared one.
 */
export class SymlinkHopError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`Path segment resolves through a symbolic link: ${path}`)
    this.name = 'SymlinkHopError'
    this.path = path
  }
}

/**
 * Canonicalise an absolute path one segment at a time.
 *
 * Comparing a lexical `resolve(candidate)` with a canonical `realpath()`
 * refuses every legitimate path whose root is reached through a symlink — on
 * macOS `/var -> private/var` guarantees it, and on Linux any symlinked
 * ancestor does the same. Resolving both sides is not the fix either: it makes
 * the comparison a tautology, so `base/inner/hop/payload` with
 * `hop -> base/../outside` passes the `lstat()` check on its final segment and
 * would be accepted, reading a tree the caller never named.
 *
 * Walking keeps both properties. Each step must canonicalise to exactly the
 * canonical prefix plus that literal segment, with two deliberate relaxations:
 *
 * - the first segment below the filesystem root may be a platform alias, as
 *   long as it still lands inside the same filesystem root — `/var` and `/tmp`
 *   are links only root can create, and `os.tmpdir()` walks through one on
 *   every macOS host;
 * - while the resolved prefix is still an ancestor of `boundary`, the
 *   divergence sits above the caller's namespace — the operator's own state
 *   root is allowed to live behind a symlink — and is carried forward. Callers
 *   that name a directory outside any managed tree pass no `boundary`, so this
 *   relaxation never applies to them.
 *
 * Below `boundary` no hop is accepted, so an intermediate symlink is refused
 * rather than silently followed. The returned path is canonical; containment
 * against the boundary is still the caller's check. A missing segment surfaces
 * the underlying `ENOENT` unchanged.
 */
export async function resolveCanonicalPathWithoutSymlinkHops(candidate: string, boundary?: string): Promise<string> {
  const lexical = resolve(candidate)
  const filesystemRoot = parse(lexical).root
  const canonicalBoundary = boundary === undefined ? undefined : await realpath(boundary)
  let lexicalPrefix = filesystemRoot
  let canonicalPrefix = await realpath(filesystemRoot)
  const canonicalFilesystemRoot = canonicalPrefix
  const segments = lexical.slice(filesystemRoot.length).split(sep).filter((segment) => segment !== '')
  for (const [index, segment] of segments.entries()) {
    lexicalPrefix = join(lexicalPrefix, segment)
    const expected = join(canonicalPrefix, segment)
    const actual = await realpath(lexicalPrefix)
    // Case-insensitive so a case-preserving filesystem reporting the on-disk
    // spelling is not mistaken for a hop; the canonical spelling is carried on.
    if (actual.toLowerCase() === expected.toLowerCase()) {
      canonicalPrefix = actual
      continue
    }
    const platformRootAlias = index === 0 && isPathWithin(canonicalFilesystemRoot, actual)
    const stillAboveBoundary = canonicalBoundary !== undefined && isPathWithin(actual, canonicalBoundary)
    if (platformRootAlias || stillAboveBoundary) {
      canonicalPrefix = actual
      continue
    }
    throw new SymlinkHopError(lexicalPrefix)
  }
  return canonicalPrefix
}
