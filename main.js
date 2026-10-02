// Densilo for GitHub Actions: install Densilo on the runner, sign in with the
// CI key, and hand the agent step what it needs to run through Densilo.
//   claude-code-action  -> path_to_claude_code_executable: a wrapper that runs
//                          `densilo run claude` (the same launcher as on a laptop)
//   openai/codex-action -> responses-api-endpoint + codex-args: one optimizer
//                          for the job, from `densilo ci start`
// Never in the way: on any failure the outputs stay empty and the agent runs
// direct, unless fail-on-error is set. No dependencies; Node's own modules only.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const input = (name, def = '') => (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || def).trim();
const append = (file, line) => file && fs.appendFileSync(file, line + os.EOL);
const output = (name, value) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `densilo_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delim}${os.EOL}${value}${os.EOL}${delim}${os.EOL}`);
};
const state = (name, value) => append(process.env.GITHUB_STATE, `${name}=${value}`);
const log = (msg) => console.log(msg);
const warn = (msg) => console.log(`::warning title=Densilo::${msg.replace(/\r?\n/g, '%0A')}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WIN, ...opts });

function install(manifestUrl) {
  const env = { ...process.env, ...(manifestUrl ? { DENSILO_MANIFEST_URL: manifestUrl } : {}) };
  const base = manifestUrl ? manifestUrl.replace(/\/manifest\.json$/, '') : 'https://api.densilo.com';
  if (WIN) {
    run('powershell', ['-NoProfile', '-Command', `irm "${base}/install.ps1" | iex`], { env, stdio: 'inherit' });
    const root = path.join(process.env.LOCALAPPDATA || '', 'Densilo');
    const find = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const f = find(p); if (f) return f; }
        else if (e.name.toLowerCase() === 'densilo.cmd') return p;
      }
      return null;
    };
    return find(root);
  }
  execFileSync('sh', ['-c', `curl -fsSL "${base}/install.sh" | sh`], { env, stdio: 'inherit' });
  for (const p of ['/usr/local/bin/densilo', path.join(os.homedir(), '.local/bin/densilo')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function signIn(densilo, key) {
  // What `densilo login` does: write the account key (owner-only), then fetch
  // the account's entitlement -- `densilo run` asks for it when none is cached.
  const dir = path.join(os.homedir(), '.densilo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pilot.key'), key, { mode: 0o600 });
  spawnSync(densilo, ['run', '--', process.execPath, '-e', ''], { stdio: 'ignore', shell: WIN, timeout: 120000 });
}

const MCP_TOOLS = ['review_context', 'read_code', 'expand'].map((t) => `mcp__densilo__${t}`);
const MCP_NOTE_START = '<!-- densilo:mcp -->';
const MCP_NOTE = `${MCP_NOTE_START}
Code review (a pull request or a commit): start by calling the mcp__densilo__review_context tool, instead of
running git diff, git show or gh pr diff and instead of reading the changed files. It already contains the
diff, the changed functions in full, the tests that cover them and the project's rules, so a review usually
needs nothing else. For more code, use mcp__densilo__read_code (name the functions you need) rather than
reading whole files. Text marked "densilo:body h=..." is kept exactly: mcp__densilo__expand returns it.
<!-- /densilo:mcp -->`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function registerMcp(densilo) {
  // User-level Claude Code config, which claude-code-action loads (settingSources
  // include "user"): the server, permission for its tools, and when to use them.
  // Written as files: claude-code-action installs Claude Code after this step.
  const home = os.homedir();
  const claudeJson = path.join(home, '.claude.json');
  const config = readJson(claudeJson);
  config.mcpServers = { ...(config.mcpServers || {}), densilo: { type: 'stdio', command: densilo, args: ['mcp'] } };
  fs.writeFileSync(claudeJson, JSON.stringify(config, null, 2));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  const settings = readJson(settingsFile);
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = [...new Set([...(settings.permissions.allow || []), ...MCP_TOOLS])];
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const memory = path.join(dir, 'CLAUDE.md');
  const existing = fs.existsSync(memory) ? fs.readFileSync(memory, 'utf8') : '';
  if (!existing.includes(MCP_NOTE_START)) fs.writeFileSync(memory, (existing ? existing + '\n\n' : '') + MCP_NOTE + '\n');
}

function realClaude() {
  // The Claude Code that npm just installed, by absolute path, before any
  // wrapper exists: the wrapper must never be able to find itself.
  const bin = WIN ? path.join(run('npm', ['prefix', '-g']).trim(), 'claude.cmd')
                  : path.join(run('npm', ['prefix', '-g']).trim(), 'bin', 'claude');
  if (!fs.existsSync(bin)) throw new Error(`Claude Code was installed but ${bin} is missing`);
  const head = fs.readFileSync(bin, 'utf8').slice(0, 400);
  if (head.includes('densilo')) throw new Error(`${bin} is a Densilo wrapper, not Claude Code`);
  return bin;
}

function claudeWrapper(densilo, version) {
  // claude-code-action skips its own install when given an executable, so
  // Claude Code is installed here. The wrapper hands Densilo the real binary
  // by absolute path (`densilo <path> args` runs that file as Claude Code, as
  // for an editor), never `densilo run claude`: claude-code-action puts the
  // executable's folder on PATH, and a PATH lookup found the wrapper itself --
  // each run started another, until the runner died. Named densilo-claude so
  // nothing can mistake it for claude either.
  const pkg = `@anthropic-ai/claude-code${version && version !== 'latest' ? '@' + version : ''}`;
  run('npm', ['install', '-g', pkg], { stdio: 'inherit' });
  const claude = realClaude();
  const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'densilo');
  fs.mkdirSync(dir, { recursive: true });
  if (WIN) {
    const file = path.join(dir, 'densilo-claude.cmd');
    fs.writeFileSync(file, `@echo off\r\n"${densilo}" "${claude}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, 'densilo-claude');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${densilo}" "${claude}" "$@"\n`, { mode: 0o755 });
  return file;
}

function main() {
  const key = input('densilo-key');
  const agent = input('agent', 'claude').toLowerCase();
  const strict = input('fail-on-error', 'false') === 'true';
  state('started', String(Date.now() / 1000));
  output('enabled', 'false');
  output('claude-executable', '');
  output('codex-responses-endpoint', '');
  output('codex-args', '');
  try {
    if (!key.startsWith('ep_')) throw new Error('densilo-key is missing or not a Densilo key (densilo.com/app -> Organization -> Service accounts)');
    if (!['claude', 'codex', 'both'].includes(agent)) throw new Error(`agent must be claude, codex or both (got "${agent}")`);
    // densilo-path (testing): an already installed densilo, e.g. built from source.
    const given = input('densilo-path');
    const densilo = given || install(input('manifest-url'));
    if (!densilo) throw new Error('the installer finished but the densilo command was not found');
    state('densilo', densilo);
    append(process.env.GITHUB_PATH, path.dirname(densilo));
    try { log(run(densilo, ['--version']).trim()); } catch { log('densilo (version unknown)'); }
    signIn(densilo, key);

    const mode = input('mode', 'mcp').toLowerCase();
    state('mode', mode);
    if (!['proxy', 'mcp', 'both'].includes(mode)) throw new Error(`mode must be proxy, mcp or both (got "${mode}")`);
    if ((agent === 'claude' || agent === 'both') && mode !== 'mcp') {
      output('claude-executable', claudeWrapper(densilo, input('claude-code-version', 'latest')));
    }
    if (mode !== 'proxy') {
      registerMcp(densilo);
      // Claude Code defers MCP tools behind its tool search; the model would then
      // spend a turn finding these. Loaded up front instead, for the steps after this.
      append(process.env.GITHUB_ENV, 'ENABLE_TOOL_SEARCH=false');
      log('Densilo review tools registered for Claude Code (review_context, read_code, expand)');
    }
    if (agent === 'codex' || agent === 'both') {
      const started = JSON.parse(run(densilo, ['ci', 'start']).trim().split(/\r?\n/).pop());
      if (!started.ok) throw new Error(`Densilo did not start: ${started.error}`);
      state('ci', 'started');
      output('codex-responses-endpoint', started.codex_responses_endpoint);
      if (started.mcp_url) {
        output('codex-args', `-c mcp_servers.densilo_recovery={url="${started.mcp_url}",enabled=true}`);
      }
      log(`Codex goes through Densilo at ${started.url}`);
    }
    // `densilo run claude` decides per session; ask the same question now so
    // the log says whether this job will be optimized.
    const status = run(densilo, ['status']);
    const account = (status.split(/\r?\n/).find((l) => l.startsWith('account:')) || '').trim();
    log(account);
    // Signed in with a plan or credit left: `densilo run` will optimize. Otherwise
    // the agent still runs (direct), and the warning says why.
    const enabled = /^account: \S/.test(account) && !/not signed in|unverified|no active plan|revoked/i.test(account);
    if (!enabled) warn(`Densilo will not optimize this job: ${account || 'account unknown'}`);
    output('enabled', String(enabled));
  } catch (error) {
    const msg = String(error && (error.stderr || error.message) || error).trim();
    if (strict) {
      console.log(`::error title=Densilo::${msg}`);
      process.exitCode = 1;
      return;
    }
    output('claude-executable', '');
    output('codex-responses-endpoint', '');
    output('codex-args', '');
    warn(`Densilo is not set up for this job, so the agent runs direct: ${msg}`);
  }
}

main();
