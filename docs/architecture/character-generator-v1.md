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
stateRoot/workshop/character-generator/marketplace/talent/<package-id>/
```

This remains physically separate from the application checkout and is already covered by the Backup Bundle's `workshop/` boundary. Installation copies a verified immutable version into the existing `stateRoot/packages` library.

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
