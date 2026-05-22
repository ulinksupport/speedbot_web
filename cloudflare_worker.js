// ─────────────────────────────────────────────────────────────────────────────
//  Cloudflare Worker — Meta WhatsApp Webhook Router (Speedbot)
//
//  Handles ALL Meta webhook events:
//    GET  → webhook verification (hub.challenge)
//    POST statuses[]  → PATCH template_sends in Supabase directly (no n8n)
//    POST messages[]  → forward normalized value payload to n8n inbound webhook
//
//  Environment variables (Cloudflare dashboard → Workers → Settings):
//    VERIFY_TOKEN            — any string, must match Meta dashboard
//    SUPABASE_URL            — https://ehhynoowqlsgmcfyqofh.supabase.co
//    SUPABASE_KEY            — Supabase service role key
//    N8N_INBOUND_WEBHOOK_URL — n8n webhook URL (path: /webhook/whatsapp-agent-webhook)
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {

    // ── Webhook verification (GET from Meta during setup) ────────
    if (req.method === 'GET') {
      const url       = new URL(req.url);
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

    // Parse body — respond 200 immediately so Meta never retries
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response('ok', { status: 200 });
    }

    const value = body?.entry?.[0]?.changes?.[0]?.value;

    ctx.waitUntil(processWebhook(value, env));

    return new Response('ok', { status: 200 });
  },
};

async function processWebhook(value, env) {
  if (!value) return;

  const tasks = [];

  // ── Status receipts → patch Supabase directly, skip n8n ──────
  //    Handles: sent / delivered / read / failed
  if (Array.isArray(value.statuses) && value.statuses.length) {
    for (const status of value.statuses) {
      tasks.push(handleStatus(status, env));
    }
  }

  // ── Inbound user messages → forward value payload to n8n ─────
  //    Sends the `value` object so n8n expressions like
  //    $json.body.entry[0].changes[0].value.* still resolve correctly
  //    (n8n receives the full original body wrapped back in the same shape)
  if (Array.isArray(value.messages) && value.messages.length) {
    const wrappedBody = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value, field: 'messages' }] }]
    };
    tasks.push(
      fetch(env.N8N_INBOUND_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(wrappedBody),
      }).catch(e => console.error('[Speedbot Worker] n8n forward failed:', e.message))
    );
  }

  await Promise.allSettled(tasks);
}

async function handleStatus(status, env) {
  const { id, status: state, timestamp, errors } = status;
  if (!id) return;

  const now   = new Date(Number(timestamp) * 1000).toISOString();
  const patch = {};

  switch (state) {
    case 'sent':
      patch.status  = 'sent';
      // Don't overwrite sent_at — it was set by the frontend at send time
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
      patch.status          = 'failed';
      patch.failed_at       = now;
      patch.failure_code    = errors?.[0]?.code != null ? String(errors[0].code) : null;
      patch.failure_message = errors?.[0]?.title ?? null;
      break;

    default:
      return; // 'warning' and other events — ignore
  }

  // Trim trailing slash from SUPABASE_URL in case it's misconfigured
  const baseUrl = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const url = `${baseUrl}/rest/v1/template_sends?wamid=eq.${encodeURIComponent(id)}`;

  try {
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
      const body = await res.text();
      console.error(`[Speedbot Worker] Supabase PATCH failed wamid=${id} status=${state} http=${res.status} body=${body}`);
    } else {
      console.log(`[Speedbot Worker] Status updated wamid=${id} → ${state}`);
    }
  } catch (e) {
    console.error(`[Speedbot Worker] fetch error for wamid=${id}: ${e.message}`);
  }
}
