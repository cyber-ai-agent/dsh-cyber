# DSH Cyber Humanoid Motion Pack

This is a small self-authored starter pack distributed with DSH Cyber under
the MIT license. Version 2 provides nine authored Humanoid clips: `idle`,
`walk`, `talk`, `listen`, `thinking`, `typing`, `present`, `hold`, and
`failed`.

Unlike the original starter file, V2 does not animate one root node. Its glTF
contains semantic `dsh-bone-<VRM bone>` tracks for torso, head, arms, hands and
legs. The runtime retargets those tracks to each avatar's normalized VRM
Humanoid bones before registering them with `AnimationMixer`, so different VRM
rigs can share one tiny offline motion asset.

Look-at, blinking, facial expression, lip sync and spring bones remain additive
runtime layers. A world or avatar package may provide richer VRMA clips through
the same motion-library contract; real VRMA takes priority over this plain glTF
retargeting path.
