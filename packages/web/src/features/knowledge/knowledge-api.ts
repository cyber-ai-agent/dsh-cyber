export function knowledgeConsolidatePath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/consolidate`
}

export function knowledgeConsolidationJobsPath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/consolidation-jobs`
}

export function knowledgeConsolidationRetryPath(worldId: string, jobId: string): string {
  return `${knowledgeConsolidationJobsPath(worldId)}/${encodeURIComponent(jobId)}/retry`
}
