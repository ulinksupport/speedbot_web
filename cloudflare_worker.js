// ─────────────────────────────────────────────────────────────────────────────
//  Cloudflare Worker — Speedbot Unified Meta Webhook Router
//
//  Single registered callback URL for WhatsApp + Facebook Messenger + Instagram
//  (all under the same Meta App). Splits traffic:
//
//    GET  → webhook verification (hub.challenge)
//    POST whatsapp_business_account, value.statuses[]   → PATCH messages + template_sends in Supabase (no n8n)
//    POST whatsapp_business_account, value.messages[]   → forward to WHATSAPP_N8N_URL
//    POST page/instagram, messaging.read/.delivery       → PATCH messages in Supabase (no n8n)
//    POST page/instagram, messaging.message              → forward to META_N8N_URL
//
//  Environment variables (set in Cloudflare dashboard → Workers → Settings → Variables):
//    VERIFY_TOKEN      — any string you choose, must match Meta App dashboard
//    SUPABASE_URL      — https://ehhynoowqlsgmcfyqofh.supabase.co
//    SUPABASE_KEY      — Supabase service role key
//    WHATSAPP_N8N_URL  — https://guest-annie-oxygen-pal.trycloudflare.com/webhook/whatsapp-agent-webhook
//    META_N8N_URL      — https://guest-annie-oxygen-pal.trycloudflare.com/webhook/meta-agent-webhook
//    META_APP_ID       — 867205216298809 (same App as WhatsApp; also hardcoded
//                         client-side in index.html's OAuth dialog URL — the two must match)
//    META_APP_SECRET   — from Meta App Dashboard → Settings → Basic. Only ever goes here.
//    CHANNELS_API_KEY  — any string you choose, must match META_CHANNELS_API_KEY in index.html.
//                         Gates /channels/list and /channels/disconnect — without this, those
//                         two routes would be reachable by anyone on the internet who finds the
//                         Worker URL (it's public, embedded in index.html's own JS bundle).
// ─────────────────────────────────────────────────────────────────────────────

// Facebook/Instagram "Connect" OAuth (Meta App Review — pages_messaging +
// instagram_manage_messages). Popup-based: index.html opens a popup at
// Facebook's OAuth dialog, Facebook redirects the popup back here for the
// server-side token exchange (the App Secret must never reach the browser),
// then the popup postMessages the result to its opener and closes itself —
// the main dashboard tab is never navigated away, so its password-gated,
// session-less login state survives the round trip.
//
// The `state` param is minted server-side by /oauth/start (HMAC over a
// timestamp, keyed on META_APP_SECRET) rather than chosen by the client.
// /oauth/callback verifies that signature — and rejects — before doing ANY
// side effect (token exchange, Page subscribe, Supabase write). Without
// this, anyone who completes Meta's real consent screen for this app
// (any Facebook user, once the app has Advanced Access — not just Ulink
// staff) could hit /oauth/callback directly and get their own unrelated
// Page written into this single-tenant dashboard's channel_connections.
const GRAPH_VERSION      = 'v23.0';
const OAUTH_REDIRECT_URI = 'https://damp-band-cbd6.supportdesk-a17.workers.dev/oauth/callback';
const DASHBOARD_ORIGIN   = 'https://ulink-social-media-platform.vercel.app';
const ALLOWED_ORIGINS = [
  'https://ulink-social-media-platform.vercel.app',
  'http://localhost:3000'
];

