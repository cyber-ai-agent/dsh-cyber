// React 19 uses this global to determine whether the current test runtime is
// intentionally configured for `act(...)`. Web tests run in happy-dom and
// exercise real effects/subscriptions, so declare that contract once for the
// web Vitest project instead of emitting an environment warning per update.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
