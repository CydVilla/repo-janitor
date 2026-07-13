# repo-janitor

A GitHub-only hygiene hub for the repos you care about. You onboard repos in `repos.json`, and two scheduled workflows do the rest: a daily **link scan** that checks every http(s) URL in each repo and keeps a per-link health history (including "last time this link worked"), and a weekly **dead-code sweep** that runs [Knip](https://knip.dev), auto-applies the safe fixes, verifies the repo still builds, and opens a cleanup PR. Reports land as a single continuously-updated issue in each target repo — no external services, no dashboards, no mailing infrastructure. GitHub issue subscriptions *are* the email reports: subscribe to the report issue and GitHub emails you on every update. (Real SMTP delivery is available as an opt-in extra.)

## Quickstart

1. **Push this repo to GitHub** (it is your hub — history and workflows live here):

   ```sh
   gh repo create my-repo-janitor --private --source . --push
   ```

2. **Create a fine-grained PAT** (Settings → Developer settings → Fine-grained tokens) scoped to the repos you want to scan, with these repository permissions:

   | Permission | Access |
   | --- | --- |
   | Contents | Read and write |
   | Issues | Read and write |
   | Pull requests | Read and write |
   | Metadata | Read |

3. **Add the PAT as an Actions secret** named `JANITOR_TOKEN` in this repo:

   ```sh
   gh secret set JANITOR_TOKEN
   ```

4. **Edit `repos.json`** to list your repos (see [Onboarding a repo](#onboarding-a-repo)).

5. **Enable the workflows** on the repo's Actions tab. The link scan runs daily, the dead-code sweep weekly; both can be triggered manually via *Run workflow*.

## Onboarding a repo

Add an entry to `repos.json`:

```json
{
  "repos": [
    {
      "repo": "you/your-app",
      "links": { "enabled": true, "report": "issue" },
      "deadCode": { "enabled": true, "openPRs": true }
    }
  ]
}
```

Full config reference (defaults applied by `src/config.ts` — every key except `repo` is optional):

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `repo` | string | *(required)* | `"owner/name"` of the target repo. |
| `branch` | string | repo's default branch | Branch to scan. |
| `links.enabled` | boolean | `true` | Include this repo in the link scan. |
| `links.report` | `"issue"` \| `"none"` | `"issue"` | `issue` upserts a report issue in the target repo; `none` only stores history. |
| `links.email` | string[] | `[]` | Extra email recipients; only used when SMTP secrets are configured. |
| `links.ignoreUrlPatterns` | string[] | `[]` | Regex source strings; matching URLs are never checked. |
| `links.failThreshold` | number | `3` | Consecutive failed scans before a link counts as broken. |
| `deadCode.enabled` | boolean | `false` | Include this repo in the dead-code sweep. |
| `deadCode.openPRs` | boolean | `true` | Open cleanup PRs; when `false`, findings are reported as an issue only. |
| `deadCode.fixTypes` | string[] | `["exports", "types"]` | Values passed to `knip --fix-type`. |
| `deadCode.verifyCommands` | string[] | auto-detected | Overrides the verification commands (default: the target's `typecheck`, `build`, `test` scripts, whichever exist). |

## How link health works

Every scan, each URL found in the repo is checked and folded into a small state machine:

- **ok** — the last check succeeded.
- **failing** — recent checks failed, but fewer than `failThreshold` in a row. One flaky day does not condemn a link.
- **broken** — the link failed `failThreshold` consecutive scans (default 3).

A single successful check resets a link straight back to **ok**. Each link also carries `lastOkAt` — **the last time this link worked**. It is set on every successful check and never touched by failures, so when a link finally breaks you can see exactly how long it has been dead (or that it was *never* seen working).

History lives in this repo under `data/links/<owner>__<name>.json`, one file per target repo, with per-link counters and a capped log of recent checks. The link-scan workflow commits `data/` after every run, so your git log doubles as the historical record of link health across all your repos.

## Reports

For each repo with `links.report: "issue"`, the scan upserts a single issue titled **🔗 Link health report** (label `repo-janitor`) *in the target repo* — updated in place on every scan, never duplicated. **Subscribe to that issue** and GitHub emails you every update; that is the whole email story by design.

### Reporting false positives

Sometimes the checker is wrong — a link sits behind a VPN or a paywall, blocks
automated clients, or only answers from certain regions. Comment on the report
issue to tell the janitor so:

```
/false-positive https://intranet.example.com/handbook
```

From the next scan on, that URL is dropped from the broken/failing sections and
listed under **Suppressed false positives** instead (with who reported it and
when), and the summary counts it as *suppressed*. The link is still checked and
its history still accumulates — only the reporting is muted. `/fp <url>` works
as a shorthand, the URL may be wrapped in backticks or `<angle brackets>`, and
one comment can carry several directives (one per line).

To un-suppress a link, comment `/not-false-positive <url>` (or `/not-fp <url>`),
or simply delete the marking comment — the suppression list is rebuilt from the
live comment thread on every scan, so the latest directive per URL wins. Marks
for URLs that disappear from the repo are pruned automatically, and a marked
link that is currently **ok** is reported as ok; the mark only mutes failures.

Note that anyone who can comment on the issue can suppress a link. That matches
the trust model of the report issue itself (it lives in the target repo), and
every suppression is visibly attributed in the report.

If you want real, direct email on top of that, set these Actions secrets and list recipients in `links.email`: `SMTP_HOST`, `SMTP_PORT` (optional, default 465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Without them, email delivery is entirely inert.

## Dead code

The weekly sweep clones each opted-in repo, installs its dependencies, and runs Knip to find unused files, exports, types, dependencies, and more. When there are findings and `openPRs` is on:

1. `knip --fix --fix-type exports,types` removes unused **exports and type exports** — deliberately *not* whole files or dependencies, which are too risky to delete unattended.
2. The **verification gate** runs the target's own `typecheck` / `build` / `test` scripts (or your `verifyCommands`). If anything fails, all changes are reverted and the run falls back to an issue report.
3. Only a green tree becomes a PR, on a branch named `repo-janitor/dead-code-<date>`.

**One PR at a time:** if the target repo already has an open PR from a `repo-janitor/` branch, the sweep leaves it alone rather than piling on. Merge or close the existing PR and the next sweep continues.

With `openPRs: false` (issue-only mode), or when nothing is auto-fixable, findings are posted to a **🧹 Dead code report** issue in the target repo instead — same upsert-and-subscribe model as link reports.

Note: janitor PRs are built from a 50-commit shallow clone — plenty of history for `git push` of a fresh branch, without paying for full clones of large repos.

**Trust model:** the sweep necessarily *runs code from the target repo* — Knip loads the repo's `knip.config.ts`, and the verification gate runs its `typecheck` / `build` / `test` scripts. repo-janitor strips `JANITOR_TOKEN`, `GITHUB_TOKEN`, and the SMTP secrets from the environment of every such process (git authenticates via per-command config, never env vars), but you should still only onboard repos whose committers you trust.

**`verifyCommands` format:** each entry is split on whitespace and executed directly, without a shell. `"node scripts/check.js --fast"` works; `"npm run lint && npm test"` or quoted arguments do not — use two list entries instead.

## Running locally

```sh
export JANITOR_TOKEN=github_pat_...   # or GITHUB_TOKEN
npm ci
npm run links       # link scan: updates data/, upserts report issues
npm run deadcode    # dead-code sweep: opens PRs / issues per config
```

Both commands print a per-repo results table and exit non-zero only when the scanner itself failed for some repo — broken links are report *content*, not a failure.

## Limitations & notes

- **GitHub API rate limits.** Every issue upsert and PR uses your PAT's quota (5,000 requests/hour). Fine for dozens of repos; hundreds may need staggered schedules.
- **Link-checking politeness.** Requests to the same host are serialized with a small delay, HEAD is tried before GET, and 429 responses count as *alive*. Still, very hot-tempered hosts may throttle you; add them to `ignoreUrlPatterns` if they cause noise.
- **False positives.** Transient outages are absorbed by `failThreshold` — a link must fail several *scans in a row* (days, not seconds) before being called broken. Raise the threshold per repo if a host is chronically flaky, and suppress individual wrongly-flagged links by commenting `/false-positive <url>` on the report issue (see [Reporting false positives](#reporting-false-positives)).
- **Knip caveats.** Knip's analysis is static: dynamic `import()` with computed paths, reflection, string-keyed lookups, and framework magic can make live code look dead. The verification gate catches what your type-checker and tests catch — **review janitor PRs before merging**, especially in repos with thin test coverage.
- **Yarn Berry.** Yarn 2+ repos are installed with `yarn install --immutable` and lifecycle scripts disabled via `YARN_ENABLE_SCRIPTS=0`. If you onboard a Berry repo, add a `corepack enable` step to `dead-code.yml` so the runner can use the repo's pinned Yarn version.
- **The janitor keeps itself clean.** Dependabot (`.github/dependabot.yml`) opens one grouped PR per week for npm dependency updates and another for the action versions pinned in the workflows; CI validates both before you merge.
