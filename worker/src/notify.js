/**
 * atlas-notify dispatch for ramone-trigger.
 *
 * Same shape as the shipped ramone-edge module: Service Binding first
 * (Worker-to-Worker inside Cloudflare's network, no public hop), URL
 * fallback for local dev, and never throws, because a failed embed
 * must never fail a deploy trigger.
 *
 * Envelope: the documented catch-all { source: "alert", level, title,
 * message, fields }. NOTIFY_SIGNAL_CLASS rides along when set so
 * channel routing can be added inside atlas-notify later without
 * touching this repo.
 */

export async function notify(env, event) {
  if (!env.NOTIFY_TOKEN) {
    console.log("notify: NOTIFY_TOKEN not set; skipping");
    return;
  }

  const body = {
    source: "alert",
    signal_class: env.NOTIFY_SIGNAL_CLASS || undefined,
    level: event.level,
    title: event.title,
    message: event.message,
    fields: event.fields,
  };
  // Remove undefined keys so the JSON is clean
  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

  const requestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.NOTIFY_TOKEN}`,
    },
    body: JSON.stringify(body),
  };

  try {
    let response;
    if (env.ATLAS_NOTIFY) {
      // Service binding: direct Worker-to-Worker call, no public internet
      response = await env.ATLAS_NOTIFY.fetch("https://atlas-notify/notify", requestInit);
    } else if (env.NOTIFY_URL) {
      // Fallback to URL (for local dev)
      response = await fetch(env.NOTIFY_URL, requestInit);
    } else {
      console.log("notify: no ATLAS_NOTIFY binding or NOTIFY_URL");
      return;
    }
    console.log("notify: status", response.status, "title:", event.title);
  } catch (err) {
    console.log("notify failed:", err.message);
  }
}
