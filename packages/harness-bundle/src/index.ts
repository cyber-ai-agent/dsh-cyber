// Re-export the official SDK server as the runtime plugin owned by this
// profile bundle. Loading this package from the profile keeps every SDK peer
// resolved from the bundle's real installation, without copying DSH internals.
export {
  Config,
  apply,
  inject,
  name,
  type JsonRpcConfig,
} from '@deepseek-ai/dsh-sdk-jsonrpc-server'
