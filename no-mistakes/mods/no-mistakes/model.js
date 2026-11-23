// Read-only data for the no-mistakes cockpit. No writes, no migrations.
import { exec, home } from "herdr";

const RUN_ID = /^[0-9A-Z]{26}$/;
const homes = new Map();

// The database and logs live on the machine whose space this cockpit was
// opened in (null: this computer). One module serves every copy, so the
// target travels with each call instead of living in module state.
async function machineHome(on) {
  if (!on) return home();
  const known = homes.get(on);
  if (known) return known;
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on, timeout: 15000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || `cannot find the home folder on ${on}`);
  const root = r.stdout.trim();
  homes.set(on, root);
  return root;
}

async function dbPath(on) {
  return `${await machineHome(on)}/.no-mistakes/state.sqlite`;
}

export async function query(sql, on) {
  const path = await dbPath(on);
  const r = await exec("sqlite3", ["-readonly", "-json", path, sql],
    on ? { timeout: 15000, on } : { timeout: 15000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "sqlite3 failed");
  const text = r.stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}

const RUNS = `select r.id, r.repo_id, p.working_path, r.branch, r.status,
  r.created_at, r.updated_at, r.pr_url, r.pr_state, r.parked_ms,
  r.awaiting_agent_since, r.intent, r.head_sha, r.base_sha,
  r.worktree_dir, r.ci_ready_at, r.last_pushed_at,
  exists(select 1 from step_results s where s.run_id = r.id
         and s.status in ('awaiting_approval', 'fix_review')) as waiting,
  (select max(s.completed_at) - min(s.started_at)
     from step_results s where s.run_id = r.id) as total_ms
from runs r join repos p on p.id = r.repo_id
order by r.created_at desc limit 80`;

const STEPS = (id) => `select step_name, step_order, status, duration_ms,
  started_at, completed_at, findings_json, error, log_path,
  last_activity_at, last_activity, agent_pid, round_started_at,
  auto_fix_limit, ci_fix_attempts, exit_code, skip_reason, approval_reason
from step_results where run_id = '${checkId(id)}' order by step_order, id`;

const INVOCATIONS = (id) => `select step_name, round, purpose, agent, model,
  duration_ms, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, tool_calls, finding_count, exit_status,
  failure_category, workload_files, workload_lines, model_roundtrips
from agent_invocations where run_id = '${checkId(id)}' order by started_at, id`;

const ROUNDS = (id) => `select sr.step_name, r.round, r.trigger_type,
  r.duration_ms, r.selection_source, r.selected_finding_ids, r.fix_summary,
  r.findings_json, r.created_at
from step_rounds r join step_results sr on sr.id = r.step_result_id
where sr.run_id = '${checkId(id)}' order by sr.step_order, r.round`;

function checkId(id) {
  if (!RUN_ID.test(String(id))) throw new Error("invalid run id");
  return id;
}

// A step's log file exists from the moment it starts, but the row's log_path
// is only written once the step ends: a step still running has no recorded
// path, so it is read from the data directory's conventional location.
export async function stepLogPath(runId, stepName, on) {
  const root = await machineHome(on);
  return `${root}/.no-mistakes/logs/${checkId(runId)}/${stepName}.log`;
}

export const runList = (on) => query(RUNS, on);
export const runSteps = (id, on) => query(STEPS(id), on);
export const runInvocations = (id, on) => query(INVOCATIONS(id), on);
export const runRounds = (id, on) => query(ROUNDS(id), on);

export function pickRun(runs) {
  if (!runs?.length) return null;
  return runs.find((r) => r.waiting)
    || runs.find((r) => r.status === "handed_off")
    || runs.find((r) => r.status === "running" || r.status === "pending")
    || runs[0];
}

export function pickStep(steps, current) {
  if (!steps?.length) return null;
  return steps.find((s) => s.step_name === current)
    || steps.find((s) => s.status === "awaiting_approval" || s.status === "fix_review")
    || steps.find((s) => s.status === "failed")
    || steps.find((s) => s.status === "running" || s.status === "fixing")
    || [...steps].reverse().find((s) => s.log_path)
    || steps[steps.length - 1];
}

export function gateStep(steps) {
  return (steps || []).find((s) => s.status === "awaiting_approval" || s.status === "fix_review") || null;
}

export function nowStep(steps) {
  if (!steps?.length) return null;
  return steps.find((s) => s.status === "awaiting_approval" || s.status === "fix_review")
    || steps.find((s) => s.status === "failed")
    || steps.find((s) => s.status === "running" || s.status === "fixing")
    || [...steps].reverse().find((s) => s.status === "completed")
    || steps[0];
}

export function parseFindings(json) {
  if (!json) return { summary: "", findings: [] };
  try {
    const d = JSON.parse(json);
    const findings = Array.isArray(d.findings) ? d.findings
      : Array.isArray(d.items) ? d.items : [];
    return { summary: d.summary || "", findings };
  } catch {
    return { summary: "", findings: [] };
  }
}

export const base = (path) => {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
};

export const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : "—");

export function fmtDuration(ms) {
  if (ms == null) return "—";
  const n = Math.max(0, Number(ms));
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtTokens(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
}

export function age(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const label = (s) => String(s || "unknown").replace(/_/g, " ");

export function statusColor(t, status) {
  switch (status) {
    case "running":
    case "fixing":
      return t.working;
    case "awaiting_approval":
    case "fix_review":
      return t.blocked;
    case "completed":
    case "checks_passed":
    case "passed":
      return t.done;
    case "failed":
      return t.ansi1;
    default:
      return t.muted;
  }
}

export function severityColor(t, severity) {
  const s = String(severity || "").toLowerCase();
  if (s === "blocking" || s === "error") return t.ansi1;
  if (s === "warning" || s === "ask-user") return t.blocked;
  if (s === "info") return t.working;
  return t.muted;
}

export function lineColor(t, line) {
  if (/panic|fatal|\bFAIL\b|error=|exited .*error/i.test(line)) return t.ansi1;
  if (/retry|retrying|warn|quiet/i.test(line)) return t.blocked;
  if (/pi started|status=success|exited .*success/i.test(line)) return t.done;
  if (/^\s*[\[{]/.test(line)) return t.dim;
  return t.foreground;
}

export function clip(text, n) {
  const s = String(text || "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