function getCorsOrigin(req) {
  const origin = req.headers.get('Origin');

  return ALLOWED_ORIGINS.includes(origin)
    ? origin
    : DASHBOARD_ORIGIN;
}
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the Facebook consent screen

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const corsOrigin = getCorsOrigin(req);

    // Central Meta WABA token API
    if (url.pathname === '/meta-api') {
        return handleMetaApi(req, env);
    }

    // WhatsApp media upload using central Meta WABA token
    if (url.pathname === '/meta-media-upload') {
        return handleMetaMediaUpload(req, env);
    }

    // Insert outgoing media message using central Supabase service-role key
    if (url.pathname === '/supabase-message-insert') {
        return handleSupabaseMessageInsert(req, env);
    }

    // Log template sends using central Supabase service-role key
    if (url.pathname === '/supabase-template-send-insert') {
        return handleSupabaseTemplateSendInsert(req, env);
    }

    // Supabase Storage upload using central service-role key
    if (url.pathname === '/supabase-storage-upload') {
        return handleSupabaseStorageUpload(req, env);
    }

    // ── Meta channel connect + management routes ──────────────────
    // /oauth/callback is the one route below NOT gated by X-Channels-Key —
    // it can't be, Meta itself calls it with no custom headers. That's
    // exactly why it's the one that needs its own server-verified `state`
    // (see verifyOAuthState) rather than relying on this header.
    if (url.pathname === '/oauth/callback' && req.method === 'GET') {
      return handleOAuthCallback(url, env);
    }
    const ADMIN_ROUTES = ['/oauth/start', '/channels/list', '/channels/disconnect'];
    if (ADMIN_ROUTES.includes(url.pathname)) {
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin':  corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
          },
        });
      }
      // NOTE: this key is shipped inside index.html's own JS, same as every
      // other credential this single-tenant internal dashboard already keeps
      // client-side (ADMIN_PASSWORD, META_TOKEN, the Supabase key). It stops
      // drive-by/automated hits on these routes from outside this app's
      // existing trust boundary, but it is NOT per-user auth — anyone who
      // can view-source the deployed dashboard has it too. A real fix would
      // mean giving this whole app actual server-verified login sessions,
      // which is a separate, much larger project than this feature.
      if (req.headers.get('X-Channels-Key') !== env.CHANNELS_API_KEY) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      if (url.pathname === '/oauth/start' && req.method === 'GET') {
        return handleOAuthStart(req, env);
      }
      if (url.pathname === '/channels/list' && req.method === 'GET') {
        return handleChannelsList(req, env);
      }
      if (url.pathname === '/channels/disconnect' && req.method === 'POST') {
        return handleDisconnect(req, env);
      }
    }

    // ── Webhook verification (GET from Meta during setup) ─────────
    if (req.method === 'GET') {
      const mode      = url.searchParams.get('hub.mode');
      const token     = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response('ok', { status: 200 }); // malformed — ignore
    }

    // DEBUG: log full payload for every POST
    console.log('[Worker] FULL PAYLOAD:', JSON.stringify(body).slice(0, 1500));

    // Respond 200 immediately, process in the background
    ctx.waitUntil(routeWebhook(body, env));

    return new Response('ok', { status: 200 });
  },
};

async function routeWebhook(body, env) {
  const object = body?.object;
  const entry  = body?.entry?.[0];
  console.log('[Worker] object:', object, '| entry keys:', entry ? Object.keys(entry) : 'NO ENTRY');
  if (!entry) return;

  if (object === 'whatsapp_business_account') {
    return handleWhatsApp(entry, env);
  }

  if (object === 'page' || object === 'instagram') {
    return handleMeta(body, entry, env);
  }

  console.log('[Worker] Unhandled object type:', object);
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp (object: whatsapp_business_account)
// ─────────────────────────────────────────────────────────────────────────────
async function handleWhatsApp(entry, env) {
  const value = entry?.changes?.[0]?.value;
  if (!value) return;

  // Only process messages for Speedbot's phone numbers — ignore others.
  // Both IDs are accepted: 970011649529902 is the original number (still used
  // by the Chat Flow's image/START/STOP nodes), 1292684077252611 is the
  // number now live under the "Ulink Assist - Tourism" WABA (migrated
  // 2026-07-28; the previous 1281614575027016 was deleted during cutover).
  const SPEEDBOT_PHONE_NUMBER_IDS = [
  '970011649529902',
  '1292684077252611',
  '1286180077917309'
  ];
  const phoneNumberId = value.metadata?.phone_number_id ?? '';
  if (phoneNumberId && !SPEEDBOT_PHONE_NUMBER_IDS.includes(phoneNumberId)) {
    console.log('[Worker] Ignoring WhatsApp event for phone_number_id: ' + phoneNumberId + ' (not Speedbot)');
    return;
  }

  const tasks = [];

  // Status receipts (sent/delivered/read/failed) → Supabase only
  if (Array.isArray(value.statuses) && value.statuses.length) {
    for (const status of value.statuses) {
      tasks.push(handleWhatsAppStatus(status, env));
    }
  }

  // Real inbound messages → forward to n8n, wrapped back into the
  // entry/changes/value shape that `Edit Fields` already expects.
  // Only forward messages from +60 (Malaysia) numbers for now.
  if (Array.isArray(value.messages) && value.messages.length) {
    const forwardBody = { object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] };
    tasks.push(
      fetch(env.WHATSAPP_N8N_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(forwardBody),
      }).catch(e => console.error('[Worker] WhatsApp forward failed:', e.message))
    );
  }

  await Promise.allSettled(tasks);
}

