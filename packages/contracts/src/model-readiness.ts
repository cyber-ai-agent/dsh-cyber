/** Configuration facts only. Discovery and saved credentials are not a successful chat probe. */
export type ConversationModelReadinessState = 'none' | 'missing-credential' | 'configured-unverified'
export type ConversationModelSource = 'temporary' | 'employee' | 'world' | 'workspace' | 'default' | 'first-profile' | 'harness-default' | 'external-runtime'
export type ConversationCredentialSource = 'none' | 'not-required' | 'profile' | 'provider' | 'environment' | 'harness-default' | 'external-runtime'

export interface ConversationModelReadinessItem {
  employeeId: string
  state: ConversationModelReadinessState
  source: ConversationModelSource
  modelProfileId?: string
  modelId?: string
  displayName?: string
  credentialSource: ConversationCredentialSource
  blockingReason?: 'no-model' | 'missing-credential'
  guidance?: string
}

export interface ConversationModelReadiness {
  worldId: string
  canSend: boolean
  items: ConversationModelReadinessItem[]
}

export interface ConversationModelReadinessInput {
  employeeIds: string[]
  modelProfileId?: string
  modelProfileIds?: Record<string, string>
}
