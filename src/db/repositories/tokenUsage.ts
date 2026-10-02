import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import type { LlmUsage } from '../../llm/types.js';

export interface TokenUsageRow {
  handle?: string;
  chatId?: string;
  taskId?: string;
  role: string;
  label?: string;
  provider: string;
  model: string;
  /** Absent on error rows and on providers that returned no usage — recorded as zeros. */
  usage?: LlmUsage;
  latencyMs?: number;
  /** The PRIMARY provider when this call was served by the fallback lane. */
  fallbackFrom?: string;
  status?: 'ok' | 'error' | 'aborted';
  /** Capped error message when status='error'. */
  error?: string;
  /** The provider's raw stop/finish reason, verbatim ('end_turn' | 'max_tokens' | 'length' | …). */
  stopReason?: string;
  /** The cap actually SENT (req.maxTokens ?? MAX_TOKENS[role]) — a tiny per-call cap binding over
   *  the role ceiling is the usual cause of truncation, and invisible without this column. */
  maxTokensSent?: number;
  /** Provider-neutral truncation flag (isTruncatedStop). Truncated calls stay status='ok' —
   *  llm_role_stats/llm_hourly count status in ('ok','error') explicitly. */
  truncated?: boolean;
}

/**
 * Record one LLM call in the durable call ledger (tokens + latency + status + fallback
 * lane). Fire-and-forget analytics: never throws. Always writes — on the memory driver
 * the ledger is ephemeral but live, so budget caps and the dashboard see real numbers.
 */
