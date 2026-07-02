/**
 * ramone-trigger
 *
 * Voice-controlled GitHub Actions. Home Assistant POSTs here when a
 * deploy sentence fires; this Worker authenticates the caller, gates
 * the target against an allowlist, fires workflow_dispatch, reports
 * the trigger to atlas-notify, answers Home Assistant fast, and then
 * watches the run to completion in the background for a second embed.
 *
 * Security model, smallest to largest surface:
 *   - The route accepts one method on one path.
 *   - TRIGGER_SECRET gates every request, compared digest-to-digest so
 *     the comparison leaks neither content nor length timing.
 *   - The repo must be allowlisted; the allowlist maps each repo to
 *     its dispatchable workflow, so a stolen secret can only re-run
 *     pipelines the estate already runs on push.
 *   - The GitHub PAT is fine-grained: Actions read/write on the six
 *     allowlisted repos, nothing else, set via wrangler secret.
 *
 * Timing: Home Assistant's rest_command times out in seconds, so the
 * response goes back after at most a couple of quick run-lookup polls
 * (run_url falls back to the workflow's Actions page). The 120s
 * completion watch runs in ctx.waitUntil; it is additive comfort, and
 * the pipeline's own notify remains the guaranteed completion signal.
 */

import { handleMeta } from "./_meta.js";
import { dispatchWorkflow, getRun, resolveRun, sleep } from "./github.js";
import { notify } from "./notify.js";

const META = {
  name: "ramone-trigger",
  description: "Voice-triggered GitHub Actions dispatch for the Atlas estate",
  version: "1.0.0",
  endpoints: [
    {
      method: "POST",
      path: "/trigger",
      description: "Dispatch an allowlisted repo's workflow; X-Trigger-Secret required",
    },
    { method: "GET", path: "/trigger/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/ramone-voice-trigger",
};

/** JSON response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Constant-time secret comparison via digest-then-compare: hashing
 * both sides first means the byte comparison runs over equal-length
 * inputs whatever the caller sent, so neither content nor length
 * leaks through timing.
 */
async function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

/** Trigger notify + completion watch, run after the response is sent. */
async function watchAndNotify(env, job) {
  await notify(env, {
    level: "info",
    title: `voice deploy: ${job.repo}`,
    message: `Deploy triggered by voice: ${job.repo}/${job.workflow}@${job.ref}`,
    fields: {
      repo: job.repo,
      workflow: job.workflow,
      ref: job.ref,
      run_url: job.runUrl,
    },
  });

  let run = job.run;
  if (!run) {
    // The fast pre-response lookup missed; keep trying on a calmer clock.
    run = await resolveRun(env, job.repo, job.workflow, job.ref, job.sinceIso, 6, 5000);
  }
  if (!run) {
    await notify(env, {
      level: "warning",
      title: `voice deploy: ${job.repo} run not identified`,
      message:
        "Dispatch was accepted but the run could not be matched; " +
        "the pipeline's own notify will report the result.",
      fields: { repo: job.repo, workflow: job.workflow, ref: job.ref, run_url: job.runUrl },
    });
    return;
  }

  const timeoutS = Number(env.WATCH_TIMEOUT_S || "120");
  const intervalS = Number(env.WATCH_INTERVAL_S || "10");
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalS * 1000);
    try {
      const state = await getRun(env, job.repo, run.id);
      if (state.status === "completed") {
        const ok = state.conclusion === "success";
        await notify(env, {
          level: ok ? "success" : "failure",
          title: `voice deploy ${state.conclusion}: ${job.repo}`,
          message: `${job.repo}/${job.workflow}@${job.ref} finished: ${state.conclusion}`,
          fields: {
            repo: job.repo,
            workflow: job.workflow,
            ref: job.ref,
            conclusion: state.conclusion,
            run_url: state.html_url,
          },
        });
        return;
      }
    } catch (err) {
      console.log("watch poll failed:", err.message);
    }
  }
  await notify(env, {
    level: "warning",
    title: `voice deploy still running: ${job.repo}`,
    message: `No completion within ${timeoutS}s; the pipeline notify will report the result.`,
    fields: { repo: job.repo, workflow: job.workflow, ref: job.ref, run_url: run.html_url },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (url.pathname !== "/trigger" && url.pathname !== "/trigger/") {
      return json({ error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed; POST with X-Trigger-Secret" }, 405);
    }

    const authorised = await secretMatches(
      request.headers.get("x-trigger-secret"),
      env.TRIGGER_SECRET,
    );
    if (!authorised) return json({ error: "unauthorised" }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }

    let allowlist;
    try {
      allowlist = JSON.parse(env.REPO_ALLOWLIST);
    } catch {
      console.log("REPO_ALLOWLIST is not valid JSON");
      return json({ error: "server misconfiguration: allowlist unreadable" }, 500);
    }

    const repo = body.repo;
    if (!repo) return json({ error: "repo is required" }, 400);
    if (!(repo in allowlist)) {
      return json({ error: `repo not allowlisted: ${repo}`, allowed: Object.keys(allowlist) }, 403);
    }

    const workflow = body.workflow || allowlist[repo];
    const ref = body.ref || "main";
    // Skew buffer: the run's created_at can predate our clock slightly.
    const sinceIso = new Date(Date.now() - 5000).toISOString();

    try {
      await dispatchWorkflow(env, repo, workflow, ref);
    } catch (err) {
      ctx.waitUntil(
        notify(env, {
          level: "failure",
          title: `voice deploy rejected: ${repo}`,
          message: err.message,
          fields: { repo, workflow, ref },
        }),
      );
      return json({ triggered: false, error: err.message }, 502);
    }

    // Fast best-effort run lookup so HA gets a real URL when GitHub is
    // quick, and the Actions page when it is not. HA never waits long.
    const run = await resolveRun(
      env,
      repo,
      workflow,
      ref,
      sinceIso,
      Number(env.RESOLVE_ATTEMPTS || "2"),
      Number(env.RESOLVE_DELAY_MS || "1500"),
    );
    const runUrl =
      run?.html_url ||
      `https://github.com/${env.GITHUB_OWNER}/${repo}/actions/workflows/${workflow}`;

    ctx.waitUntil(watchAndNotify(env, { repo, workflow, ref, run, runUrl, sinceIso }));

    return json({ triggered: true, repo, workflow, ref, run_url: runUrl });
  },
};
