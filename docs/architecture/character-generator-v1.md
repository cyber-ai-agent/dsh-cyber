# Character Generator V1

## Product contract

Character Generator is the role-creation path inside `扩展市场 → 角色`. It turns a natural-language description or an imported `.md`/`.txt` source into a reviewable character draft, then publishes a standard local Talent Package. It is not a new Agent model, a new top-level destination, or a shortcut around installation and recruitment approval.

The complete flow is:

```text
untrusted source
  → CharacterImportAnalyzer
  → editable CharacterBlueprintDraft
  → EmployeeBlueprint + CyberPackageManifest
  → local Talent marketplace
  → PackageManager preview/install
  → World Package Instance
  → RecruitmentDialog grants and permission review
  → EmployeeInstance + canonical direct conversation
```

## Authority boundaries

- `CharacterBlueprintDraft` exists only during generation and review. The published role is the existing `EmployeeBlueprint` contract.
- The analyzer may request only Skill and Capability IDs present in host catalogs. Requested IDs are not grants.
- Package ID, version, timestamps, paths, hashes and install approval tokens are host-generated.
- PackageManager remains the only staging, integrity, activation and rollback boundary.
- Recruitment remains the only path that creates an `EmployeeInstance`, `EmployeeRevision`, `EmployeeProfile`, Dossier, canonical conversation and runtime lane.
- Imported text is untrusted data. It never becomes a system instruction and cannot create grants, credentials, provider routes, database IDs or execution authority.

## Source retention

The published package keeps the original input and the structured analysis snapshot as declared source files. Runtime Persona uses only the reviewed, bounded draft fields; it never embeds the whole imported document.

Generated marketplace source lives below:

```text
stateRoot/workshop/character-generator/workspaces/<workspace-segment>/marketplace/talent/<package-id>/
```

This remains physically separate from the application checkout and is already covered by the Backup Bundle's `workshop/` boundary. Installation copies a verified immutable version into the existing `stateRoot/packages` library.

## Workspace isolation

A generated character belongs to the workspace that created it, and the path above is the ownership record.

`<workspace-segment>` is derived from the workspace ID as a readable slug plus a SHA-256 suffix. The suffix — not the slug — carries the identity, so two workspace IDs never share a directory even on a case-insensitive filesystem, and no ID can produce a separator or a `..` segment.

Isolation is enforced by the server's catalog authority, not by the UI:

- `LocalPackageCatalog` resolves the owning root per query. A `list`, `find` or `readDeclaredFile` call that names no workspace sees no generated package at all, so a caller that forgets to pass a workspace fails closed rather than seeing everyone's.
- `/api/marketplace`, the marketplace preview and both install routes pass the caller's workspace, so another workspace's generated talent is a 404 rather than a hidden card.
- `/api/workspaces/:id/packages/install` takes a caller-supplied `sourceDirectory`, so it additionally calls `assertInstallSource`, which refuses a directory that lies inside the workspace container but outside the caller's own root. Naming the real path of another workspace's character is refused.

Because ownership lives in the path, it survives a backup/restore round trip and a manual copy of the state root.

### Migrating V1 data

Character Generator V1 wrote every generated package to a single global `character-generator/marketplace/talent/`, with no workspace segment — the leak this layout closes. On startup, anything still there is moved into the oldest workspace and the legacy directory is retired.

V1 recorded no workspace on those packages, so their true origin is unknowable. Adopting them into one workspace keeps the user's work — nothing is deleted, and a package whose ID already exists in the target is left alone — while restoring the boundary. Leaving them globally readable would have preserved the defect. A user with several workspaces may therefore find a pre-upgrade generated character under their oldest workspace rather than the one that created it; it can be reinstalled from there.

## UI contract

The generator replaces the market catalog body while open and keeps the market dialog as the one modal/focus boundary. Its four states are:

1. Choose description, pasted text or `.md`/`.txt` import.
2. Analyze with visible progress and retry/cancel behavior.
3. Review and edit identity, Persona, traits, background, requested Skills/Capabilities, compatible World and a 2D avatar.
4. Explicitly publish, then return to the role market to install and recruit.

Publishing never auto-installs, auto-recruits or auto-sends a chat message.

## Failure model

- Analysis failure preserves the source and allows retry.
- Publish validates the source, draft, catalogs, WorldTemplate and avatar again on the server.
- Package materialization uses a sibling staging directory and atomic rename; failure removes only that incomplete staging directory.
- A malformed local package is omitted from marketplace discovery and cannot block other packages.
- Install and recruitment failures reuse their existing transaction and compensation behavior; no partial Employee is created by the generator.

## Verification

- Unit: frontmatter, Markdown, prompt injection, catalog filtering, persona bounds, avatar validation and package compilation.
- Integration: draft → publish → marketplace discovery → preview/install → World instance → recruit → direct chat.
- Browser: import the real `agency-agents-zh` AI engineer Markdown through visible controls, edit the draft, publish, install, recruit and chat.
- Visual: 1440×900, 1920×1080 and 3840×2160; check overflow, readable text, language consistency, focus order and console error/warn output.
