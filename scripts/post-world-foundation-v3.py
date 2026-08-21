from pathlib import Path
import re
from textwrap import dedent


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace(path: str, old: str, new: str, *, required: bool = False) -> None:
    source = read(path)
    if old not in source:
        if required:
            raise SystemExit(f"missing required patch anchor in {path}: {old[:100]!r}")
        return
    write(path, source.replace(old, new))


# App: expose reasoning at the main composer and send it with every turn.
p = "packages/web/src/App.tsx"
s = read(p)
if "reasoningEffort={reasoningEffort}" not in s:
    s = s.replace(
        "            draft={draft}\n            onDraftChange={setDraft}\n",
        "            draft={draft}\n            reasoningEffort={reasoningEffort}\n            onReasoningEffortChange={setReasoningEffort}\n            onDraftChange={setDraft}\n",
    )
if "          reasoningEffort,\n          ...(attachments.length" not in s:
    s = s.replace(
        "          prompt,\n          ...(attachments.length === 0 ? {} : { attachments }),",
        "          prompt,\n          reasoningEffort,\n          ...(attachments.length === 0 ? {} : { attachments }),",
    )
s = s.replace(
    "sessionParticipants])\n\n  const uploadChatAttachment",
    "sessionParticipants, reasoningEffort])\n\n  const uploadChatAttachment",
)
s = s.replace("version: '0.1.0-rc.7'", "version: '0.1.0-rc.8'")
s = s.replace("expectedVersion: '0.1.0-rc.7'", "expectedVersion: '0.1.0-rc.8'")
write(p, s)

# Access guard on runtime SSE uses async password validation.
replace(
    "packages/server/src/routes/conversation-routes.ts",
    "router.get(/^\\/api\\/worlds\\/([^/]+)\\/live$/, ({ request, response, params }) => {",
    "router.get(/^\\/api\\/worlds\\/([^/]+)\\/live$/, async ({ request, response, params }) => {",
)

# Normal CLI bootstraps one friendly world, server tests/integrators remain deterministic and empty.
p = "packages/server/src/server.ts"
s = read(p)
s = s.replace(
    "  marketplaceRoot?: string\n}",
    "  marketplaceRoot?: string\n  bootstrapDefaultWorld?: boolean\n}",
)
s = s.replace(
    "  if (store.listWorkspaces().length === 0) {",
    "  if (options.bootstrapDefaultWorld === true && store.listWorkspaces().length === 0) {",
)
s = s.replace(
    "profile.settings.reasoningEfforts as HarnessModelRoute['reasoningEfforts']",
    "profile.settings.reasoningEfforts as Exclude<HarnessModelRoute['reasoningEfforts'], undefined>",
)
write(p, s)

p = "packages/cli/src/index.ts"
s = read(p)
s = s.replace(
    "const server = await createCyberServer({ stateRoot, workspacePath, port })",
    "const server = await createCyberServer({ stateRoot, workspacePath, port, bootstrapDefaultWorld: true })",
)
s = s.replace("'0.1.0-rc.7'", "'0.1.0-rc.8'")
write(p, s)

replace(
    "packages/server/src/routes/world-settings-routes.ts",
    "import type { ModelProfile, WorldSettings }",
    "import type { WorldSettings }",
)

# exactOptionalPropertyTypes: remove the optional model id rather than assigning undefined.
p = "packages/web/src/components/WorldSettingsDialog.tsx"
s = read(p)
s = s.replace(
    "model:{...draft.model,defaultModelProfileId:e.target.value || undefined}",
    "model:e.target.value ? {...draft.model,defaultModelProfileId:e.target.value} : {reasoningEffort:draft.model.reasoningEffort}",
)
write(p, s)

replace(
    "packages/web/src/components/WorldView.tsx",
    "kind: 'company' | 'tavern' | 'studio'",
    "kind: 'personal' | 'company' | 'tavern' | 'studio'",
)

