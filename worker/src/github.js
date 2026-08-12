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
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

let installationTokenCache = null;

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function concatBytes(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derTagged(tag, body) {
  return concatBytes([Uint8Array.of(tag), derLength(body.length), body]);
}

function derSequence(parts) {
  return derTagged(0x30, concatBytes(parts));
}

function derOctetString(body) {
  return derTagged(0x04, body);
}

function rsaPrivateKeyToPkcs8(pkcs1Bytes) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryptionOid = Uint8Array.of(
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
  );
  const algorithm = derSequence([rsaEncryptionOid, Uint8Array.of(0x05, 0x00)]);
  return derSequence([version, algorithm, derOctetString(pkcs1Bytes)]).buffer;
}

function decodePem(pem, label) {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToArrayBuffer(pem) {
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) {
    return decodePem(pem, "PRIVATE KEY").buffer;
  }
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return rsaPrivateKeyToPkcs8(decodePem(pem, "RSA PRIVATE KEY"));
  }
  throw new Error(
    "RAMONE_GITHUB_APP_PRIVATE_KEY must be a PKCS8 or RSA private key PEM",
  );
}

function usesGitHubApp(env) {
  return Boolean(
    env.RAMONE_GITHUB_APP_CLIENT_ID &&
      env.RAMONE_GITHUB_APP_INSTALLATION_ID &&
      env.RAMONE_GITHUB_APP_PRIVATE_KEY,
  );
}

async function createAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.RAMONE_GITHUB_APP_CLIENT_ID,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.RAMONE_GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function mintInstallationToken(env) {
  const now = Date.now();
  if (
    installationTokenCache &&
    installationTokenCache.clientId === env.RAMONE_GITHUB_APP_CLIENT_ID &&
    installationTokenCache.installationId === env.RAMONE_GITHUB_APP_INSTALLATION_ID &&
    installationTokenCache.expiresAtMs - now > TOKEN_REFRESH_SKEW_MS
  ) {
    return installationTokenCache.token;
  }

  const jwt = await createAppJwt(env);
  const response = await fetch(
    `${API}/app/installations/${env.RAMONE_GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ramone-trigger/1.0",
      },
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GitHub ${response.status} minting installation token: ${detail}`);
  }
  const payload = await response.json();
  if (
    typeof payload.token !== "string" ||
    typeof payload.expires_at !== "string"
  ) {
    throw new Error("GitHub installation token response was malformed");
  }
  const expiresAtMs = Date.parse(payload.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    throw new Error("GitHub installation token expiry was malformed");
  }
  installationTokenCache = {
    clientId: env.RAMONE_GITHUB_APP_CLIENT_ID,
    installationId: env.RAMONE_GITHUB_APP_INSTALLATION_ID,
    token: payload.token,
    expiresAtMs,
  };
  return installationTokenCache.token;
}

async function githubToken(env) {
  if (usesGitHubApp(env)) return mintInstallationToken(env);
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  throw new Error("GitHub credential is not configured");
}

/** Standard headers for every GitHub call; a UA is mandatory. */
async function ghHeaders(env) {
  const token = await githubToken(env);
  return {
    authorization: `Bearer ${token}`,
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
  const headers = await ghHeaders(env);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
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
      const response = await fetch(url, { headers: await ghHeaders(env) });
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
  const response = await fetch(url, { headers: await ghHeaders(env) });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} reading run ${runId}`);
  }
  const run = await response.json();
  return { status: run.status, conclusion: run.conclusion, html_url: run.html_url };
}
