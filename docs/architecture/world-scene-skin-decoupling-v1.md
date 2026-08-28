# World Scene & Skin Decoupling V1

## Goal

Make the visual ownership model explicit:

- **Skin** controls application chrome, colors, conversation wallpaper and chat decoration.
- **World Scene** controls the persistent space in which digital employees live and work.
- **Character** placement and activity are projected into the active World Scene.
- Switching Skin must never replace the World Runtime scene.

## Previous coupling

The web client observed `document.documentElement.dataset.skin` and rebuilt the World Runtime manifest from the active Skin. Several built-in skins also reused one asset as both `backdropImage` and `worldMapImage`.

This made a Skin effectively own the World. Large illustration-oriented wallpapers could therefore replace a spatial office/lab scene and leave employee sprites visually floating on top of artwork.

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

A Skin change does not participate in World Runtime manifest resolution.

### World Scene

```text
Active persistent WorldThemeBinding
→ bound installed World Scene

otherwise
→ built-in scene for World.templateId
```

The server response from `/api/worlds/:worldId/theme-manifest` is authoritative. The client no longer observes `document.dataset.skin` to rewrite that manifest.

## UI

The World dock exposes an independent **World Scene** control. It reads `/api/worlds/:worldId/themes` and writes `/api/worlds/:worldId/theme-binding`.

Applying a World Scene:

1. changes only the selected World;
2. persists through the existing World binding;
3. refreshes the runtime snapshot and manifest;
4. does not change the active Skin;
5. does not change conversation wallpaper.

The top-bar Skin switcher explicitly describes Skin as interface/conversation appearance and states that the World Scene remains independent.

## Character grounding

The World is never rendered as an empty transparent character layer. When no installed scene is bound, the World template resolves to a built-in environment with anchors/navigation. Existing runtime activity projection therefore continues to place employees in work, idle and meeting areas.

Scene packages remain responsible for providing coherent spatial assets and anchors. Illustration-only Skin wallpapers should not be used as World Scene layers unless they were explicitly authored as a spatial scene.

## Compatibility

- No database migration is required for V1.
- Existing `world-theme` packages and bindings remain valid.
- Existing Skin packages remain valid.
- Legacy `worldMapImage` fields in web Skin definitions remain compatibility metadata, but the World Runtime client no longer consumes the selected Skin to choose its manifest.
- Existing Worlds without a binding fall back to their template scene.

## Regression invariants

Required tests must preserve these rules:

1. Skin switching can change conversation wallpaper.
2. Skin switching does not change built-in World Scene resolution.
3. Server-provided World manifests are not rewritten from the active Skin.
4. A World Scene binding persists independently from Skin preference.
5. Existing Worlds always retain a usable scene fallback.
6. Model settings/runtime error UX fixes carried into this branch remain covered by E2E.

## Follow-up

V2 can add curated Skin → Scene recommendations, e.g. a White Whale Skin recommending a dedicated Whale Ocean Office. Recommendations must require explicit user confirmation and must never become an implicit inheritance rule.
