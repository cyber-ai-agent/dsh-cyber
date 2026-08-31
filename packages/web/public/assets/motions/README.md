# DSH Cyber Basic Motion Pack

This is a small self-authored starter pack distributed with DSH Cyber under
the MIT license. It provides the six baseline clips required by the world
runtime: `idle`, `walk`, `talk`, `listen`, `thinking`, and `typing`.

The clips are intentionally minimal root rotations. `AnimationMixer` and
cross-fades own the clip playback; breathing, look-at, blinking, and lip sync
remain additive runtime layers. A world or avatar package may provide richer
VRMA clips through the same motion-pack contract.
