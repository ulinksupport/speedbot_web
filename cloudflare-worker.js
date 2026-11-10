
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
// Pages Ulink runs in production. Any OTHER Page connected through the dashboard is a
// Meta App Review reviewer's own test Page: it is flagged is_review (reviewer login can
// see its conversations) and its chats are purged when it is disconnected.
const PRODUCTION_PAGE_IDS = ['770139519793130', '1296573596876623'];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the Facebook consent screen

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(retryInbox(env));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const corsOrigin = getCorsOrigin(req);

    // Dashboard login (server-verified). Admin -> {role:'admin'}; reviewer ->
    // {role:'reviewer', token: <short-lived Supabase JWT>} for Meta App Review.
    if (url.pathname.startsWith('/n8n/')) {
      return handleN8nProxy(req, env, url, corsOrigin);
    }
    if (url.pathname === '/ig-thread') {
      return handleThread(req, env, url, corsOrigin);
    }
    if (url.pathname === '/auth/login') {
      return handleAuthLogin(req, env, corsOrigin);
    }

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
      if (!(await isAuthorized(req, env))) {
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

    const rawBody = await req.text();
    const sigBy = await verifyMetaSignature(rawBody, req.headers.get('X-Hub-Signature-256'), env);
    const sigOk = !!sigBy;
    if (!sigOk) {
      console.error('[Worker] INVALID webhook signature (mode=' + SIGNATURE_MODE + ')');
      ctx.waitUntil(recordRejected(rawBody, req.headers.get('X-Hub-Signature-256'), env));
      if (SIGNATURE_MODE === 'enforce') return new Response('Invalid signature', { status: 403 });
    }
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response('ok', { status: 200 }); // malformed — ignore
    }

    // DEBUG: log full payload for every POST

    // Respond 200 immediately, process in the background
    ctx.waitUntil(routeWebhook(body, Object.assign(Object.create(env), { __sigOk: sigOk, __sigBy: sigBy })));

    return new Response('ok', { status: 200 });
  },
};

