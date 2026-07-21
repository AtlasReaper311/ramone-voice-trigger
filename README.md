<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# ramone-voice-trigger

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // ramone-voice-trigger      │
│  say deploy, and the pipeline deploys:      │
│  voice as a client of github actions        │
└─────────────────────────────────────────────┘
```

![Worker](https://img.shields.io/badge/worker-cloudflare-f5a623?style=flat-square&labelColor=0a0a0f)
![Intent](https://img.shields.io/badge/intent-home%20assistant-4ade80?style=flat-square&labelColor=0a0a0f)
![API](https://img.shields.io/badge/api-github%20actions-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

"Ramone, deploy atlas systems." Home Assistant hears the sentence, resolves the repo slug, and POSTs to a Worker with a shared secret. The Worker checks the allowlist, fires `workflow_dispatch`, tells Discord a voice deploy started, answers HA within seconds, then watches the run in the background and posts the outcome. The deploy path is the estate's existing pipeline; voice is just one more authenticated client of it.

```
"deploy {repo}" ──▶ HA sentence trigger ──▶ script ──▶ rest_command
                                                          │  X-Trigger-Secret
                                                          ▼
                     ramone-trigger  api.atlas-systems.uk/trigger
                       ├─ allowlist gate (repo → workflow)
                       ├─ GitHub workflow_dispatch ──▶ the normal pipeline
                       ├─ atlas-notify: "voice deploy: {repo}"        [embed 1]
                       └─ waitUntil: poll run ──▶ success / failure   [embed 2]
```

## Prerequisites

- The Worker estate as it stands (atlas-notify live; this binds to it)
- A fine-grained GitHub PAT: **Actions read and write** on the six allowlisted repos, nothing else
- Home Assistant with Assist and the Ramone wake word working
- `wrangler` authenticated; `npm` for the lint step

## Setup

### 1. Patch the callers for `workflow_dispatch`

`workflow_dispatch` only works when the target workflow declares the trigger. Each allowlisted repo's caller gets a three-line addition to its `on:` block:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

atlas-notify is the special case: its deploy runs via `workflow_run` after CI succeeds, so its dispatch target is `ci.yml` and the chain does the rest. The allowlist in `wrangler.toml` encodes exactly this.

### 2. Deploy the Worker

```bash
cd worker
npm ci
npx eslint .
npx wrangler secret put TRIGGER_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put NOTIFY_TOKEN
npx wrangler deploy
```

Generate the trigger secret once and store it in Proton Pass; HA gets the same value in step 3:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Smoke-test from the shell before involving voice:

```bash
curl -sS https://api.atlas-systems.uk/trigger/_meta
curl -sS -X POST https://api.atlas-systems.uk/trigger \
  -H "x-trigger-secret: $TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repo": "github-pulse"}'
