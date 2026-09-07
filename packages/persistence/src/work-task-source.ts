import type { DatabaseSync } from 'node:sqlite'
import type { WorkTask, WorkTaskSourceTurn, WorkTurnStatus } from '@dsh-cyber/contracts'

const SOURCE_STATUS: Record<WorkTurnStatus, WorkTask['status']> = {
  queued: 'ready', running: 'running', 'waiting-approval': 'waiting-approval',
  completed: 'waiting-review', failed: 'failed', interrupted: 'recovery-required',
}

/** One batched read; board filters and detail use the same authoritative lifecycle.
 * Explicit execution/acceptance/cancellation always wins over the source turn.
 * No writes during reads, background poller, replay or synthetic execution.
 */
export function projectSourceTasks(database: DatabaseSync, tasks: WorkTask[]): WorkTask[] {
  const candidates = tasks.filter((task) => task.status === 'draft' && task.currentPlanRevision === 0 && task.sourceWorkTurnId !== undefined)
  if (candidates.length === 0) return tasks
  const states = new Map<string, WorkTurnStatus>()
  for (const worldId of new Set(candidates.map((task) => task.worldId))) {
    const rows = database.prepare(`
      SELECT task.id, turn.status FROM work_tasks task
      JOIN work_turns turn ON turn.id = task.source_work_turn_id
        AND turn.world_id = task.world_id AND turn.workspace_id = task.workspace_id
      WHERE task.world_id = ? AND task.status = 'draft' AND task.current_plan_revision = 0
        AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.task_id = task.id)
    `).all(worldId) as Array<{ id: string; status: WorkTurnStatus }>
    for (const row of rows) states.set(row.id, row.status)
  }
  return tasks.map((task) => {
    const status = states.get(task.id)
    return status === undefined ? task : { ...task, status: SOURCE_STATUS[status] }
  })
}

/** Only exact persisted provenance. Never match by title, time or employee alone. */
export function sourceTaskResults(database: DatabaseSync, task: WorkTask, source: WorkTaskSourceTurn): NonNullable<WorkTaskSourceTurn['results']> {
  const rows = database.prepare(`
    SELECT message.id, run.employee_id, substr(message.content, 1, 4000) AS content,
      length(message.content) > 4000 AS truncated
    FROM messages message JOIN agent_runs run
      ON run.id = json_extract(message.metadata_json, '$.agentRunId')
      AND run.turn_id = ? AND run.session_id = message.session_id
      AND run.workspace_id = ? AND run.world_id = ?
    WHERE message.session_id = ? AND message.kind = 'assistant'
      AND json_extract(message.metadata_json, '$.workTurnId') = ?
    ORDER BY message.sequence DESC, message.id DESC LIMIT 9
  `).all(source.workTurnId, task.workspaceId, task.worldId, source.sessionId, source.workTurnId) as Array<{ id: string; employee_id: string; content: string; truncated: number }>
  const versions = database.prepare(`
    SELECT version.artifact_id, version.version, artifact.title, artifact.kind
    FROM world_artifact_versions version JOIN world_artifacts artifact
      ON artifact.id = version.artifact_id AND artifact.world_id = version.world_id
    WHERE version.world_id = ? AND artifact.workspace_id = ? AND artifact.status = 'active'
      AND (version.session_id IS NULL OR version.session_id = ?)
      AND (version.work_turn_id = ? OR (version.work_turn_id IS NULL AND EXISTS (
        SELECT 1 FROM agent_runs run WHERE run.id = version.agent_run_id
          AND run.turn_id = ? AND run.world_id = ? AND run.session_id = ?)))
    ORDER BY version.created_at DESC, version.artifact_id, version.version DESC LIMIT 21
  `).all(task.worldId, task.workspaceId, source.sessionId, source.workTurnId, source.workTurnId, task.worldId, source.sessionId) as Array<{ artifact_id: string; version: number; title: string; kind: string }>
  return {
    messages: rows.slice(0, 8).map((row) => ({ id: row.id, employeeId: row.employee_id, content: row.content, truncated: Boolean(row.truncated) })),
    artifacts: versions.slice(0, 20).map((row) => ({ artifactId: row.artifact_id, version: row.version, title: row.title, kind: row.kind })),
    hasMore: rows.length > 8 || versions.length > 20,
  }
}