async function routeWebhook(body, env) {
  const object = body?.object;
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  console.log('[Worker] object:', object, '| entries:', entries.length);
  if (!entries.length) return;
  const jobs = [];
  if (object === 'whatsapp_business_account') {
    for (const entry of entries) {
      for (const change of (entry?.changes || [])) {
        jobs.push(handleWhatsApp({ ...entry, changes: [change] }, env));
      }
    }
  } else if (object === 'page' || object === 'instagram') {
    for (const entry of entries) {
      for (const m of (entry?.messaging || [])) {
        const single = { ...entry, messaging: [m] };
        jobs.push(handleMeta({ ...body, entry: [single] }, single, env));
      }
    }
  } else {
    console.log('[Worker] Unhandled object type:', object);
  }
  await Promise.allSettled(jobs);
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
  '1286180077917309',
  '1378048008729327'  // SG pre-appointment number +65 8867 7725 (WABA 1703106731243453, app 1511392627710051) added 2026-11-06
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
    // One delivery per message so a batch never drops everything after the first message.
    for (const m of value.messages) {
      const single = { ...value, messages: [m] };
      const forwardBody = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: single }] }] };
      tasks.push(deliverToN8n('whatsapp', env.WHATSAPP_N8N_URL, forwardBody, env));
    }
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

  // Ad-click referral that arrives on its own (no message attached). Logged so it can be
  // inspected; ad clicks that come WITH a message are forwarded to n8n below.
  if (messaging.referral && !messaging.message) {
    console.log('[Worker] REFERRAL event (standalone):', JSON.stringify(messaging).slice(0, 1500));
    // Save it onto the customer's latest message instead of dropping it. Waits (up to ~20s) for
    // that message's row in case the referral beat the message itself to us.
    const sid = messaging.sender?.id;
    if (sid) {
      await attachReferralToMessage((body?.object === 'instagram' ? 'ig_' : 'fb_') + sid, '',
        messaging.referral, env, { sinceMs: (messaging.timestamp || Date.now()) - 5000 });
    }
    return;
  }
  // Real inbound messages → forward whole body to n8n unchanged
  // (matches `Normalize Meta Message`'s `$json.body.entry[0].messaging[0]` /
  // `$json.body.object` parsing — n8n's Webhook node wraps our raw POST as `$json.body`)
  if (messaging.message) {
    if (messaging.message.referral || messaging.referral) console.log('[Worker] message carries REFERRAL:', JSON.stringify(messaging.message.referral || messaging.referral).slice(0, 1500));
    // Meta can deliver the same event more than once (seen ~80ms apart), and each
    // copy made n8n send its own reply. Claim the message id first; only the
    // first delivery goes on to n8n.
    if (await isDuplicateMetaMessage(messaging.message.mid, env)) {
      console.log('[Worker] Duplicate Meta delivery ignored, mid:', messaging.message.mid);
      // Meta sometimes sends two copies ~70ms apart and only ONE carries the ad referral. If the
      // copy we kept had none, the ad details were lost. So when the ignored copy has a referral,
      // attach it to the message row the first copy creates.
      const dupRef = messaging.message.referral || messaging.referral;
      if (dupRef && messaging.sender?.id) {
        await attachReferralToMessage((body?.object === 'instagram' ? 'ig_' : 'fb_') + messaging.sender.id,
          messaging.message.text || '', dupRef, env, { sinceMs: (messaging.timestamp || Date.now()) - 5000 });
      }
      return;
    }
    // Messenger sometimes delivers a burst of the SAME text under different mids a few ms apart (e.g.
    // tapping the ad's prefilled button; seen 6x within ~1.3s, 4 of them with identical Meta timestamps).
    // Different mids so the mid check above can't catch it. Drop a message ONLY if its text is
    // character-for-character identical (no trimming, no case folding) to one this sender sent within
    // the last 5s. The first one through wins; text-only (never drops anything carrying a file/image/
    // sticker). If a dropped copy carries the ad referral, attach it to the kept message instead.
    {
      const rsid = messaging.sender?.id;
      const rtext = messaging.message.text || '';
      if (rsid && !messaging.message.is_echo && rtext !== '' && !messaging.message.attachments?.length) {
        const dg = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rtext));
        const hash = [...new Uint8Array(dg)].map(b => b.toString(16).padStart(2, '0')).join('');   // full digest: exact match
        if (!(await claimMetaWindow(`txt:${rsid}:${hash}`, 5, env))) {
          console.log('[Worker] Identical text within 5s ignored, mid:', messaging.message.mid);
          const rRef = messaging.message.referral || messaging.referral;
          if (rRef) {
            await attachReferralToMessage((body?.object === 'instagram' ? 'ig_' : 'fb_') + rsid,
              rtext, rRef, env, { sinceMs: (messaging.timestamp || Date.now()) - 5000 });
          }
          return;
        }
      }
    }
    // A new customer can send two DIFFERENT messages within a second (e.g. both
    // ad buttons). n8n would then run twice at once, both runs see "no
    // conversation yet" and both send the first auto-reply. So when this sender
    // already messaged in the last 30s, hold this one until the first run has
    // created the conversation — n8n then takes the existing-chat path.
    const senderId = messaging.sender?.id;
    if (senderId && !messaging.message.is_echo) {
      const contactKey = (body?.object === 'instagram' ? 'ig_' : 'fb_') + senderId;
      if (!(await claimMetaWindow('psid:' + senderId, 30, env))) {
        await waitForConversation(contactKey, env);
      }
    }
    // Messenger/Instagram can pack several photos/files into ONE event, but n8n handles one attachment per
    // run. Fan out one delivery per attachment (text only on the first) so none is dropped.
    const atts = messaging.message.attachments;
    if (Array.isArray(atts) && atts.length > 1) {
      // Sequential on purpose: for a brand-new customer the first run creates the conversation, and the
      // later ones must wait for it (otherwise each would create its own duplicate conversation).
      let okAll = true;
      for (let i = 0; i < atts.length; i++) {
        const m = { ...messaging, message: { ...messaging.message, attachments: [atts[i]], mid: (messaging.message.mid || 'x') + '#' + i } };
        if (i > 0) delete m.message.text;
        okAll = (await deliverToN8n('meta', env.META_N8N_URL, { ...body, entry: [{ ...entry, messaging: [m] }] }, env)) && okAll;
        if (i < atts.length - 1 && messaging.sender?.id) {
          await waitForConversation((body?.object === 'instagram' ? 'ig_' : 'fb_') + messaging.sender.id, env);
        }
      }
      return okAll;
    }
    return deliverToN8n('meta', env.META_N8N_URL, body, env);
  }

  // Postbacks / other event types — ignore for now
}

