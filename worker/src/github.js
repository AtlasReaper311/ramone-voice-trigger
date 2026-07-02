/**
 * GitHub Actions API layer for ramone-trigger.
 *
 * Three calls, one quirk worth knowing: workflow_dispatch returns 204
 * with no run id. The created run has to be found afterwards by
 * listing recent runs for that workflow and matching on event, branch,
 * and a created_at newer than the dispatch time (with a small clock
 * skew buffer applied by the caller). Resolution is therefore
 * best-effort by design; the trigger itself is not.
 */

const API = "https://api.github.com";

/** Standard headers for every GitHub call; a UA is mandatory. */
function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ramone-trigger/1.0",
  };
}

/** Small awaitable pause between polls. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fire workflow_dispatch for owner/repo/workflow at ref.
 * @throws {Error} with an actionable message on any non-204 answer.
 */
export async function dispatchWorkflow(env, repo, workflow, ref) {
  const url = `${API}/repos/${env.GITHUB_OWNER}/${repo}/actions/workflows/${workflow}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...ghHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (response.status === 204) return;

  const detail = (await response.text()).slice(0, 300);
  if (response.status === 404) {
    // The two 404 causes look identical from outside; say both.
    throw new Error(
      `GitHub 404 for ${repo}/${workflow}: workflow file missing, or its ` +
        `"on:" block lacks workflow_dispatch (patch the caller). ${detail}`,
    );
  }
  if (response.status === 422) {
    throw new Error(`GitHub 422 for ${repo}@${ref}: bad ref? ${detail}`);
  }
  throw new Error(`GitHub ${response.status} dispatching ${repo}/${workflow}: ${detail}`);
}

/**
 * Find the run a dispatch just created, or null.
 * Polls the workflow's recent runs and takes the newest one created at
 * or after sinceIso. Never throws: an unresolved run URL degrades to
 * the workflow's Actions page, not to a failed trigger.
 */
export async function resolveRun(env, repo, workflow, ref, sinceIso, attempts, delayMs) {
  const since = Date.parse(sinceIso);
  const url =
    `${API}/repos/${env.GITHUB_OWNER}/${repo}/actions/workflows/${workflow}/runs` +
    `?branch=${encodeURIComponent(ref)}&event=workflow_dispatch&per_page=5`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    try {
      const response = await fetch(url, { headers: ghHeaders(env) });
      if (!response.ok) {
        console.log(`resolveRun: GitHub ${response.status} on attempt ${attempt}`);
        continue;
      }
      const runs = (await response.json()).workflow_runs || [];
      const match = runs.find((run) => Date.parse(run.created_at) >= since);
      if (match) return { id: match.id, html_url: match.html_url };
    } catch (err) {
      console.log(`resolveRun: attempt ${attempt} failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Current state of one run.
 * @returns {{status: string, conclusion: string|null, html_url: string}}
 */
export async function getRun(env, repo, runId) {
  const url = `${API}/repos/${env.GITHUB_OWNER}/${repo}/actions/runs/${runId}`;
  const response = await fetch(url, { headers: ghHeaders(env) });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} reading run ${runId}`);
  }
  const run = await response.json();
  return { status: run.status, conclusion: run.conclusion, html_url: run.html_url };
}
