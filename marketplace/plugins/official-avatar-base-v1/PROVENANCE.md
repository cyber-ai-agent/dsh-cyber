# Official Avatar Base · CC0 V1

This package is generated, not hand-edited. Run `pnpm avatar:build-official` to reproduce it.

## Original assets

- Quaternius, **Universal Base Characters**, CC0 1.0: https://quaternius.com/packs/universalbasecharacters.html
- Quaternius, **Universal Animation Library**, CC0 1.0: https://quaternius.com/packs/universalanimationlibrary.html

The deterministic transport mirror records those source families as Quaternius CC0 assets in its pinned ATTRIBUTION.md. Only those explicitly attributed files are consumed; project-authored/commercial-tool character files are excluded.

Pinned transport snapshot: https://github.com/fastrouter/experiments-costa-vista/commit/23e87108a281ac827e2ea23691aa7bf4b544146e

## DSH Cyber conversion

- Decodes the source Meshopt bufferViews through the production Three GLTFLoader, then emits one conventional self-contained GLB buffer.
- Adds VRM 1.0 Humanoid metadata without replacing the source rig.
- Rebinds three CC0 hairstyle skins to the same Base skeleton by exact bone name.
- Declares only long-layered, side-part and tech-crop hair mappings; unsupported hairstyles remain on the 2.5D identity fallback.
- Declares the source body only as casual. It is intentionally not labelled professional/analyst/engineer.

License for original source assets and this generated package: CC0-1.0.