// Same reshaping the n8n "Normalize Meta Message2" node applies, so the dashboard's Ad Click card
// reads source_url / headline / body / image_url whichever path saved the referral.
function shapeMetaReferral(rawRef) {
  const adsCtx = rawRef?.ads_context_data || {};
  return {
    source_type: rawRef.source || 'ADS',
    source_id:   rawRef.ad_id || null,
    ad_id:       rawRef.ad_id || null,
    ref:         rawRef.ref || null,
    headline:    adsCtx.ad_title || null,
    body:        rawRef.ref ? `ref: ${rawRef.ref}` : null,
    image_url:   adsCtx.photo_url || null,
    source_url:  rawRef.source_url || adsCtx.ad_link || adsCtx.photo_url || adsCtx.video_url || null,
    raw:         rawRef,
  };
}
// Writes an ad referral onto the customer's incoming message row (messages.referral). Polls for up to
// ~20s because the row is created by n8n a moment AFTER the worker sees the webhook. Does nothing if
// a matching message in the window already has a referral. Never throws: a failure here must not
// affect message handling.
async function attachReferralToMessage(contactKey, text, rawRef, env, opts = {}) {
  try {
    const headers = {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
    };
    // Only rows created at/after THIS message's own Meta timestamp (minus a little clock skew), so an
    // earlier message with the same text can never be picked. created_at is UTC with no tz.
    const since = new Date(opts.sinceMs || (Date.now() - 2 * 60 * 1000)).toISOString().slice(0, 19);
    const url = `${env.SUPABASE_URL}/rest/v1/messages`
      + `?phone=eq.${encodeURIComponent(contactKey)}&sender=eq.incoming&created_at=gte.${since}`
      + `&select=id,message,referral&order=created_at.asc&limit=50`;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) { console.error('[Worker] attachReferral lookup failed:', res.status); return; }
      const rows = (await res.json()).filter(r => !text || r.message === text);
      if (rows.length) {
        if (rows[0].referral) return;                           // already saved by the first copy
        const patch = await fetch(`${env.SUPABASE_URL}/rest/v1/messages?id=eq.${rows[0].id}&referral=is.null`, {
          method:  'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body:    JSON.stringify({ referral: shapeMetaReferral(rawRef) }),
          signal:  AbortSignal.timeout(4000),
        });
        console.log('[Worker] attached referral to message', rows[0].id, 'status', patch.status);
        return;
      }
      await new Promise(r => setTimeout(r, 750));
    }
    console.log('[Worker] attachReferral: no message row found for', contactKey);
  } catch (e) {
    console.error('[Worker] attachReferral error:', e.message);
  }
}
// Atomically claims a Messenger/Instagram message id in Supabase
// (meta_event_dedupe, primary key = mid). Returns true only when the id was
// already claimed. Fails OPEN: any error means "not a duplicate", so a
// Supabase hiccup can never swallow a real customer message.
async function isDuplicateMetaMessage(mid, env) {
  if (!mid) return false;
  try {
    const headers = {
      'apikey':        env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
    };
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/meta_event_dedupe?on_conflict=mid`, {
      method:  'POST',
      headers: { ...headers, 'Prefer': 'resolution=ignore-duplicates,return=representation' },
      body:    JSON.stringify({ mid }),
    });
    if (!res.ok) {
      console.error(`[Worker] dedupe claim failed (${res.status}) — processing anyway`);
      return false;
    }
    const claimed = await res.json();
    // Occasional housekeeping: ids only matter for seconds, keep a day.
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      fetch(`${env.SUPABASE_URL}/rest/v1/meta_event_dedupe?created_at=lt.${encodeURIComponent(cutoff)}`, {
        method: 'DELETE', headers,
      }).catch(() => {});
    }
    return Array.isArray(claimed) && claimed.length === 0;
  } catch (e) {
    console.error('[Worker] dedupe check error — processing anyway:', e.message);
    return false;
  }
}

// True when `key` had no claim in the last `windowSecs` seconds (atomic, via the
// claim_meta_window SQL function). Fails open: on any error returns true so the
// message is forwarded immediately.
async function claimMetaWindow(key, windowSecs, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_meta_window`, {
      method:  'POST',
      headers: {
        'apikey':        env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ p_key: key, p_window_s: windowSecs }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return true;
    return (await res.json()) !== false;
  } catch (e) {
    console.error('[Worker] window claim error — forwarding anyway:', e.message);
    return true;
  }
}

// Polls (hard cap 12s, 3s per request) until a conversation exists for this contact. Never throws;
// on timeout or error it just returns and the message is forwarded anyway.
async function waitForConversation(contactKey, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/conversations`
            + `?contact_key=eq.${encodeURIComponent(contactKey)}&select=id&limit=1`;
  const headers = { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` };
  try {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length) return;
      await new Promise(r => setTimeout(r, 750));
    }
    console.log('[Worker] waitForConversation timed out for', contactKey);
  } catch (e) {
    console.error('[Worker] waitForConversation error:', e.message);
  }
}