export async function recordTokenUsage(row: TokenUsageRow): Promise<void> {
  try {
    stmt(
      `INSERT INTO token_usage
         (handle, chat_id, task_id, role, label, provider, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          latency_ms, fallback_from, status, error, stop_reason, max_tokens_sent, truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.handle ?? null,
      row.chatId ?? null,
      row.taskId ?? null,
      row.role,
      row.label ?? null,
      row.provider,
      row.model,
      row.usage?.inputTokens ?? 0,
      row.usage?.outputTokens ?? 0,
      row.usage?.cacheCreationInputTokens ?? 0,
      row.usage?.cacheReadInputTokens ?? 0,
      // total_tokens is a generated column — don't insert it.
      row.latencyMs ?? null,
      row.fallbackFrom ?? null,
      row.status ?? 'ok',
      row.error ? row.error.slice(0, 500) : null,
      row.stopReason ?? null,
      row.maxTokensSent ?? null,
      row.truncated ? 1 : 0,
      Date.now(),
    );
  } catch (error) {
    logDbError('recordTokenUsage', error);
  }
}

// ---------------------------------------------------------------------------
// Analytics readers (dashboard + daily budget). Aggregates run as plain SQL —
// one indexed GROUP BY beats pulling a whole window of rows into Node on every
// dashboard poll.
// ---------------------------------------------------------------------------

export interface LlmRoleStat {
  role: string;
  provider: string;
  model: string;
  calls: number;
  errors: number;
  fallbacks: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface LlmHourlyBucket {
  bucket: number;          // epoch ms of the hour
  calls: number;
  errors: number;
  fallbacks: number;
  totalTokens: number;
  avgLatencyMs: number | null;
}

export interface SlowLlmCall {
  createdAt: number;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  latencyMs: number;
  // Split tokens (not just the total) so the dashboard can price the call — input, output and
  // cache reads bill at different rates (see estimateCostUsd).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  handle: string | null;
  chatId: string | null;
}

export interface LlmErrorCall {
  createdAt: number;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  latencyMs: number | null;
  error: string | null;
  handle: string | null;
  chatId: string | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** One ledger row with everything the per-turn cost view needs (id for cross-query dedup). */
export interface UsageRowLite {
  id: number;
  taskId: string | null;
  chatId: string | null;
  handle: string | null;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  status: string;
  latencyMs: number | null;
  createdAt: number;   // epoch ms
}

const LITE_COLUMNS = 'id, task_id, chat_id, handle, role, label, provider, model, '
  + 'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, '
  + 'status, latency_ms, created_at';

function rowToLite(r: Record<string, unknown>): UsageRowLite {
  return {
    id: num(r.id),
    taskId: (r.task_id as string | null) ?? null,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    role: r.role as string,
    label: (r.label as string | null) ?? null,
    provider: r.provider as string,
    model: r.model as string,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_input_tokens),
    cacheCreationTokens: num(r.cache_creation_input_tokens),
    status: (r.status as string) ?? 'ok',
    latencyMs: numOrNull(r.latency_ms),
    createdAt: num(r.created_at),
  };
}

/**
 * Ledger rows inside a time window, scoped to a chat or (for chat-less turns like
 * the email Judge) to a handle with no chat_id — so a user's simultaneous chat
 * traffic can't leak into their email-turn costs. Uses the (chat_id, created_at)
 * / (handle, created_at) indexes.
 */
export async function listUsageInWindow(
  scope: { chatId?: string; handle?: string },
  sinceMs: number,
  untilMs: number,
): Promise<UsageRowLite[]> {
  if (!scope.chatId && !scope.handle) return [];
  try {
    const scopeSql = scope.chatId ? 'chat_id = ?' : 'handle = ? AND chat_id IS NULL';
    const rows = stmt(
      `SELECT ${LITE_COLUMNS} FROM token_usage
       WHERE ${scopeSql} AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC LIMIT 1000`
    ).all(scope.chatId ?? scope.handle!, sinceMs, untilMs) as unknown as Record<string, unknown>[];
    return rows.map(rowToLite);
  } catch (error) {
    logDbError('listUsageInWindow', error);
    return [];
  }
}

/**
 * Ledger rows for a set of delegated task ids — the exact-attribution leg. Late
 * Ops/Composer work lands outside any turn's time window; task_id is how it still
 * bills to the turn that delegated it.
 */
export async function listUsageForTasks(taskIds: string[]): Promise<UsageRowLite[]> {
  if (!taskIds.length) return [];
  try {
    // json_each keeps one statement shape regardless of how many ids arrive.
    const rows = stmt(
      `SELECT ${LITE_COLUMNS} FROM token_usage
       WHERE task_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at ASC LIMIT 1000`
    ).all(JSON.stringify(taskIds.slice(0, 200))) as unknown as Record<string, unknown>[];
    return rows.map(rowToLite);
  } catch (error) {
    logDbError('listUsageForTasks', error);
    return [];
  }
}

export async function getLlmRoleStats(since: number, handle?: string): Promise<LlmRoleStat[]> {
  try {
    const h = handle ?? null;
    const groups = stmt(
      `SELECT role, provider, model,
              count(*) FILTER (WHERE status = 'ok')                              AS calls,
              count(*) FILTER (WHERE status = 'error')                           AS errors,
              count(*) FILTER (WHERE fallback_from IS NOT NULL)                  AS fallbacks,
              round(avg(latency_ms) FILTER (WHERE status = 'ok'))                AS avg_latency_ms,
              count(*) FILTER (WHERE status = 'ok' AND latency_ms IS NOT NULL)   AS ok_latency_n,
              coalesce(sum(input_tokens), 0)                                     AS input_tokens,
              coalesce(sum(output_tokens), 0)                                    AS output_tokens,
              coalesce(sum(cache_read_input_tokens), 0)                          AS cache_read_tokens,
              coalesce(sum(cache_creation_input_tokens), 0)                      AS cache_creation_tokens,
              coalesce(sum(total_tokens), 0)                                     AS total_tokens
       FROM token_usage
       WHERE created_at >= ? AND (? IS NULL OR handle = ?)
       GROUP BY role, provider, model
       ORDER BY calls DESC`
    ).all(since, h, h) as unknown as Record<string, unknown>[];
    return groups.map(r => {
      // Nearest-rank p95 per group (SQLite has no percentile_cont; the handful of
      // groups makes one tiny indexed query each cheaper than a window scan).
      let p95: number | null = null;
      const n = num(r.ok_latency_n);
      if (n > 0) {
        const at = stmt(
          `SELECT latency_ms FROM token_usage
           WHERE created_at >= ? AND (? IS NULL OR handle = ?)
             AND role = ? AND provider = ? AND model = ?
             AND status = 'ok' AND latency_ms IS NOT NULL
           ORDER BY latency_ms LIMIT 1 OFFSET ?`
        ).get(since, h, h, r.role as string, r.provider as string, r.model as string,
              Math.max(0, Math.ceil(0.95 * n) - 1)) as { latency_ms: number } | undefined;
        p95 = at ? Number(at.latency_ms) : null;
      }
      return {
        role: r.role as string,
        provider: r.provider as string,
        model: r.model as string,
        calls: num(r.calls),
        errors: num(r.errors),
        fallbacks: num(r.fallbacks),
        avgLatencyMs: numOrNull(r.avg_latency_ms),
        p95LatencyMs: p95,
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        cacheReadTokens: num(r.cache_read_tokens),
        cacheCreationTokens: num(r.cache_creation_tokens),
        totalTokens: num(r.total_tokens),
      };
    });
  } catch (error) {
    logDbError('getLlmRoleStats', error);
    return [];
  }
}

export async function getLlmHourly(since: number): Promise<LlmHourlyBucket[]> {
  try {
    const rows = stmt(
      `SELECT (created_at / 3600000) * 3600000                       AS bucket,
              count(*) FILTER (WHERE status = 'ok')                  AS calls,
              count(*) FILTER (WHERE status = 'error')               AS errors,
              count(*) FILTER (WHERE fallback_from IS NOT NULL)      AS fallbacks,
              coalesce(sum(total_tokens), 0)                         AS total_tokens,
              round(avg(latency_ms) FILTER (WHERE status = 'ok'))    AS avg_latency_ms
       FROM token_usage
       WHERE created_at >= ?
       GROUP BY bucket
       ORDER BY bucket`
    ).all(since) as unknown as Record<string, unknown>[];
    return rows.map(r => ({
      bucket: num(r.bucket),
      calls: num(r.calls),
      errors: num(r.errors),
      fallbacks: num(r.fallbacks),
      totalTokens: num(r.total_tokens),
      avgLatencyMs: numOrNull(r.avg_latency_ms),
    }));
  } catch (error) {
    logDbError('getLlmHourly', error);
    return [];
  }
}

export async function listSlowestCalls(since: number, limit = 20): Promise<SlowLlmCall[]> {
  try {
    const rows = stmt(
      `SELECT created_at, role, label, provider, model, latency_ms,
              input_tokens, output_tokens, cache_read_input_tokens, total_tokens, handle, chat_id
       FROM token_usage
       WHERE status = 'ok' AND latency_ms IS NOT NULL AND created_at >= ?
       ORDER BY latency_ms DESC LIMIT ?`
    ).all(since, Math.min(Math.max(limit, 1), 50)) as unknown as Record<string, unknown>[];
    return rows.map(r => ({
      createdAt: num(r.created_at),
      role: r.role as string,
      label: (r.label as string | null) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      latencyMs: num(r.latency_ms),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_input_tokens),
      totalTokens: num(r.total_tokens),
      handle: (r.handle as string | null) ?? null,
      chatId: (r.chat_id as string | null) ?? null,
    }));
  } catch (error) {
    logDbError('listSlowestCalls', error);
    return [];
  }
}

/** Most recent FAILED LLM calls in the window (status='error'), newest first — the dashboard's
 *  error log. Errors are already durably recorded by recordLlmError (callLLM.ts); this just reads
 *  them back. Mirrors listSlowestCalls' shape/limits. */
export async function listRecentErrors(since: number, limit = 20): Promise<LlmErrorCall[]> {
  try {
    const rows = stmt(
      `SELECT created_at, role, label, provider, model, latency_ms, error, handle, chat_id
       FROM token_usage
       WHERE status = 'error' AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(since, Math.min(Math.max(limit, 1), 50)) as unknown as Record<string, unknown>[];
    return rows.map(r => ({
      createdAt: num(r.created_at),
      role: r.role as string,
      label: (r.label as string | null) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      latencyMs: numOrNull(r.latency_ms),
      error: (r.error as string | null) ?? null,
      handle: (r.handle as string | null) ?? null,
      chatId: (r.chat_id as string | null) ?? null,
    }));
  } catch (error) {
    logDbError('listRecentErrors', error);
    return [];
  }
}
