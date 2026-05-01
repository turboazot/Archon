import { Database } from 'bun:sqlite';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import type { OrchestratorStore, StoredOrchestratorRun } from '../../src/types';

interface StoredRunRow {
  id: string;
  repo: string;
  issue_number: number;
  workflow_run_id: string;
  branch: string;
  pr_number: number | null;
  status: StoredOrchestratorRun['status'];
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

export class SqliteOrchestratorStore implements OrchestratorStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orchestrator_runs (
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
        run_attempts INTEGER NOT NULL DEFAULT 1,
        fix_attempts INTEGER NOT NULL,
        comment_keys_json TEXT NOT NULL
      )
    `);
    this.addColumnIfMissing('orchestrator_runs', 'run_attempts', 'INTEGER NOT NULL DEFAULT 1');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_repo ON orchestrator_runs(repo)');
  }

  async listRuns(repo: string): Promise<StoredOrchestratorRun[]> {
    const rows = this.db
      .query<
        StoredRunRow,
        [string]
      >('SELECT * FROM orchestrator_runs WHERE repo = ? ORDER BY started_at ASC')
      .all(repo);
    return rows.map(rowToRun);
  }

  async createRun(run: StoredOrchestratorRun): Promise<void> {
    const existing = this.db
      .query<{ id: string }, [string]>('SELECT id FROM orchestrator_runs WHERE id = ?')
      .get(run.id);
    if (existing) throw new Error(`Run ${run.id} already exists`);
    this.upsert(run);
  }

  async updateRun(run: StoredOrchestratorRun): Promise<void> {
    const existing = this.db
      .query<{ id: string }, [string]>('SELECT id FROM orchestrator_runs WHERE id = ?')
      .get(run.id);
    if (!existing) throw new Error(`Unknown orchestrator run ${run.id}`);
    this.upsert(run);
  }

  close(): void {
    this.db.close();
  }

  private upsert(run: StoredOrchestratorRun): void {
    this.db
      .query(
        `INSERT INTO orchestrator_runs (
          id, repo, issue_number, workflow_run_id, branch, pr_number, status, workflow_label,
          area_labels_json, changed_files_json, started_at, updated_at, last_error, run_attempts,
          fix_attempts,
          comment_keys_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_run_id = excluded.workflow_run_id,
          branch = excluded.branch,
          pr_number = excluded.pr_number,
          status = excluded.status,
          workflow_label = excluded.workflow_label,
          area_labels_json = excluded.area_labels_json,
          changed_files_json = excluded.changed_files_json,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error,
          run_attempts = excluded.run_attempts,
          fix_attempts = excluded.fix_attempts,
          comment_keys_json = excluded.comment_keys_json`
      )
      .run(
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
        JSON.stringify(run.commentKeys)
      );
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (columns.some(existing => existing.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function rowToRun(row: StoredRunRow): StoredOrchestratorRun {
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

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}
