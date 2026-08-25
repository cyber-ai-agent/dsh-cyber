export function knowledgeConsolidatePath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/consolidate`
}