# Legacy/embedded ChatWorkbench call sites may omit the selector; the main App still supplies it.
p = "packages/web/src/components/ChatWorkbench.tsx"
s = read(p)
s = s.replace(
    "  reasoningEffort: ReasoningEffort\n  onReasoningEffortChange(value: ReasoningEffort): void\n",
    "  reasoningEffort?: ReasoningEffort\n  onReasoningEffortChange?(value: ReasoningEffort): void\n",
)
s = s.replace(
    "  reasoningEffort,\n  onReasoningEffortChange,\n",
    "  reasoningEffort = 'auto',\n  onReasoningEffortChange = () => undefined,\n",
)
write(p, s)

# rc.8 is the new bundled default. rc.7 remains a supported candidate/rollback family.
p = "packages/harness-adapter/src/compatibility.ts"
s = read(p)
if "dshVersion: '0.1.0-rc.7'" not in s:
    legacy = dedent(
        """\
          {
            dshVersion: '0.1.0-rc.7',
            contractId: HARNESS_PROTOCOL_CONTRACT,
            packages: {
              '@deepseek-ai/dsh': '0.1.0-rc.7',
              '@deepseek-ai/dsh-sdk-client': '0.1.0-rc.7',
              '@deepseek-ai/dsh-sdk-jsonrpc-server': '0.1.0-rc.7',
            },
            requiredEvents: [
              'turn/start',
              'assistant/chunk',
              'assistant/message',
              'tool/call',
              'tool/result',
              'turn/end',
            ],
          },
        """
    )
    s = s.replace("] as const", legacy + "] as const", 1)
write(p, s)

replace(
    "packages/harness-adapter/tests/local-harness.integration.test.ts",
    "version: '0.1.0-rc.7'",
    "version: '0.1.0-rc.8'",
)

# Server contract tests move file browsing to world roots and include the new generic template.
p = "packages/server/tests/server.test.ts"
s = read(p)
s = s.replace(
    "    expect(templates.body.items.map((item: { id: string }) => item.id)).toEqual([\n      'cyber-company',",
    "    expect(templates.body.items.map((item: { id: string }) => item.id)).toEqual([\n      'personal-world',\n      'cyber-company',",
)
pattern = re.compile(
    r"  it\('browses and previews safe workspace files without exposing hidden files or traversal', async \(\) => \{.*?\n  \}\)\n\n  it\('searches verified market packages",
    re.S,
)
match = pattern.search(s)
if match is None:
    raise SystemExit("expected to find the old workspace file test")
new_test = dedent(
    r'''\
      it('browses and previews safe world files without exposing hidden files or traversal', async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-files-'))
        const { origin } = await start(stateRoot)
        const { world } = await createWorld(origin)
        const filesRoot = join(stateRoot, 'worlds', encodeURIComponent(world.id), 'files')
        await mkdir(join(filesRoot, 'src'), { recursive: true })
        await writeFile(join(filesRoot, 'src', 'hello.ts'), 'export const hello = "cyber"\n', 'utf8')
        await writeFile(join(filesRoot, '.env'), 'SECRET_MUST_NOT_LEAK=value\n', 'utf8')

        const root = await json(origin, `/api/worlds/${world.id}/files`)
        expect(root.response.status).toBe(200)
        expect(root.body.items.map((item: { name: string }) => item.name)).toContain('src')
        expect(root.body.items.map((item: { name: string }) => item.name)).not.toContain('.env')

        const nested = await json(origin, `/api/worlds/${world.id}/files?path=src`)
        expect(nested.body).toMatchObject({ path: 'src', parentPath: '' })
        expect(nested.body.items).toEqual([
          expect.objectContaining({ name: 'hello.ts', kind: 'file', previewKind: 'text' }),
        ])
        const preview = await fetch(`${origin}/api/worlds/${world.id}/file?path=src%2Fhello.ts`)
        expect(preview.status).toBe(200)
        expect(preview.headers.get('content-type')).toContain('text/plain')
        expect(await preview.text()).toContain('export const hello')

        const hidden = await fetch(`${origin}/api/worlds/${world.id}/file?path=.env`)
        expect(hidden.status).toBe(403)
        const traversal = await fetch(`${origin}/api/worlds/${world.id}/files?path=..%2F`)
        expect(traversal.status).toBe(403)
      })

      it('searches verified market packages'''
)
s = s[: match.start()] + new_test + s[match.end() :]
write(p, s)

# This file is intentionally deleted by the successful bootstrap commit.