async function handleMetaReceipt(messaging, env) {
  const senderId  = messaging.sender?.id;
  if (!senderId) return;

  const isRead     = !!messaging.read;
  // Messenger sends read.watermark / delivery.watermark. Instagram's messaging_seen
  // event has no watermark - only read.mid plus the event's own `timestamp` - so fall
  // back to that (everything we sent before the customer opened the thread is read).
  const watermarkMs = Number(
    messaging.read?.watermark ?? messaging.delivery?.watermark ?? messaging.timestamp
  );
  if (!watermarkMs) return;

  // Dashboard saves each outgoing message's created_at ~0.5s AFTER Meta accepts
  // it, so a strict <= watermark compare misses the newest message by one event.
  const watermarkIso = new Date(watermarkMs + 5000).toISOString();
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
    + `?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,messaging_referrals`
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
    is_review:                !PRODUCTION_PAGE_IDS.includes(String(page.id)),
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
    + `?select=page_id,page_name,ig_business_account_id,ig_username,webhook_subscribed,is_review,connected_at&order=connected_at.desc`;
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
    `${env.SUPABASE_URL}/rest/v1/channel_connections?page_id=eq.${encodeURIComponent(pageId)}&select=id,page_access_token,is_review,ig_business_account_id&limit=1`,
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
        // A token Meta itself calls invalid/expired/revoked (OAuthException 190/102, e.g. after the app
        // was replaced or the user's session was invalidated) can never unsubscribe anything, so retrying
        // would fail forever and the row could never be removed. Treat that case as "already
        // disconnected" and delete the row; every other failure still keeps the row for a retry.
        const e = unsubData?.error || {};
        const tokenDead = e.code === 190 || e.code === 102
          || /session has been invalidated|error validating access token|has expired|invalid oauth access token/i.test(e.message || '');
        if (!tokenDead) {
          console.error(`[Worker] unsubscribe failed for page ${pageId}: ${unsubRes.status} — ${JSON.stringify(unsubData)}`);
          return new Response(JSON.stringify({ ok: false, error: 'Could not confirm Meta unsubscribe — try again.' }), {
            status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
          });
        }
        console.warn(`[Worker] disconnect page ${pageId}: stored token is dead (${e.code}) — removing the row without a Meta unsubscribe.`);
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

  if (row.is_review) {
    try { await purgeReviewConversations(pageId, row.ig_business_account_id, env); }
    catch (e) { console.error('[Worker] review chat purge failed:', e.message); }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN },
  });
}

