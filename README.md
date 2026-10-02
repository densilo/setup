# Densilo for GitHub Actions

**Claude reviews every pull request — at half the cost.**

Add one step before your Claude action. Reviews finish instead of running out
of turns, and each finished review costs about half as much.

```yaml
      - uses: densilo/setup@v1
        with:
          densilo-key: ${{ secrets.DENSILO_KEY }}
      - uses: anthropics/claude-code-action@v1
        # ...your existing step, unchanged
```

## Set up (free during early access)

1. Sign in at [densilo.com/app](https://densilo.com/app), open the account menu
   (top left) and choose **New organization**. Invite your team by email.
2. On the **Organization** page, add a service account for the repository
   (for example `github: acme/api`) and copy its key.
3. In the repository: Settings → Secrets and variables → Actions → New
   repository secret, named `DENSILO_KEY`.
4. Add the step above before your Claude step.

Each job's summary shows what Claude used and what Densilo spared it; the
organization's dashboard adds it up by service account.

## What it does

Densilo gives Claude Code a few local review tools: one call returns the
change, the code it touches and the tests that cover it, so the review needs
far fewer turns. Anything shortened is kept exactly and handed back on request.
It runs on your runner; your code and your Anthropic key go from the runner to
Anthropic as before. Densilo's service only receives token counts.

If Densilo can't be set up (no key, an outage), the step warns and your review
runs exactly as it would without it. It never fails your job unless you set
`fail-on-error: true`.

## Measured

On real pull requests (Sonnet 5, the standard review prompt, a 15-turn
limit): 11 of 12 reviews finished vs 5 of 12 without Densilo, planted bugs
caught 5 of 6 vs 2 of 6, and cost per finished review $0.37 vs $0.73. Your own
numbers are in every job summary.

## Inputs

| input | default | |
|---|---|---|
| `densilo-key` | (required) | a service account key (or a personal key from the dashboard) |
| `mode` | `mcp` | `mcp`: Densilo's review tools. `proxy`: Claude Code's traffic through Densilo (set `path_to_claude_code_executable` on the Claude step to the `claude-executable` output). `both`. |
| `fail-on-error` | `false` | fail the job instead of running the review without Densilo |
| `claude-code-version` | `latest` | for `proxy` mode: the Claude Code it installs |

Runners: Linux and macOS (Windows beta). Questions: support@densilo.com
