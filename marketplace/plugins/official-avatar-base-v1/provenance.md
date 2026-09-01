# Official Avatar Base · CC0 V1.1

This package is generated, not hand-edited. Run `pnpm avatar:build-official` to reproduce it.

## Original assets

- Quaternius, **Universal Base Characters**, CC0 1.0: https://quaternius.com/packs/universalbasecharacters.html
- Quaternius, **Universal Animation Library**, CC0 1.0: https://quaternius.com/packs/universalanimationlibrary.html
- Quaternius, **Ultimate Modular Men Pack**, CC0 1.0: https://quaternius.com/packs/ultimatemodularcharacters.html
- Quaternius, **Business Man** model listing, Public Domain / CC0: https://poly.pizza/m/JFrLIKqvCH

The Base/animation deterministic transport mirror records those source families as Quaternius CC0 assets in its pinned ATTRIBUTION.md. Only those explicitly attributed files are consumed; project-authored/commercial-tool character files are excluded.

Pinned Base transport snapshot: https://github.com/fastrouter/experiments-costa-vista/commit/23e87108a281ac827e2ea23691aa7bf4b544146e
Pinned Business Man transport: https://github.com/FloodZHubGit/break-the-silence-vr/blob/c86cee866df76efb1c09041e1e5ad89702ae0f3e/public/models/Business_Man.glb
Pinned Business Man Git blob: 3e97aa2cdfc272d88e30d325dfe90a97f90699b6

## DSH Cyber conversion

- Decodes the Base Meshopt bufferViews through the production Three GLTFLoader, then emits one conventional self-contained GLB buffer.
- Adds VRM 1.0 Humanoid metadata without replacing the source Base rig.
- Rebinds three CC0 hairstyle skins to the same Base skeleton by exact bone name.
- Declares only long-layered, side-part and tech-crop hair mappings; unsupported hairstyles remain on the 2.5D identity fallback.
- Imports only Business Man Suit_Legs, Suit_Feet and the clothing primitives of Suit_Body; Suit_Head and the source Skin primitive are deliberately excluded so an employee keeps the existing Base head, hands and hairstyle.
- Rebinds the older modular-character suit rig semantically onto the Base skeleton and regenerates inverse-bind matrices against that target rig; source game skeleton nodes are not copied.
- The same honest formal suit is exposed as professional and analyst. Engineer/future outfits are intentionally not claimed until a matching CC0 mesh is available.

License for original source assets and this generated package: CC0-1.0.