// Removes every conversation (and its messages/comments) that belongs to a
// reviewer-connected Page. Only ever called for is_review connections.
async function purgeReviewConversations(pageId, igId, env) {
  const h = { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` };
  const ids = [pageId, igId].filter(Boolean).map(encodeURIComponent).join(',');
  const convRes = await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?meta_recipient_id=in.(${ids})&select=id`, { headers: h });
  if (!convRes.ok) throw new Error(`conversation lookup ${convRes.status}`);
  const convIds = (await convRes.json()).map(r => r.id);
  if (!convIds.length) return;
  const list = convIds.join(',');
  for (const [table, col] of [['messages', 'conversation_id'], ['conversation_comments', 'conversation_id'], ['conversations', 'id']]) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${col}=in.(${list})`, { method: 'DELETE', headers: h });
    if (!r.ok) throw new Error(`delete ${table} ${r.status}`);
  }
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

  if (!(await isAuthorized(req, env))) {
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
    Authorization: `Bearer ${pickWabaToken(env, path)}`,
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

  if (!(await isAuthorized(req, env))) {
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
          Authorization: `Bearer ${pickWabaToken(env, phoneId)}`,
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

  if (!(await isAuthorized(req, env))) {
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

  if (!(await isAuthorized(req, env))) {
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

  if (!(await isAuthorized(req, env))) {
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


// ── Dashboard login + reviewer JWT ───────────────────────────────────────────
//  Secrets: ADMIN_PASSWORD, REVIEWER_PASSWORD, SUPABASE_JWT_SECRET (Supabase →
//  Settings → API → JWT Secret). The reviewer JWT is signed with the project's
//  JWT secret so PostgREST/Realtime accept it; RLS policies key on
//  auth.jwt()->>'app_role' = 'reviewer' (see supabase-reviewer-rls.sql).
const REVIEWER_TOKEN_TTL_S = 8 * 3600;
const REVIEWER_SUB = '00000000-0000-0000-0000-00000000ee01';

function b64url(bytes) {
  let str = '';
  for (const b of new Uint8Array(bytes)) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwtHS256(payload, secret) {
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

async function safeEqual(a, b) {
  // Compare SHA-256 digests so length/timing do not leak the secret.
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function handleAuthLogin(req, env, corsOrigin) {
  const cors = {
    'Access-Control-Allow-Origin':  corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const reply = (status, obj) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  let password;
  try { password = (await req.json())?.password; } catch { return reply(400, { error: 'Bad request' }); }
  if (typeof password !== 'string' || !password) return reply(401, { error: 'Invalid password' });

  if (env.ADMIN_PASSWORD && await safeEqual(password, env.ADMIN_PASSWORD)) {
    return reply(200, { role: 'admin', session: await signSession(env, 'admin'), supabase_key: env.SUPABASE_KEY || null });
  }
  if (env.REVIEWER_PASSWORD && env.SUPABASE_JWT_SECRET && await safeEqual(password, env.REVIEWER_PASSWORD)) {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwtHS256({
      aud: 'authenticated', role: 'authenticated', sub: REVIEWER_SUB,
      app_role: 'reviewer', iat: now, exp: now + REVIEWER_TOKEN_TTL_S,
    }, env.SUPABASE_JWT_SECRET);
    return reply(200, { role: 'reviewer', token, expires_in: REVIEWER_TOKEN_TTL_S, session: await signSession(env, 'reviewer') });
  }
  return reply(401, { error: 'Invalid password' });
}
// Two WhatsApp Business accounts live behind this Worker: the Indonesian (ID) one uses
// META_WABA_TOKEN, the Singapore pre-appointment one uses META_WABA_TOKEN_SG. Pick by the
// SG WABA id / SG phone_number_id appearing in the Graph path or phone_id; default = ID.
function pickWabaToken(env, hint) {
  const h = String(hint || '');
  if (env.META_WABA_TOKEN_SG && (h.includes('1703106731243453') || h.includes('1378048008729327'))) return env.META_WABA_TOKEN_SG;
  return env.META_WABA_TOKEN;
}

// ═══════════════════════════════════════════════════════════════════════
// Security + reliability additions (2026-11-06)
// ═══════════════════════════════════════════════════════════════════════

// --- Webhook signature (X-Hub-Signature-256) ---------------------------
// Two Meta apps feed this Worker (Medical Tourism Indonesia + Pre-appointment),
// each signs with its own app secret. 'log' = record bad signatures but still
// process; 'enforce' = reject with 403 (rejected bodies are kept in webhook_inbox).
const SIGNATURE_MODE = 'log';
// During rollout the old shared key in index.html is still accepted. Final deploy sets this false.
const ALLOW_STATIC_KEY = false;

async function verifyMetaSignature(raw, header, env) {
  const named = [['907', env.META_APP_SECRET], ['sg1511', env.META_APP_SECRET_SG]].filter(x => x[1]);
  if (!named.length) return 'unconfigured'; // verification not configured
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!m) return null;
  for (const [label, secret] of named) {
    const expected = (await hmacHex(secret, raw)).toLowerCase();
    if (timingSafeEqual(expected, m[1].toLowerCase())) return label;
  }
  return null;
}

async function recordRejected(raw, header, env) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_inbox`, {
      method: 'POST', headers: sbInboxHeaders(env),
      body: JSON.stringify({ kind: 'rejected', status: 'rejected', sig_ok: false,
        payload: { sig_header: header || null, body_prefix: String(raw).slice(0, 3000) } }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) { console.error('[Worker] recordRejected failed:', e.message); }
}

// --- Dashboard session tokens (replace the old static key) -------------
const SESSION_TTL_S = 12 * 3600;

function b64urlText(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signSession(env, role) {
  if (!env.SESSION_SECRET) return null;
  const payload = b64urlText(JSON.stringify({ r: role, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }));
  return payload + '.' + (await hmacHex(env.SESSION_SECRET, payload));
}

async function verifySession(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = await hmacHex(env.SESSION_SECRET, parts[0]);
  if (!timingSafeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch (e) { return null; }
}


// --- Full platform thread (mirror of the real Instagram / Messenger DM) ---
// Our own DB only stores customer messages + replies sent through this system. Instagram's
// built-in automation (welcome message, FAQ/ice-breakers, away messages) and anything sent from
// the IG app are never stored. This asks Meta for the real conversation so the dashboard can
// show exactly what the customer sees. Read-only; uses the stored Page token server-side.
async function handleThread(req, env, url, corsOrigin) {
  const cors = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
    'Vary': 'Origin',
  };
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!(await isAuthorized(req, env))) return json(401, { error: 'Unauthorized' });
  const convId = (url.searchParams.get('conversation_id') || '').trim();
  if (!/^\d+$/.test(convId)) return json(400, { error: 'conversation_id required' });
  const sb = { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` };

  const cr = await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?id=eq.${convId}&select=platform,meta_psid,meta_recipient_id,name&limit=1`, { headers: sb });
  if (!cr.ok) return json(502, { error: 'Could not load conversation' });
  const [conv] = await cr.json();
  if (!conv) return json(404, { error: 'Conversation not found' });
  const platform = conv.platform;
  if ((platform !== 'instagram' && platform !== 'facebook' && platform !== 'messenger') || !conv.meta_psid) {
    return json(400, { error: 'Not an Instagram/Messenger conversation' });
  }
  const isIg = platform === 'instagram';

  const col = isIg ? 'ig_business_account_id' : 'page_id';
  let rows = [];
  if (conv.meta_recipient_id) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/channel_connections?${col}=eq.${encodeURIComponent(conv.meta_recipient_id)}&select=page_id,page_name,ig_business_account_id,ig_username,page_access_token&limit=1`, { headers: sb });
    if (r.ok) rows = await r.json();
  }
  if (!rows.length) return json(404, { error: 'No connected Page/IG account found for this conversation' });
  const ch = rows[0];

  const fields = 'id,created_time,from,to,message,attachments,shares,reactions,story,sticker,is_unsupported';
  const first = `https://graph.facebook.com/${GRAPH_VERSION}/${ch.page_id}/conversations`
    + `?platform=${isIg ? 'instagram' : 'messenger'}&user_id=${encodeURIComponent(conv.meta_psid)}`
    + `&fields=id,updated_time,messages.limit(100){${fields}}&access_token=${encodeURIComponent(ch.page_access_token)}`;
  let res;
  try { res = await fetch(first); } catch (e) { return json(502, { error: 'Meta unreachable: ' + e.message }); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (body.error && body.error.message) || 'Meta error ' + res.status });
  const convo = (body.data || [])[0];
  if (!convo) return json(200, { ok: true, found: false, messages: [], business_id: isIg ? ch.ig_business_account_id : ch.page_id, business_name: isIg ? ch.ig_username : ch.page_name });

  let raw = (convo.messages && convo.messages.data) || [];
  let next = convo.messages && convo.messages.paging && convo.messages.paging.next;
  for (let i = 0; next && i < 9; i++) {
    const pr = await fetch(next); if (!pr.ok) break;
    const pj = await pr.json();
    raw = raw.concat(pj.data || []);
    next = pj.paging && pj.paging.next;
  }
  const businessId = isIg ? ch.ig_business_account_id : ch.page_id;
  const out = raw.slice().reverse().map(m => {
    const atts = [];
    const ad = (m.attachments && m.attachments.data) || [];
    for (const a of ad) {
      atts.push({
        type: (a.image_data && 'image') || (a.video_data && 'video') || (a.mime_type ? a.mime_type.split('/')[0] : 'file'),
        url: (a.image_data && a.image_data.url) || (a.video_data && a.video_data.url) || a.file_url || null,
        name: a.name || null, mime: a.mime_type || null,
      });
    }
    const shares = ((m.shares && m.shares.data) || []).map(x => ({ link: x.link || null, name: x.name || null }));
    return {
      id: m.id, created_time: m.created_time,
      from_id: m.from && m.from.id, from_name: m.from && (m.from.username || m.from.name) || null,
      is_page: !!(m.from && m.from.id === businessId),
      text: m.message || '', attachments: atts, shares,
      sticker: m.sticker || null, story: m.story || null,
      reactions: m.reactions || null, is_unsupported: !!m.is_unsupported,
    };
  }).sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  return json(200, {
    ok: true, found: true, platform: isIg ? 'instagram' : 'messenger',
    business_id: businessId, business_name: isIg ? ch.ig_username : ch.page_name,
    customer_name: conv.name, count: out.length, truncated: !!next, messages: out,
  });
}