// Status webhooks (sent/delivered/read) can arrive out of order under retries
// or network jitter. STATUS_RANK_GUARD says, for each incoming status, which
// current DB statuses it's allowed to overwrite — anything ranked higher
// (e.g. an already-'read' message) is left alone so a late 'delivered' can't
// regress the UI backwards. 'failed' is intentionally unguarded: Meta only
// sends it in place of delivered/read, not after, so always recording it is
// safe and more useful than silently dropping it on a rank mismatch.
const STATUS_RANK_GUARD = {
  sent:      ['sent'],                 // DB default is already 'sent' — effectively a no-op, kept for clarity
  delivered: ['sent', 'delivered'],
  read:      ['sent', 'delivered', 'read'],
};

async function handleWhatsAppStatus(status, env) {
  const { id, status: state, timestamp, errors } = status;
  if (!id) return;

  const now   = new Date(Number(timestamp) * 1000).toISOString();
  const patch = {};

  switch (state) {
    case 'sent':
      patch.status = 'sent';
      break;
    case 'delivered':
      patch.status       = 'delivered';
      patch.delivered_at = now;
      break;
    case 'read':
      patch.status  = 'read';
      patch.read_at = now;
      break;
    case 'failed':
      patch.status = 'failed';
      patch.failed_at = now;
      if (Array.isArray(errors) && errors.length) {
        patch.failure_code    = String(errors[0].code ?? '');
        patch.failure_message = errors[0].error_data?.details || errors[0].title || errors[0].message || null;
      }
      break;
    default:
      return; // 'warning' and other events — ignore
  }

  await Promise.allSettled([
    patchMessagesByWamid(id, patch, env, STATUS_RANK_GUARD[state] || null),
    patchTemplateSendsByWamid(id, patch, env, STATUS_RANK_GUARD[state] || null),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Messenger / Instagram (object: page / instagram)
// ─────────────────────────────────────────────────────────────────────────────
async function handleMeta(body, entry, env) {
  console.log('[Worker] handleMeta entry keys:', Object.keys(entry), '| has messaging:', !!entry?.messaging);
  const messaging = entry?.messaging?.[0];
  if (!messaging) {
    console.log('[Worker] handleMeta: no messaging found, full entry:', JSON.stringify(entry).slice(0, 500));
    return;
  }

  // Read/delivery receipts → Supabase only
  if (messaging.read || messaging.delivery) {
    return handleMetaReceipt(messaging, env);
  }

  // Real inbound messages → forward whole body to n8n unchanged
  // (matches `Normalize Meta Message`'s `$json.body.entry[0].messaging[0]` /
  // `$json.body.object` parsing — n8n's Webhook node wraps our raw POST as `$json.body`)
  if (messaging.message) {
    return fetch(env.META_N8N_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).catch(e => console.error('[Worker] Meta forward failed:', e.message));
  }

  // Postbacks / other event types — ignore for now
}

async function handleMetaReceipt(messaging, env) {
  const senderId  = messaging.sender?.id;
  if (!senderId) return;

  const isRead     = !!messaging.read;
  const watermarkMs = Number(messaging.read?.watermark ?? messaging.delivery?.watermark);
  if (!watermarkMs) return;

  const watermarkIso = new Date(watermarkMs).toISOString();
  const nowIso       = new Date().toISOString();

  // Find the conversation for this PSID
  const convUrl = `${env.SUPABASE_URL}/rest/v1/conversations`
                + `?meta_psid=eq.${encodeURIComponent(senderId)}&select=id&limit=1`;
  const convRes = await fetch(convUrl, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` },
  });
  if (!convRes.ok) {
    console.error(`[Worker] conversation lookup failed for ${senderId}: ${convRes.status}`);
    return;
  }
  const [conv] = await convRes.json();
  if (!conv?.id) return;

  // Bulk-update outgoing messages up to the watermark timestamp
  const patch = isRead
    ? { status: 'read', read_at: nowIso }
    : { status: 'delivered', delivered_at: nowIso };

  const statusOr = STATUS_RANK_GUARD[isRead ? 'read' : 'delivered']
    .map(s => `status.eq.${s}`).concat('status.is.null').join(',');

  const msgUrl = `${env.SUPABASE_URL}/rest/v1/messages`
              + `?conversation_id=eq.${conv.id}&sender=eq.outgoing&created_at=lte.${encodeURIComponent(watermarkIso)}`
              + `&or=(${encodeURIComponent(statusOr)})`;

  const res = await fetch(msgUrl, {
    method:  'PATCH',
    headers: {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    console.error(`[Worker] Supabase PATCH failed for conversation ${conv.id}: ${res.status} — ${await res.text()}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────────────────────────────────────
async function patchMessagesByWamid(wamid, patch, env, allowedCurrentStatuses) {
  let url = `${env.SUPABASE_URL}/rest/v1/messages?wamid=eq.${encodeURIComponent(wamid)}`;
  if (allowedCurrentStatuses) {
    // status=is.null included defensively — status has a DB default so this
    // shouldn't happen in practice, but never block a real update on it.
    const statusOr = allowedCurrentStatuses.map(s => `status.eq.${s}`).concat('status.is.null').join(',');
    url += `&or=(${encodeURIComponent(statusOr)})`;
  }

  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    console.error(`[Worker] Supabase PATCH failed for wamid ${wamid}: ${res.status} — ${await res.text()}`);
  }
}

// Template broadcast sends are logged in a separate `template_sends` table
// (Template Manager → Analytics tab reads from it), also keyed by `wamid`.
// n8n used to update this table from a status webhook it never actually
// receives (Meta status callbacks are handled entirely here, above, and
// never forwarded to n8n — see the file header) — that node was dead code.
// Mirrors patchMessagesByWamid's rank-guard PATCH against this table instead.
async function patchTemplateSendsByWamid(wamid, patch, env, allowedCurrentStatuses) {
  let url = `${env.SUPABASE_URL}/rest/v1/template_sends?wamid=eq.${encodeURIComponent(wamid)}`;
  if (allowedCurrentStatuses) {
    const statusOr = allowedCurrentStatuses.map(s => `status.eq.${s}`).concat('status.is.null').join(',');
    url += `&or=(${encodeURIComponent(statusOr)})`;
  }

  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    console.error(`[Worker] template_sends PATCH failed for wamid ${wamid}: ${res.status} — ${await res.text()}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta "Connect" OAuth — Facebook Page + Instagram Business Account
// ─────────────────────────────────────────────────────────────────────────────
// Issues the signed state the client must round-trip through Facebook. Kept
// as a separate GET (rather than the client picking its own state) so the
// callback below can refuse to do anything — token exchange, Page subscribe,
// Supabase write — unless the code it received traces back to a state this
// Worker itself minted a few minutes ago.
async function handleOAuthStart(req, env) {
  const ts    = String(Date.now());
  const sig   = await hmacHex(env.META_APP_SECRET, ts);
  const state = `${ts}.${sig}`;
  return new Response(JSON.stringify({ state }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': getCorsOrigin(req) },
  });
}

async function verifyOAuthState(state, env) {
  if (!state || !state.includes('.')) return false;
  const [tsStr, sig] = state.split('.');
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_TTL_MS || Date.now() < ts) return false;
  const expected = await hmacHex(env.META_APP_SECRET, tsStr);
  return timingSafeEqual(sig, expected);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleOAuthCallback(url, env) {
  const code        = url.searchParams.get('code');
  const state       = url.searchParams.get('state') || '';
  const oauthError  = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (oauthError) {
    return oauthResultPage({ ok: false, error: oauthError, state });
  }
  if (!(await verifyOAuthState(state, env))) {
    console.error('[Worker] OAuth callback rejected: invalid or expired state.');
    return oauthResultPage({ ok: false, error: 'This connect request expired or is invalid. Please try again.', state });
  }
  if (!code) {
    return oauthResultPage({ ok: false, error: 'No authorization code returned by Meta.', state });
  }

  try {
    const shortLivedToken = await exchangeCodeForToken(code, env);
    const longLivedToken  = await exchangeForLongLivedToken(shortLivedToken, env);
    const pages           = await fetchManagedPages(longLivedToken, env);

    if (!pages.length) {
      return oauthResultPage({
        ok: false,
        state,
        error: 'No Facebook Pages were selected. Try again and choose at least one Page in the Facebook dialog.',
      });
    }

    // Subscribe + save sequentially, not Promise.all — a partial failure this
    // way still leaves the earlier pages fully connected instead of racing
    // Supabase writes for no benefit (this only ever runs for a handful of
    // pages per connect click).
    const results = [];
    for (const page of pages) {
      const subscribed = await subscribePageWebhooks(page.id, page.access_token, env);
      await upsertChannelConnection(page, subscribed, env);
      results.push({ name: page.name, ig_username: page.instagram_business_account?.username || null, webhook_subscribed: subscribed });
    }

    const failedSubs = results.filter(r => !r.webhook_subscribed);
    return oauthResultPage({
      ok: true,
      state,
      pages: results,
      warning: failedSubs.length
        ? `Connected, but Meta didn't confirm the webhook subscription for: ${failedSubs.map(r => r.name).join(', ')}. Messages may not arrive until you retry.`
        : null,
    });
  } catch (err) {
    console.error('[Worker] OAuth callback failed:', err.message);
    return oauthResultPage({ ok: false, error: err.message, state });
  }
}

async function exchangeCodeForToken(code, env) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    + `?client_id=${encodeURIComponent(env.META_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`
    + `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}`
    + `&code=${encodeURIComponent(code)}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message || 'Facebook token exchange failed.');
  }
  return data.access_token;
}

// Short-lived user tokens expire in ~1-2h; exchanging for long-lived (~60d)
// means the Page tokens minted from it (below) are effectively non-expiring
// as long as the connecting user keeps their Page role — no refresh flow needed.
async function exchangeForLongLivedToken(shortLivedToken, env) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    + `?grant_type=fb_exchange_token`
    + `&client_id=${encodeURIComponent(env.META_APP_ID)}`
    + `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}`
    + `&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message || 'Facebook long-lived token exchange failed.');
  }
  return data.access_token;
}

