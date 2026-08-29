# World Scene & Skin Decoupling V1

## Goal

Make the visual ownership model explicit:

- **Skin** controls application chrome, colors, conversation wallpaper and chat decoration.
- **World Scene** controls the persistent space in which digital employees live and work.
- **Character** placement and activity are projected into the active World Scene.
- Switching Skin must never replace, remount, or restyle the World Runtime scene.

## Previous coupling

The web client observed `document.documentElement.dataset.skin` and rebuilt the World Runtime manifest from the active Skin. Several built-in skins also reused one asset as both `backdropImage` and `worldMapImage`. The legacy fallback renderer also inspected `dataset.skin`, and the top-bar Skin callback incremented `worldRuntimeRevision`, remounting the live World for a cosmetic conversation change.

This made a Skin effectively own the World. Large illustration-oriented wallpapers could therefore replace a spatial office/lab scene and leave employee sprites visually floating on top of artwork. Even after manifest resolution was separated, a Skin change could still reset camera/animation state through an unnecessary World Runtime remount.

## V1 ownership model

```text
Workspace / current World
│
├─ Skin
│  ├─ UI tokens
│  ├─ conversation wallpaper
│  ├─ chat bubble styling
│  └─ decorative character artwork
│
└─ World
   └─ World Scene Binding
      ├─ renderer
      ├─ scene layers
      ├─ safe area
      ├─ work / idle / meeting anchors
      ├─ navigation
      ├─ interactables
      └─ character placement
```

The existing persistent `WorldThemeBinding` remains the storage/runtime mechanism in V1 for backward compatibility. Product UI calls this a **World Scene**. A future schema migration may rename the internal `world-theme` terminology, but this is deliberately not required for the ownership fix.

## Resolution rules

### Skin

Current per-World Skin preference continues to support existing users and determines the shell/conversation appearance for the active World.

```text
Selected Skin
→ UI theme tokens
→ conversation backdrop
→ chat decoration
```

A Skin change does not participate in World Runtime manifest resolution and does not notify App to remount the live World. The switcher applies its CSS tokens locally. Camera position, animation state, live cues, and the current scene stay mounted.

Custom Skin preview is ephemeral: previewing only changes DOM/CSS variables. It does not register or persist a temporary Skin. Clicking **Cancel** restores the persisted Skin; only **Save** writes to local storage.

### World Scene

```text
Active persistent WorldThemeBinding
→ bound installed World Scene

otherwise
→ built-in scene for World.templateId
```

The server response from `/api/worlds/:worldId/theme-manifest` is authoritative. The client no longer observes `document.dataset.skin` to rewrite that manifest. The legacy `WorldView` fallback also resolves imagery only from World experience/template and does not inspect Skin state.

## UI

The World dock exposes an independent **World Scene** control. It reads `/api/worlds/:worldId/themes` and writes `/api/worlds/:worldId/theme-binding`.

Applying a World Scene:

1. changes only the selected World;
2. persists through the existing World binding;
3. refreshes the runtime snapshot and manifest;
4. does not change the active Skin;
5. does not change conversation wallpaper.

Persistence and renderer refresh are separate failure domains. Once `/theme-binding` succeeds, the UI treats the Scene as saved even if the immediate live renderer refresh fails, and tells the user how to recover instead of falsely reporting a save failure.

The top-bar Skin switcher explicitly describes Skin as interface/conversation appearance and states that the World Scene remains independent. The custom Skin editor uses **conversation wallpaper** terminology and no longer writes new `worldMapImage` data.

## Character grounding

The World is never rendered as an empty transparent character layer. When no installed scene is bound, the World template resolves to a built-in environment with anchors/navigation. Existing runtime activity projection therefore continues to place employees in work, idle and meeting areas.

Scene packages remain responsible for providing coherent spatial assets and anchors. Illustration-only Skin wallpapers should not be used as World Scene layers unless they were explicitly authored as a spatial scene.

## Compatibility

- No database migration is required for V1.
- Existing `world-theme` packages and bindings remain valid.
- Existing Skin packages remain valid.
- Legacy `runtimeManifest` / `worldMapImage` fields in built-in web Skin definitions are retained as read-only compatibility data in V1; no World Runtime resolution path consumes them.
- Opening an older custom Skin migrates a legacy `worldMapImage` into its conversation `backdropImage` in editor state and drops the World field on the next save.
- New custom Skins never generate World Scene ownership fields.
- Existing Worlds without a binding fall back to their template scene.

A future **Legacy Skin Schema V2** cleanup may physically remove the old built-in fields after package compatibility has a dedicated migration/version boundary. That cleanup is intentionally separate from this runtime ownership change.

## Regression invariants

Required tests must preserve these rules:

1. Skin switching can change conversation wallpaper.
2. Skin switching does not change built-in World Scene resolution.
3. Server-provided World manifests are not rewritten from the active Skin.
4. A World Scene binding persists independently from Skin preference.
5. Existing Worlds always retain a usable scene fallback.
6. Skin switching does not remount the existing World Runtime DOM.
7. Legacy fallback World rendering does not read `dataset.skin` or a Skin-provided `sceneImage`.
8. Skin preview never persists until Save and never writes new `worldMapImage` data.
9. A persisted Scene save is not reported as failed merely because live renderer refresh failed.
10. Model settings/runtime error UX fixes carried into this branch remain covered by E2E.

The required Playwright smoke captures the most important runtime invariant: it switches a real conversation Skin, confirms the existing World Runtime DOM node remains connected, and asserts `/theme-manifest` is byte-for-byte equivalent before and after the Skin change.

## Follow-up

V2 can add curated Skin → Scene recommendations, e.g. a White Whale Skin recommending a dedicated Whale Ocean Office. Recommendations must require explicit user confirmation and must never become an implicit inheritance rule.
