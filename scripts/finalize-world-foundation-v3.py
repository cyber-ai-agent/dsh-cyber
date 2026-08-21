from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding='utf-8')


# Public product wording: “角色” is the UI term; Employee* remains only an internal v1 compatibility name.
# Include .ts configuration modules such as world-experience.ts, not just rendered TSX components.
for pattern in ('*.tsx', '*.ts'):
    for path in Path('packages/web/src').rglob(pattern):
        text = path.read_text(encoding='utf-8').replace('员工', '角色')
        path.write_text(text, encoding='utf-8')

# The file dock must use the active world's isolated filesystem, never the old global workspace root.
p = 'packages/web/src/components/ArtifactDock.tsx'
s = read(p)
s = s.replace(
    '`/api/workspace/files?path=${encodeURIComponent(path)}`',
    '`/api/worlds/${encodeURIComponent(world.id)}/files?path=${encodeURIComponent(path)}`',
)
s = s.replace(
    '`/api/workspace/file?path=${encodeURIComponent(entry.path)}`',
    '`/api/worlds/${encodeURIComponent(world.id)}/file?path=${encodeURIComponent(entry.path)}`',
)
s = s.replace('工作区目录读取失败', '世界目录读取失败')
s = s.replace("value.path || '工作区根目录'", "value.path || '世界根目录'")
s = s.replace('本地工作区只读预览', '当前世界只读预览')
write(p, s)

# Browser tests follow the deliberate UI terminology change and verify a real file inside the world root.
p = 'e2e/workbench.spec.ts'
s = read(p)
s = s.replace(
    "import { mkdir, mkdtemp, rm } from 'node:fs/promises'",
    "import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'",
)
s = s.replace('员工', '角色')
old = """  await dock.getByRole('button', { name: '文件', exact: true }).click()
  await dock.getByRole('button', { name: /packages.*目录/ }).click()
  await dock.getByRole('button', { name: /web.*目录/ }).click()
  await dock.getByRole('button', { name: /package\\.json.*可预览/ }).click()
  await expect(dock.getByText('本地工作区只读预览')).toBeVisible()
  await expect(dock.getByRole('button', { name: '新标签打开' })).toBeVisible()
"""
new = """  const localWorkspace = server.store.listWorkspaces()[0]!
  const localWorld = server.store.listWorlds(localWorkspace.id)[0]!
  const worldFilesRoot = join(stateRoot, 'worlds', encodeURIComponent(localWorld.id), 'files')
  await mkdir(join(worldFilesRoot, 'docs'), { recursive: true })
  await writeFile(join(worldFilesRoot, 'docs', 'hello.md'), '# 当前世界文件\\n', 'utf8')
  await dock.getByRole('button', { name: '文件', exact: true }).click()
  await dock.getByRole('button', { name: /docs.*目录/ }).click()
  await dock.getByRole('button', { name: /hello\\.md.*可预览/ }).click()
  await expect(dock.getByText('当前世界只读预览')).toBeVisible()
  await expect(dock.getByRole('button', { name: '新标签打开' })).toBeVisible()
"""
if old not in s:
    raise SystemExit('missing E2E workspace file browser block')
s = s.replace(old, new)
s = s.replace("dock.getByText('工作区根目录')", "dock.getByText('世界根目录')")
write(p, s)

# Trigger marker; the successful bootstrap removes this script.