async function fetchManagedPages(userToken, env) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`
    + `?fields=id,name,access_token,instagram_business_account{id,username}`
    + `&limit=100&access_token=${encodeURIComponent(userToken)}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || 'Failed to list managed Facebook Pages.');
  }
  return data.data || [];
}

// Returns whether Meta actually confirmed the subscription — the caller
// stores this alongside the connection and surfaces it in the UI, rather
// than silently reporting "Connected" for a Page that will never actually
// deliver a webhook. Graph API's subscribed_apps returns `{success:true}` in
// the body on a real success — a 2xx status alone isn't proof, so both are checked.
async function subscribePageWebhooks(pageId, pageToken, env) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/subscribed_apps`
    + `?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads`
    + `&access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url, { method: 'POST' });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || data?.success !== true) {
    console.error(`[Worker] subscribed_apps failed for page ${pageId}: ${res.status} — ${JSON.stringify(data)}`);
    return false;
  }
  return true;
}

async function upsertChannelConnection(page, webhookSubscribed, env) {
  const row = {
    page_id:                 page.id,
    page_name:                page.name,
    page_access_token:        page.access_token,
    ig_business_account_id:   page.instagram_business_account?.id || null,
    ig_username:              page.instagram_business_account?.username || null,
    webhook_subscribed:       webhookSubscribed,
    updated_at:                new Date().toISOString(),
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/channel_connections?on_conflict=page_id`, {
    method:  'POST',
    headers: {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Failed to save connection for Page "${page.name}": ${res.status} ${await res.text()}`);
  }
}

