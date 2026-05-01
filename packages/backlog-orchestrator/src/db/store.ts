import { pool } from '@archon/core/db';
import type { OrchestratorStore, OrchestratorRunStatus, StoredOrchestratorRun } from '../types';

interface BacklogRunRow {
  id: string;
  repo: string;
  issue_number: number;
  workflow_run_id: string;
  branch: string;
  pr_number: number | null;
  status: OrchestratorRunStatus;
  workflow_label: string;
  area_labels_json: string;
  changed_files_json: string;
  started_at: string;
  updated_at: string;
  last_error: string | null;
  run_attempts: number;
  fix_attempts: number;
  comment_keys_json: string;
}

let schemaReady = false;

export class DbBacklogOrchestratorStore implements OrchestratorStore {
  async listRuns(repo: string): Promise<StoredOrchestratorRun[]> {
    await ensureSchema();
    const result = await pool.query<BacklogRunRow>(
      `SELECT * FROM remote_agent_backlog_orchestrator_runs
       WHERE repo = $1
       ORDER BY started_at ASC`,
      [repo]
    );
    return result.rows.map(rowToRun);
  }

  async createRun(run: StoredOrchestratorRun): Promise<void> {
    await ensureSchema();
    await pool.query(
      `INSERT INTO remote_agent_backlog_orchestrator_runs
       (id, repo, issue_number, workflow_run_id, branch, pr_number, status, workflow_label,
        area_labels_json, changed_files_json, started_at, updated_at, last_error,
        run_attempts, fix_attempts, comment_keys_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      runToParams(run)
    );
  }

  async updateRun(run: StoredOrchestratorRun): Promise<void> {
    await ensureSchema();
    await pool.query(
      `UPDATE remote_agent_backlog_orchestrator_runs
       SET workflow_run_id = $2,
           branch = $3,
           pr_number = $4,
           status = $5,
           workflow_label = $6,
           area_labels_json = $7,
           changed_files_json = $8,
           updated_at = $9,
           last_error = $10,
           run_attempts = $11,
           fix_attempts = $12,
           comment_keys_json = $13
       WHERE id = $1`,
      [
        run.id,
        run.workflowRunId,
        run.branch,
        run.prNumber ?? null,
        run.status,
        run.workflowLabel,
        JSON.stringify(run.areaLabels),
        JSON.stringify(run.changedFiles),
        run.updatedAt.toISOString(),
        run.lastError ?? null,
        run.runAttempts,
        run.fixAttempts,
        JSON.stringify(run.commentKeys),
      ]
    );
  }
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS remote_agent_backlog_orchestrator_runs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      workflow_run_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      pr_number INTEGER,
      status TEXT NOT NULL,
      workflow_label TEXT NOT NULL,
      area_labels_json TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      run_attempts INTEGER NOT NULL,
      fix_attempts INTEGER NOT NULL,
      comment_keys_json TEXT NOT NULL
    )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_backlog_orchestrator_runs_repo
     ON remote_agent_backlog_orchestrator_runs(repo)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_backlog_orchestrator_runs_issue
     ON remote_agent_backlog_orchestrator_runs(repo, issue_number)`
  );
  schemaReady = true;
}

function runToParams(run: StoredOrchestratorRun): unknown[] {
  return [
    run.id,
    run.repo,
    run.issueNumber,
    run.workflowRunId,
    run.branch,
    run.prNumber ?? null,
    run.status,
    run.workflowLabel,
    JSON.stringify(run.areaLabels),
    JSON.stringify(run.changedFiles),
    run.startedAt.toISOString(),
    run.updatedAt.toISOString(),
    run.lastError ?? null,
    run.runAttempts,
    run.fixAttempts,
    JSON.stringify(run.commentKeys),
  ];
}

function rowToRun(row: BacklogRunRow): StoredOrchestratorRun {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    workflowRunId: row.workflow_run_id,
    branch: row.branch,
    prNumber: row.pr_number ?? undefined,
    status: row.status,
    workflowLabel: row.workflow_label,
    areaLabels: parseStringArray(row.area_labels_json),
    changedFiles: parseStringArray(row.changed_files_json),
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    lastError: row.last_error ?? undefined,
    runAttempts: row.run_attempts,
    fixAttempts: row.fix_attempts,
    commentKeys: parseStringArray(row.comment_keys_json),
  };
}

function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}
