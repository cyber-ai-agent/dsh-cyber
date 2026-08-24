# DSH Cyber Roadmap

> The roadmap is directional, not a release promise. Priorities may change as architecture stabilizes.

## Current phase — Pre-Alpha / Creative Platform V1

### In progress

- [x] Local-first workspace/world persistence
- [x] Independent Agent sessions through Harness adapter
- [x] Real multi-character conversations
- [x] Bounded character-to-character collaboration
- [x] Deterministic ambient life and world simulation
- [x] Explicit semantic embodiment for custom roles
- [x] Conversation-only left navigation
- [x] World + Trace + Dossier right dock
- [x] Provider-neutral World Trace read model and durable recovery
- [x] Chat limited to final conversational results
- [x] Unified Market entry
- [x] Local Creative Workshop project library
- [x] Workshop-generated character packages through PackageManager
- [x] Requested Skill vs granted Skill separation
- [x] Trusted Skill Adapter registry foundation
- [x] Home Assistant adapter V1
- [x] Complete local `.dshbackup` boundary
- [x] Controlled Harness update / rollback
- [x] SQLite-backed conversation continuity across runtime restart
- [x] Approval Gate V1 for trusted external Skill actions
- [x] Trace Intelligence V1 with per-run reasoning summaries, tool orchestration, Token attribution and role/date/search filters
- [x] World Package Instance V1
- [x] Built-in Skill Recipe catalog with role-aware default grants and on-demand loading
- [x] Integration Registry and Firecrawl V1
- [ ] MCP Skill Adapter V1
- [ ] Extension Host and JSON-RPC Gateway
- [ ] Finish Creative Workshop project lifecycle
- [ ] Add Creative Workshop smoke E2E
- [ ] Define Creative Platform V1 local-data compatibility baseline
- [ ] Remove remaining new-path role-name inference
- [ ] Final visual QA for conversation / dossier / workshop information architecture

## Alpha — Work System

- [ ] Task / Job / Run / Assignment domain model
- [ ] Deliverable / Review / Approval domain model
- [ ] Character current-work and history UI
- [ ] Artifact ownership and evidence links
- [ ] Bounded autonomous delegation policy
- [ ] Smoke E2E becomes Required CI

## Alpha — Memory & Growth V2

> Conversation continuity (one session, recovered from SQLite) already ships in
> Pre-Alpha. Everything below is still unimplemented and must not be described
> as part of it.

- [ ] Episodic memory
- [ ] Semantic memory
- [ ] Procedural memory
- [ ] Relationship memory
- [ ] Memory retrieval scopes
- [ ] Memory consolidation and retention
- [ ] Evidence-based skill proficiency
- [ ] Growth timeline and milestone UI

## Alpha/Beta — Real-world Skill ecosystem

- [ ] Generic Host Skill Registry with scope resolution
- [ ] GitHub Adapter
- [ ] Browser Adapter
- [ ] Feishu Adapter
- [ ] QQ Adapter
- [ ] WeChat integration strategy
- [ ] MQTT / Home automation adapters
- [ ] Action approval policy UI
- [ ] Skill audit timeline
- [ ] Credential scopes and rotation

## Beta — MOD ecosystem

- [ ] Remote extension index
- [ ] Cryptographic package signatures
- [ ] Dependency resolution
- [ ] Compatibility constraints
- [ ] Update / uninstall / rollback
- [ ] Package authoring CLI
- [ ] Custom body / animation rig packages
- [ ] Rich world scene packages
- [ ] Future 3D asset pipeline

## Beta — Platform compatibility

- [ ] Versioned persistence migrations
- [ ] Backup / restore release gate
- [ ] Windows validation matrix
- [ ] macOS validation matrix
- [ ] Harness compatibility matrix
- [ ] Full E2E becomes Required

## Future — Optional cloud layer

- [ ] Account-based encrypted sync
- [ ] Multi-device project replication
- [ ] Conflict resolution
- [ ] Remote marketplace metadata
- [ ] Local remains authoritative
- [ ] Offline-first operation preserved

## Product principles that should not change

1. A character is a persistent entity, not a prompt preset.
2. User-defined identity/persona/embodiment overrides template assumptions.
3. World, Character, Skill and Harness remain decoupled.
4. External side effects require structured trusted adapters and factual execution results.
5. Local user data is not disposable application cache.
6. MOD extensibility should increase reuse, not introduce hard-coded branches.
7. Growth is evidence-driven.
8. Visual world state must reflect real domain state instead of fabricating work.
9. Chat surfaces final conversational results; execution details belong to Trace.