async function isAuthorized(req, env) {
  const tok = req.headers.get('X-Channels-Key') || '';
  if (await verifySession(tok, env)) return true;
  return ALLOW_STATIC_KEY && !!env.CHANNELS_API_KEY && tok === env.CHANNELS_API_KEY;
}

// --- Authenticated proxy to the n8n webhooks the dashboard uses --------
// The browser can no longer call n8n directly: n8n requires X-Internal-Key,
// which only this Worker knows.
const N8N_PROXY_PATHS = new Set([
  'backup-chats', 'dashboard-outgoing-media-backup', 'export-chat',
  'human-send-message', 'selected-chat-backup', 'send-template-message',
]);

async function handleN8nProxy(req, env, url, corsOrigin) {
  const cors = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Channels-Key',
    'Vary': 'Origin',
  };
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!(await isAuthorized(req, env))) return json(401, { error: 'Unauthorized' });
  const p = url.pathname.slice('/n8n/'.length).replace(/^\/+/, '');
  if (!N8N_PROXY_PATHS.has(p)) return json(404, { error: 'Unknown endpoint' });
  const headers = new Headers({ 'Content-Type': req.headers.get('Content-Type') || 'application/json' });
  if (env.N8N_INTERNAL_KEY) headers.set('X-Internal-Key', env.N8N_INTERNAL_KEY);
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  let res;
  try {
    res = await fetch(new URL(env.WHATSAPP_N8N_URL).origin + '/webhook/' + p + url.search, init);
  } catch (e) {
    return json(502, { error: 'n8n unreachable: ' + e.message });
  }
  const out = new Headers(cors);
  out.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
  return new Response(res.body, { status: res.status, headers: out });
}

