// End of job. proxy mode: stop the job's optimizer (its last usage is
// reported on the way out) and summarize this runner's request log. mcp mode:
// Densilo is not on the token path, so report what Claude Code itself says it
// used (claude-code-action's execution file) plus the review tools' own tally
// of what they spared the agent, as one usage record for the account the key
// belongs to -- an organization's service account shows up under its name.
// Only counts are sent, never content. Never fails the job.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const GATEWAY = process.env.DENSILO_GATEWAY || 'https://api.densilo.com';
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const summary = (lines) => {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join(os.EOL) + os.EOL);
};
const warn = (m) => console.log(`::warning title=Densilo::${m}`);

function claudeReport(file) {
  // claude-code-action's execution file: a JSON array of Claude Code's events; the last "result" has usage.
  let events;
  try { events = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!Array.isArray(events)) return null;
  const result = [...events].reverse().find((e) => e && e.type === 'result');
  if (!result || !result.usage) return null;
  return result;
}

function tally(since) {
  const file = path.join(process.env.DENSILO_HOME || path.join(os.homedir(), '.densilo'), 'mcp-tally.jsonl');
  let calls = 0, returned = 0, baseline = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (since && r.t < since) continue;
      calls++; returned += r.returned_chars || 0; baseline += r.baseline_chars || 0;
    }
  } catch { /* no calls */ }
  // characters to tokens: the optimizer's own estimate for code-heavy text
  return { calls, sparedTokens: Math.max(0, Math.round((baseline - returned) / 3.5)) };
}

function meterEvent(result, t, withUsage) {
  const u = result ? result.usage : {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const models = Object.keys((result && result.modelUsage) || {});
  const main = models.sort((a, b) => ((result.modelUsage[b].costUSD || 0) - (result.modelUsage[a].costUSD || 0)))[0];
  const payload = {
    window_start: Math.floor(Date.now() / 1000 / 600) * 600,
    requests: withUsage ? (result && result.num_turns) || 0 : 0,
    input_tokens: withUsage ? input : 0,
    cached_tokens: withUsage ? (u.cache_read_input_tokens || 0) : 0,
    output_tokens: withUsage ? (u.output_tokens || 0) : 0,
    saved_tokens: t.sparedTokens,
    source: 'github-action-mcp',
  };
  if (main) payload.models = { [main]: { requests: payload.requests, saved_tokens: t.sparedTokens } };
  const id = ['gha', process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.env.GITHUB_JOB,
              Math.random().toString(36).slice(2, 10)].filter(Boolean).join('-').replace(/[^A-Za-z0-9_.:-]/g, '-');
  return { id: id.slice(0, 200), payload };
}

async function sendMeter(event) {
  const key = fs.readFileSync(path.join(os.homedir(), '.densilo', 'pilot.key'), 'utf8').trim();
  const r = await fetch(GATEWAY + '/meter', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-densilo-key': key },
    body: JSON.stringify({ events: [event] }),
  });
  if (!r.ok) throw new Error(`usage report refused (${r.status})`);
}

async function mcpReport(mode, since) {
  const file = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'claude-execution-output.json');
  const result = claudeReport(file);
  const t = tally(since);
  if (!result && !t.calls) return summary(['### Densilo', '', 'No Claude Code run found in this job to report.']);
  // proxy+mcp: the optimizer already reported the tokens; only the tools' tally is added
  const event = meterEvent(result, t, mode === 'mcp');
  let sent = 'reported to your Densilo account';
  try { await sendMeter(event); } catch (e) { sent = `not reported (${e.message})`; }
  const p = event.payload, u = result ? result.usage : {};
  const newInput = result ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
  summary(['### Densilo', '',
    result ? `Claude Code: ${result.num_turns} turns · ${fmt(newInput)} new input tokens (${fmt(u.cache_creation_input_tokens || 0)} cache writes) · ` +
             `${fmt(u.cache_read_input_tokens || 0)} cache reads · ${fmt(u.output_tokens || 0)} output` +
             (result.total_cost_usd != null ? ` · $${result.total_cost_usd.toFixed(3)} at API prices` : '') : 'Claude Code: no usage report found.',
    `Densilo review tools: ${t.calls} call${t.calls === 1 ? '' : 's'} · about ${fmt(p.saved_tokens)} tokens the agent did not have to read ` +
    '(what the tools returned vs. the diff and whole changed files; an estimate).',
    '', `Usage ${sent}. Console: https://densilo.com/app`]);
}

function proxyReport(densilo, since) {
  let totals;
  try {
    const out = execFileSync(densilo, ['ci', 'stop', ...(since ? ['--since', String(since)] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WIN, timeout: 120000 });
    totals = JSON.parse(out.trim().split(/\r?\n/).pop());
  } catch (error) {
    return warn(`could not read this job's totals: ${String(error.message || error).split('\n')[0]}`);
  }
  const newInput = Math.max(0, totals.input_tokens - totals.cached_tokens);
  const share = newInput + totals.saved_tokens > 0 ? totals.saved_tokens / (newInput + totals.saved_tokens) : null;
  summary(['### Densilo', '',
    totals.requests
      ? `${totals.requests} requests through Densilo · ${fmt(newInput)} new input tokens sent · ${fmt(totals.saved_tokens)} removed` +
        (share === null ? '' : ` (${(share * 100).toFixed(0)}% of new input)`) + ` · ${fmt(totals.cached_tokens)} cache reads (not counted)`
      : 'No requests went through Densilo in this job.',
    '', 'Token counts are Densilo\'s local estimates for this runner. Account usage: https://densilo.com/app']);
}

async function main() {
  const densilo = process.env.STATE_densilo;
  if (!densilo) return;
  const since = Number(process.env.STATE_started || 0);
  const mode = process.env.STATE_mode || 'mcp';
  if (mode !== 'mcp') proxyReport(densilo, since);
  if (mode !== 'proxy') await mcpReport(mode, since);
}

main().catch((error) => warn(String(error.message || error)));
