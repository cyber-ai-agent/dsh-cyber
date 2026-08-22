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
7. Ambient life never fabricates a conversation. Role-to-role dialogue continues through the real bounded collaboration runtime, with its own model turns, permissions, transcript and shared episode.
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
| 10–24 | ambient role routine, break and return home |

A higher-priority plan may cancel or suspend an interruptible lower-priority plan. Ambient plans are always interruptible.

## Decision pipeline

```text
world tick
  -> load active characters and presences
  -> exclude real work and active sessions
  -> enforce idle and cooldown windows
  -> return displaced characters to home first
  -> evaluate role-compatible routine or bounded break
  -> reserve destination in stable character order
  -> compile durable action plan
  -> persist plan and lease
  -> emit semantic ambient-start/ambient-complete events
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

## Conversation boundary

A character may visually inspect a role-compatible area, return to its post or take a bounded break. It may not display a fake conversation bubble or claim that another Agent participated.

Real role conversation is initiated through one of the existing collaboration paths:

- the user explicitly selects “让他去沟通”;
- the user delegates a consultation in direct chat and explicitly mentions a target role;
- a future autonomous collaboration policy creates a bounded, auditable intent.

Only the bounded NPC collaboration runtime may execute model turns and write a transcript, relationship evidence or `SharedWorldEpisode`. Autonomous role consultation remains disabled until that policy is implemented end to end.

## Renderer boundary

Pixi consumes snapshots and cues. It may interpolate paths and play animation, but it must not select a routine, colleague, zone or slot. Renderer-only idle motion such as blinking can exist without a plan; movement and social activity cannot.

## Recovery

The server persists action plans and slot leases. After restart:

- expired leases are removed;
- active real work wins over ambient work;
- incomplete ambient plans may be cancelled safely;
- characters without a valid destination return to a compatible home slot;
- no new random destination is generated during recovery.

## Rollout and verification

Ambient life is disabled by default for every world. A user must enable it explicitly from the world view. Each world keeps an independent policy, and disabling the policy immediately stops new ambient plans while existing short-lived plans remain interruptible and expire safely.

The merge gate covers deterministic policy selection, slot contention, persisted plans and leases, semantic start/completion events, scheduler recovery, world-level settings, and a Chromium flow that saves and reloads the policy. A release must not include temporary branch workflows or renderer-side behavior decisions.