// Client-facing list — deliberately never returns page_access_token. The
// dashboard already carries a client-side Supabase key that (see prior audit)
// is scoped far more broadly than it should be; giving that same surface a
// path to long-lived Page tokens too would just widen the blast radius, so
// this table is only ever read/written from the Worker, server-side.
async function handleChannelsList(req, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/channel_connections`
    + `?select=page_id,page_name,ig_business_account_id,ig_username,webhook_subscribed,connected_at&order=connected_at.desc`;
  const res  = await fetch(url, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` },
  });
  if (!res.ok) {
    console.error(`[Worker] channels/list Supabase fetch failed: ${res.status} — ${await res.text()}`);
    return new Response(JSON.stringify({ ok: false, error: 'Failed to load connections' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': getCorsOrigin(req) },
    });
  }
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': getCorsOrigin(req) },
  });
}

async function handleDisconnect(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const pageId = body?.page_id;
  if (!pageId) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing page_id' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
    });
  }

  const lookup = await fetch(
    `${env.SUPABASE_URL}/rest/v1/channel_connections?page_id=eq.${encodeURIComponent(pageId)}&select=id,page_access_token&limit=1`,
    { headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` } }
  );
  if (!lookup.ok) {
    console.error(`[Worker] disconnect lookup failed: ${lookup.status} — ${await lookup.text()}`);
    return new Response(JSON.stringify({ ok: false, error: 'Failed to look up connection — try again.' }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
    });
  }
  const [row] = await lookup.json();
  if (!row) {
    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
    });
  }

  // Unsubscribe from Meta BEFORE deleting the row. If this fails we deliberately
  // keep the row (and its token) intact — deleting it anyway would silently
  // strand the Page still subscribed on Meta's side with no record left here
  // to retry the unsubscribe or explain why messages are still arriving.
  if (row.page_access_token) {
    try {
      const unsubRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(row.page_access_token)}`,
        { method: 'DELETE' }
      );
      let unsubData = null;
      try { unsubData = await unsubRes.json(); } catch {}
      if (!unsubRes.ok || unsubData?.success !== true) {
        console.error(`[Worker] unsubscribe failed for page ${pageId}: ${unsubRes.status} — ${JSON.stringify(unsubData)}`);
        return new Response(JSON.stringify({ ok: false, error: 'Could not confirm Meta unsubscribe — try again.' }), {
          status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
        });
      }
    } catch (e) {
      console.error('[Worker] unsubscribe request failed:', e.message);
      return new Response(JSON.stringify({ ok: false, error: 'Could not reach Meta to unsubscribe — try again.' }), {
        status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
      });
    }
  }

  // Conditional delete: match on `id` AND the exact page_access_token we just
  // looked up and unsubscribed. `on_conflict=page_id` upserts UPDATE the same
  // row in place on a reconnect (same id), so matching on id alone doesn't
  // protect against a reconnect racing in here — the token column would have
  // just changed underneath us instead. If a reconnect swapped the token
  // between our lookup and this delete, the WHERE clause won't match any row,
  // `return=representation` comes back empty, and we report that instead of
  // silently deleting a connection that was just re-established.
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/channel_connections`
      + `?id=eq.${row.id}`
      + `&page_access_token=eq.${encodeURIComponent(row.page_access_token)}`,
    {
      method:  'DELETE',
      headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Prefer': 'return=representation' },
    }
  );
  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'Failed to remove connection — try again.' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
    });
  }
  const deletedRows = await res.json();
  if (!deletedRows.length) {
    return new Response(JSON.stringify({ ok: false, error: 'This Page was reconnected while disconnecting — please try again.' }), {
      status: 409, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
  });
}

function oauthResultPage({ ok, error, warning, state, pages }) {
  const payload = jsonForInlineScript({
    type: 'meta_connect_result', ok, error: error || null, warning: warning || null, state, pages: pages || [],
  });
  const message = error || warning || null;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:sans-serif;padding:40px;text-align:center;color:#334155;">
  <p>${ok ? 'Connected. This window will close automatically…' : 'Something went wrong. This window will close automatically…'}</p>
  ${message ? `<p style="color:${ok ? '#b45309' : '#dc2626'};font-size:14px;">${escapeForHtml(message)}</p>` : ''}
  <script>
    (function () {
      var result = ${payload};
      if (window.opener) {
        try { window.opener.postMessage(result, ${jsonForInlineScript(DASHBOARD_ORIGIN)}); } catch (e) {}
      }
      setTimeout(function () { window.close(); }, ${ok ? 1200 : 5000});
    })();
  <\/script>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

function escapeForHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Plain JSON.stringify doesn't escape `<`/`>`/`&`, so a Page name, error
// string, or anything else Meta-supplied that contains "</script>" could
// break out of the inline script below and execute in this page's origin.
// U+2028/2029 are additionally illegal unescaped inside a JS string literal
// per spec (some engines choke on them there even though they're valid JSON).
function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function handleMetaApi(req, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  const apiKey = req.headers.get('X-Channels-Key');

  if (!env.CHANNELS_API_KEY || apiKey !== env.CHANNELS_API_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  if (!env.META_WABA_TOKEN) {
    return new Response(JSON.stringify({ error: 'Meta token is not configured' }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  let payload;

  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  const method = String(payload.method || 'GET').toUpperCase();
  const path = String(payload.path || '');

  if (!path.startsWith('/')) {
    return new Response(JSON.stringify({ error: 'Invalid Meta API path' }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  const metaUrl = `https://graph.facebook.com/v23.0${path}`;

  const headers = {
    Authorization: `Bearer ${env.META_WABA_TOKEN}`,
  };

  const options = {
    method,
    headers,
  };

  if (
    payload.body !== undefined &&
    method !== 'GET' &&
    method !== 'DELETE'
  ) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload.body);
  }

  try {
    const metaResponse = await fetch(metaUrl, options);
    const responseText = await metaResponse.text();

    return new Response(responseText, {
      status: metaResponse.status,
      headers: {
        ...corsHeaders,
        'Content-Type':
          metaResponse.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message || 'Meta API request failed' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

async function handleMetaMediaUpload(req, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Access-Control-Allow-Headers': 'X-Channels-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  const apiKey = req.headers.get('X-Channels-Key');

  if (!env.CHANNELS_API_KEY || apiKey !== env.CHANNELS_API_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  if (!env.META_WABA_TOKEN) {
    return new Response(JSON.stringify({ error: 'Meta token is not configured' }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  try {
    const incoming = await req.formData();

    const file = incoming.get('file');
    const type = incoming.get('type');
    const phoneId = incoming.get('phone_id');

    if (!file || !phoneId) {
      return new Response(
        JSON.stringify({ error: 'file and phone_id are required' }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const metaForm = new FormData();
    metaForm.append('messaging_product', 'whatsapp');
    metaForm.append('file', file, file.name || 'upload');

    if (type) {
      metaForm.append('type', type);
    }

    const metaResponse = await fetch(
      `https://graph.facebook.com/v23.0/${encodeURIComponent(phoneId)}/media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.META_WABA_TOKEN}`,
        },
        body: metaForm,
      }
    );

    const responseText = await metaResponse.text();

    return new Response(responseText, {
      status: metaResponse.status,
      headers: {
        ...corsHeaders,
        'Content-Type':
          metaResponse.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message || 'Meta media upload failed' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

async function handleSupabaseStorageUpload(req, env) {

  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Access-Control-Allow-Headers': 'X-Channels-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const apiKey = req.headers.get('X-Channels-Key');

  if (!env.CHANNELS_API_KEY || apiKey !== env.CHANNELS_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ error: 'Supabase is not configured' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  try {

    const incoming = await req.formData();

    const file = incoming.get('file');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return new Response(
        JSON.stringify({ error: 'file is required' }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const originalName =
      String(file.name || 'upload')
        .replace(/[^a-zA-Z0-9._-]/g, '_');

    const storageKey =
      `${Date.now()}_${crypto.randomUUID()}_${originalName}`;

    const baseUrl =
      String(env.SUPABASE_URL).replace(/\/$/, '');

    const encodedPath = storageKey
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const uploadUrl =
      `${baseUrl}/storage/v1/object/whatsapp-media/${encodedPath}`;

    const fileBuffer = await file.arrayBuffer();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: fileBuffer,
    });

    const responseText = await uploadResponse.text();

    if (!uploadResponse.ok) {
      console.error(
        '[Worker] Supabase storage upload failed:',
        uploadResponse.status,
        responseText
      );

      return new Response(
        JSON.stringify({
          error: 'Supabase storage upload failed',
          status: uploadResponse.status,
        }),
        {
          status: uploadResponse.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const publicUrl =
      `${baseUrl}/storage/v1/object/public/whatsapp-media/${encodedPath}`;

    return new Response(
      JSON.stringify({
        ok: true,
        path: storageKey,
        public_url: publicUrl,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );

  } catch (e) {

    console.error(
      '[Worker] Supabase storage upload error:',
      e.message
    );

    return new Response(
      JSON.stringify({
        error: e.message || 'Supabase storage upload failed',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

async function handleSupabaseMessageInsert(req, env) {

  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const apiKey = req.headers.get('X-Channels-Key');

  if (!env.CHANNELS_API_KEY || apiKey !== env.CHANNELS_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ error: 'Supabase is not configured' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  let body;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (!body.phone || !body.conversation_id || !body.media_url || !body.media_type) {
    return new Response(
      JSON.stringify({
        error: 'phone, conversation_id, media_url and media_type are required'
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const allowedMediaTypes = ['image', 'document'];

  if (!allowedMediaTypes.includes(body.media_type)) {
    return new Response(
      JSON.stringify({ error: 'Invalid media_type' }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const row = {
    phone: String(body.phone),
    message:
      body.message == null
        ? ''
        : String(body.message),
    sender: 'outgoing',
    sender_type: 'human',
    conversation_id: String(body.conversation_id),
    media_url: String(body.media_url),
    media_type: body.media_type,
    created_at_sgt:
      body.created_at_sgt == null
        ? null
        : String(body.created_at_sgt),
    agent_name:
      body.agent_name == null || body.agent_name === ''
        ? null
        : String(body.agent_name),
  };

  try {

    const baseUrl =
      String(env.SUPABASE_URL).replace(/\/$/, '');

    const supabaseResponse = await fetch(
      `${baseUrl}/rest/v1/messages`,
      {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(row),
      }
    );

    const responseText =
      await supabaseResponse.text();

    if (!supabaseResponse.ok) {

      console.error(
        '[Worker] Supabase message insert failed:',
        supabaseResponse.status,
        responseText
      );

      return new Response(
        JSON.stringify({
          error: 'Supabase message insert failed',
          status: supabaseResponse.status,
        }),
        {
          status: supabaseResponse.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    let inserted = null;

    try {
      inserted = JSON.parse(responseText);
    } catch {}

    return new Response(
      JSON.stringify({
        ok: true,
        message: Array.isArray(inserted)
          ? inserted[0] || null
          : inserted,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );

  } catch (e) {

    console.error(
      '[Worker] Supabase message insert error:',
      e.message
    );

    return new Response(
      JSON.stringify({
        error:
          e.message ||
          'Supabase message insert failed',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

async function handleSupabaseTemplateSendInsert(req, env) {

  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const apiKey = req.headers.get('X-Channels-Key');

  if (!env.CHANNELS_API_KEY || apiKey !== env.CHANNELS_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ error: 'Supabase is not configured' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  let body;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (!body.phone || !body.template_name) {
    return new Response(
      JSON.stringify({
        error: 'phone and template_name are required'
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const allowedStatuses = ['sent', 'failed'];

  if (!allowedStatuses.includes(body.status)) {
    return new Response(
      JSON.stringify({ error: 'Invalid status' }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const row = {
    phone: String(body.phone),
    template_name: String(body.template_name),
    broadcast_id:
      body.broadcast_id == null
        ? null
        : String(body.broadcast_id),
    wamid:
      body.wamid == null || body.wamid === ''
        ? null
        : String(body.wamid),
    status: body.status,
    sent_at:
      body.sent_at
        ? String(body.sent_at)
        : new Date().toISOString(),
  };

  try {

    const baseUrl =
      String(env.SUPABASE_URL).replace(/\/$/, '');

    const supabaseResponse = await fetch(
      `${baseUrl}/rest/v1/template_sends`,
      {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(row),
      }
    );

    const responseText =
      await supabaseResponse.text();

    if (!supabaseResponse.ok) {

      console.error(
        '[Worker] template_sends insert failed:',
        supabaseResponse.status,
        responseText
      );

      return new Response(
        JSON.stringify({
          error: 'Template send logging failed',
          status: supabaseResponse.status,
        }),
        {
          status: supabaseResponse.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    let inserted = null;

    try {
      inserted = JSON.parse(responseText);
    } catch {}

    return new Response(
      JSON.stringify({
        ok: true,
        template_send:
          Array.isArray(inserted)
            ? inserted[0] || null
            : inserted,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );

  } catch (e) {

    console.error(
      '[Worker] template_sends insert error:',
      e.message
    );

    return new Response(
      JSON.stringify({
        error:
          e.message ||
          'Template send logging failed',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