// --- Durable inbox: nothing accepted from Meta is lost if n8n is down ---
function sbInboxHeaders(env, extra) {
  return { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function postToN8n(url, bodyObj, env) {
  const headers = { 'Content-Type': 'application/json' };
  if (env.N8N_INTERNAL_KEY) headers['X-Internal-Key'] = env.N8N_INTERNAL_KEY;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// 1) save the event, 2) try n8n, 3) mark delivered. If step 2 fails the row stays
// 'pending' and the cron (retryInbox) keeps re-sending it until n8n accepts it.
async function deliverToN8n(kind, targetUrl, bodyObj, env) {
  let rowId = null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_inbox`, {
      method: 'POST', headers: sbInboxHeaders(env, { 'Prefer': 'return=representation' }),
      body: JSON.stringify({ kind, payload: bodyObj, status: 'pending', sig_ok: env.__sigOk !== false, sig_by: env.__sigBy || null }),
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) rowId = (await r.json())?.[0]?.id ?? null;
    else console.error('[Worker] inbox insert failed', r.status);
  } catch (e) { console.error('[Worker] inbox insert error:', e.message); }
  const result = await postToN8n(targetUrl, bodyObj, env);
  if (!result.ok) console.error('[Worker] n8n forward failed (' + kind + '):', result.err, rowId ? '— queued for retry, inbox id ' + rowId : '— NOT QUEUED (inbox insert failed)');
  if (rowId != null) {
    const now = new Date().toISOString();
    await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_inbox?id=eq.${rowId}`, {
      method: 'PATCH', headers: sbInboxHeaders(env),
      body: JSON.stringify(result.ok
        ? { status: 'delivered', attempts: 1, last_attempt_at: now, delivered_at: now }
        : { attempts: 1, last_attempt_at: now, last_error: result.err }),
    }).catch(e => console.error('[Worker] inbox patch failed:', e.message));
  }
  return result.ok;
}

async function retryInbox(env) {
  const base = `${env.SUPABASE_URL}/rest/v1/webhook_inbox`;
  const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
  try {
    const res = await fetch(`${base}?status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&order=id.asc&limit=50`, { headers: sbInboxHeaders(env) });
    const rows = res.ok ? await res.json() : [];
    for (const row of rows) {
      const url = row.kind === 'meta' ? env.META_N8N_URL : env.WHATSAPP_N8N_URL;
      const result = await postToN8n(url, row.payload, env);
      const now = new Date().toISOString();
      await fetch(`${base}?id=eq.${row.id}&status=eq.pending`, {
        method: 'PATCH', headers: sbInboxHeaders(env),
        body: JSON.stringify(result.ok
          ? { status: 'delivered', attempts: row.attempts + 1, last_attempt_at: now, delivered_at: now }
          : { attempts: row.attempts + 1, last_attempt_at: now, last_error: result.err }),
      });
      if (!result.ok) break; // n8n still down — stop hammering, try again next tick
    }
    const day = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
    await Promise.allSettled([
      fetch(`${base}?status=eq.delivered&created_at=lt.${encodeURIComponent(day(2))}`, { method: 'DELETE', headers: sbInboxHeaders(env) }),
      fetch(`${base}?status=eq.rejected&created_at=lt.${encodeURIComponent(day(3))}`, { method: 'DELETE', headers: sbInboxHeaders(env) }),
      fetch(`${base}?status=eq.pending&created_at=lt.${encodeURIComponent(day(7))}`, { method: 'PATCH', headers: sbInboxHeaders(env), body: JSON.stringify({ status: 'expired' }) }),
    ]);
  } catch (e) { console.error('[Worker] retryInbox error:', e.message); }
}
