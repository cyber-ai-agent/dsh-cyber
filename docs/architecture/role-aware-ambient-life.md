# Role-aware ambient life

## Purpose

Ambient life makes a world feel inhabited while preserving the truth of the underlying agents. It is a low-priority visual and spatial routine system, not a substitute for real model work.

## Hard invariants

1. A character with an active user session, peer conversation, real task or non-interruptible plan never receives an ambient plan.
2. Ambient behavior is deterministic for the same world state and time bucket. Production code must not call `Math.random()`.
3. The model never chooses coordinates, paths, seats or animation frames.
4. Every movement has a source, reason, target slot, priority and interruptibility flag.
5. Characters prefer role-compatible zones and return to their stable home slot after temporary activity.
6. A slot is selected only when it is available to that character. A world tick reserves a selected slot before evaluating the next character.
7. Social behavior requires a useful colleague, an available conversation slot, a cooldown and a bounded collaboration policy.
8. Ambient plans are persisted through the same `CharacterActionPlan` contract as other world behavior.
9. Ambient activity must be visibly distinguishable from real tasks and agent conversations.
10. World-level settings can disable ambient life completely.

## Priority order

| Priority | Source |
|---:|---|
| 100 | safety, lock and permission changes |
| 90 | direct user interaction |
| 80 | real task execution |
| 70 | accepted meeting or peer collaboration |
| 50 | scheduled role duty |
| 30 | bounded useful social behavior |
| 10–24 | ambient role routine, break and return home |

A higher-priority plan may cancel or suspend an interruptible lower-priority plan. Ambient plans are always interruptible.

## Decision pipeline

```text
world tick
  -> load active characters and presences
  -> exclude real work and active sessions
  -> enforce idle and cooldown windows
  -> return displaced characters to home first
  -> evaluate bounded social opportunity
  -> evaluate role-compatible routine
  -> reserve destination in stable character order
  -> compile durable action plan
  -> persist plan and lease
  -> publish world state
```

## Role semantics

Role behavior is selected from semantic tags, not display-name equality or hard-coded coordinates.

Examples:

- `engineering`, `coding`, `testing` -> engineering workstations and boards
- `administration`, `coordination`, `schedule` -> administrative desks, files and meeting preparation
- `research`, `knowledge`, `archive` -> library, research and archive facilities
- `operations`, `monitoring`, `control` -> operations and monitoring facilities
- `rest`, `lounge`, `public` -> bounded breaks only

A theme maps these semantic tags to its own zones and facilities. A magic-school theme may map `research` to a library and `engineering` to an alchemy workshop without changing the character policy.

## Social behavior

Ambient social behavior is not open-ended autonomous chat. It only produces a collaboration intent when:

- both characters are idle and available;
- both belong to the same world;
- neither owns an active task/session/plan;
- their roles overlap or complement one another;
- the pair is outside its cooldown;
- a conversation slot is available;
- the world and daily budgets allow it.

The existing bounded NPC collaboration runtime remains responsible for model turns, permissions, transcripts and shared episodes.

## Renderer boundary

Pixi consumes snapshots and cues. It may interpolate paths and play animation, but it must not select a routine, colleague, zone or slot. Renderer-only idle motion such as blinking can exist without a plan; movement and social activity cannot.

## Recovery

The server persists action plans and slot leases. After restart:

- expired leases are removed;
- active real work wins over ambient work;
- incomplete ambient plans may be cancelled safely;
- characters without a valid destination return to a compatible home slot;
- no new random destination is generated during recovery.