```

### 3. Place the Home Assistant config

| File in this repo | Destination in HA config |
|---|---|
| `ha-config/custom-sentences/en/github.yaml` | `custom_sentences/en/github.yaml` |
| `ha-config/automations/voice-trigger.yaml` | `automations/voice-trigger.yaml` (or append to `automations.yaml`) |
| `ha-config/scripts/github-trigger.yaml` | `scripts.yaml` (merge the top-level key) |
| `ha-config/rest-commands/github.yaml` | `rest-commands/github.yaml`, wired as `rest_command: !include rest-commands/github.yaml` |

Add the shared secret to `secrets.yaml`:

```yaml
ramone_trigger_secret: "<same value as TRIGGER_SECRET>"
```

Restart HA (or reload automations, scripts, and YAML config), then say it: "deploy github pulse."

### 4. Wire the estate deploy caller

Copy the 12-line reusable caller from [`github-pulse`](https://github.com/AtlasReaper311/github-pulse) into `.github/workflows/deploy.yml`, rename it for ramone-trigger, and set the usual secrets:

```bash
gh secret set CF_WORKERS_DEPLOY_TOKEN --repo AtlasReaper311/ramone-voice-trigger
gh secret set CF_ACCOUNT_ID --repo AtlasReaper311/ramone-voice-trigger
gh secret set DISCORD_CICD_WEBHOOK --repo AtlasReaper311/ramone-voice-trigger
```

## Adding a repo to the trigger list

Two edits, one redeploy:

1. `worker/wrangler.toml`: add `"new-repo": "deploy.yml"` to `REPO_ALLOWLIST`, then `npx wrangler deploy`.
2. `custom_sentences/en/github.yaml` in HA: add the spoken form under `lists.repo.values`, then reload conversation config.

The Worker's allowlist is the single source of truth for what voice can touch; the sentences file only decides how it is pronounced.

## Security model

Concentric gates, smallest surface first. One path, one method. A shared secret in a header, compared digest-to-digest so the check leaks neither content nor length through timing. An allowlist mapping each repo to its dispatchable workflow, so a stolen secret can only re-run pipelines that already run on every push; it cannot touch a new repo, and it cannot run arbitrary workflow files against the estate without an explicit mapping. Behind all of that, a fine-grained PAT scoped to Actions on six named repos, stored as a Worker secret on the runtime credential path, never in GitHub Actions, never in source.

The blast radius of full compromise is therefore: someone can redeploy main. The pipelines' own checks still gate what main deploys.

## Design notes

**HA never waits.** `rest_command` has a short timeout, so the Worker answers after the dispatch plus at most two quick run lookups (~3s), falling back to the workflow's Actions page URL when GitHub is slow to materialise the run. The 120-second completion watch runs in `ctx.waitUntil` after the response.

**The second embed is comfort, not truth.** `waitUntil` on the free tier is best effort; the guaranteed completion signal remains the pipeline's own notify, which fires from inside the run itself. The voice events are additive and labelled as such.

**No run id from dispatch.** GitHub answers `workflow_dispatch` with 204 and silence; the run is found by listing recent runs for that workflow filtered to the branch and event, newest first, created at or after the dispatch (with 5s of clock-skew allowance).

## Troubleshooting

### "unauthorised" with a secret you're sure is correct

You're almost certainly hitting a PowerShell quoting issue, not
an actual auth bug. Native Windows PowerShell mangles `$` and
backtick characters inside double-quoted strings before curl
ever sees them, so a secret containing either can differ
between what you typed and what got sent, even on an exact
copy-paste.

**Fix:** always test with `Invoke-RestMethod` and a hashtable
header, never `curl.exe` with an inline double-quoted secret:

```powershell
Invoke-RestMethod -Uri https://api.atlas-systems.uk/trigger `
  -Method POST `
  -Headers @{ "x-trigger-secret" = "YOUR_SECRET_HERE" } `
  -ContentType "application/json" `
  -Body (@{ repo = "atlas-systems" } | ConvertTo-Json)
```

If you must use `curl.exe`, escape inner double quotes manually:

```powershell
curl.exe -X POST https://api.atlas-systems.uk/trigger `
  -H "x-trigger-secret: YOUR_SECRET" `
  -d '{\"repo\":\"atlas-systems\"}'
```

WSL bash doesn't have this problem. Only native PowerShell.

### Rotating TRIGGER_SECRET

```powershell
cd L:\Atlas-Systems\ramone-voice-trigger\worker
npx wrangler secret put TRIGGER_SECRET
```

Paste the new value at the interactive prompt only. Never pass
it as a command-line argument, never paste it into a chat client
or issue tracker. If it's ever exposed outside this prompt,
rotate again immediately, don't just stop using it.

Generate a strong random value first if needed:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

## How it fits into Atlas Systems

This is the Ramone subsystem reaching into the pipeline: [`ramone-edge`](https://github.com/AtlasReaper311/ramone-edge) made Ramone publicly askable, and this makes Ramone operationally useful. Events flow through [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify) over a Service Binding like every other Worker-to-Worker call in the estate, the `/_meta` endpoint makes it discoverable to [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index), and the workflows it fires are the same reusable callers the whole estate deploys through.

Voice here is not a feature, it is a client; when deployment is already an authenticated API, every new interface to it is a thin adapter, and that is the payoff of building the pipeline first.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
