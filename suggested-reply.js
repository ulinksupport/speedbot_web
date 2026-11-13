/*
 * Suggested Reply – rules engine for the Medical Tourism dashboard (speedbot_web).
 *
 * Pure logic only: no DOM, no network, no Supabase calls. The dashboard passes in
 * the open conversation, its messages and the cached canned responses, and gets
 * back what to show in the "Suggested reply" bar. A human always clicks Send.
 *
 * Source of the rules: "Medical Tourism Workflow (Nov 2026)" deck, slides 6–9 and 11–13.
 *
 * Data shapes (from the live tables):
 *   conversation: { lang, name, opted_out, opted_out_at, is_spam, status, follow_up_stage }
 *   messages:     [{ sender: 'incoming'|'outgoing', sender_type: 'human'|'bot'|null, message, created_at }]
 *   canned:       [{ id, title, message, language: 'en'|'id', suggest_key, is_active, created_at }]
 */
(function (root) {
  'use strict';

  var CONFIG = {
    PDP_AS_PRIMARY: false,        // false = PDP consent offered as the first chip, not the main suggestion
    FOLLOW_UP_MIN_HOURS: 2,       // suggest follow-up only after this long with no customer reply
    WINDOW_HOURS: 24,             // deck: follow-up only within 24h of the customer's last message
    FINGERPRINT_CHARS: 40         // length of canned text used to recognise it was already sent
  };

  // Keys that make up the scripted sequence (main suggestions). Everything else is an "other option".
  var PRIMARY_KEYS = ['re_optin', 'clarify_intent', 'q1_health', 'ingin_q2_patient', 'check_db', 'contact_number', 'follow_up'];

  // Extra phrases that also count as "already sent", because ops reword the scripted questions.
  // Taken from outgoing human messages in the last 30 days.
  var KEY_ALIASES = {
    q1_health: ['masalah kesehatan', 'keluhan kesehatan', 'kondisi medis', 'health concern'],
    ingin_q2_patient: ['pasiennya adalah anda sendiri', 'patient is yourself'],
    check_db: ['di database kami', 'within database'],
    contact_number: ['menginformasikan nomor telepon', 'have your phone number'],
    pdp_consent: ['dengan melanjutkan ini', 'by proceeding, you consent'],
    re_optin: ['tidak berlangganan layanan pesan', 'previously opted out'],
    follow_up: ['ingin follow up', 'like to follow up'],
    clarify_intent: ['may i confirm whether you are', 'boleh kami konfirmasi, apakah']
  };

  var PREFIX_INGIN = 'saya ingin';
  var PREFIX_TERTARIK = 'saya tertarik';

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Same rule as the existing "Follow-up v3" n8n workflow: English only when lang says so, otherwise Indonesian.
  function pickLang(conversation) {
    var l = normalize(conversation && conversation.lang);
    return (l === 'en' || l === 'eng' || l === 'english') ? 'en' : 'id';
  }

  // messages.created_at is "timestamp without time zone" stored in UTC, so Supabase returns it with no
  // "Z" (e.g. "2026-11-13T01:40:50.38"). Browsers would read that as local time, so add the Z ourselves.
  function toTime(v) {
    if (typeof v === 'string') {
      var s = v.trim().replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
      v = s;
    }
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  function hasText(m) {
    return normalize(m && m.message).length > 0;
  }

  function startsWithPrefix(text) {
    var n = normalize(text).replace(/^[^a-z0-9]+/, '');
    if (n.indexOf(PREFIX_INGIN) === 0) return 'ingin';
    if (n.indexOf(PREFIX_TERTARIK) === 0) return 'tertarik';
    return null;
  }

  function fillName(text, conversation) {
    var first = String((conversation && conversation.name) || '').trim().split(/\s+/)[0] || '';
    var out = String(text || '').replace(/\{\{\s*name\s*\}\}/gi, first);
    return out.replace(/ ,/g, ',').replace(/[ \t]{2,}/g, ' ');
  }

  // Newest active row per (suggest_key, language).
  function indexCanned(canned) {
    var byKey = {};
    (canned || []).forEach(function (row) {
      if (!row || row.is_active === false || !row.suggest_key) return;
      var k = row.suggest_key + '|' + (row.language || 'en');
      if (!byKey[k] || toTime(row.created_at) > toTime(byKey[k].created_at)) byKey[k] = row;
    });
    return byKey;
  }

  function fingerprintsFor(key, canned) {
    var fps = [];
    (canned || []).forEach(function (row) {
      if (row && row.suggest_key === key && row.message) {
        var fp = normalize(row.message).slice(0, CONFIG.FINGERPRINT_CHARS);
        if (fp.length >= 10) fps.push(fp);
      }
    });
    return fps.concat(KEY_ALIASES[key] || []);
  }

  function getSuggestedReplies(conversation, messages, canned, now) {
    var result = { primary: [], extras: [], note: null, debug: {} };
    conversation = conversation || {};
    var nowMs = now ? toTime(now) : Date.now();
    var lang = pickLang(conversation);
    var otherLang = lang === 'en' ? 'id' : 'en';
    var byKey = indexCanned(canned);

    var msgs = (messages || []).slice().sort(function (a, b) {
      return toTime(a.created_at) - toTime(b.created_at);
    });

    var incoming = msgs.filter(function (m) { return m.sender === 'incoming' && hasText(m); });
    // Only replies typed by agents decide whose turn it is. The automatic acknowledgement is stored as
    // outgoing with sender_type null, and must not count as "we replied".
    var humanOut = msgs.filter(function (m) { return m.sender === 'outgoing' && m.sender_type === 'human'; });
    var anyOut = msgs.filter(function (m) { return m.sender === 'outgoing'; });

    function build(key, label) {
      var row = byKey[key + '|' + lang];
      var suffix = '';
      if (!row) {
        row = byKey[key + '|' + otherLang];
        if (!row) return null;
        suffix = otherLang === 'en' ? ' (English only)' : ' (Indonesian only)';
      }
      return {
        key: key,
        cannedId: row.id,
        title: row.title,
        label: (label || row.title) + suffix,
        text: fillName(row.message, conversation)
      };
    }

    function push(list, item) { if (item) list.push(item); }

    // Scenario 1: spam or nothing typed by the customer -> no suggestion.
    if (conversation.is_spam === true || incoming.length === 0) {
      result.note = conversation.is_spam ? 'Marked as spam' : 'No customer text yet';
      return result;
    }

    // Session = the latest "Saya ingin/tertarik" message, or the first customer message if none.
    var sessionStart = incoming[0];
    for (var i = incoming.length - 1; i >= 0; i--) {
      if (startsWithPrefix(incoming[i].message)) { sessionStart = incoming[i]; break; }
    }
    var sessionStartMs = toTime(sessionStart.created_at);
    var route = startsWithPrefix(sessionStart.message) || 'unknown';

    function sentSince(key, sinceMs) {
      var fps = fingerprintsFor(key, canned);
      if (!fps.length) return false;
      return anyOut.some(function (m) {
        if (toTime(m.created_at) < sinceMs) return false;
        var n = normalize(m.message);
        return fps.some(function (fp) { return n.indexOf(fp) !== -1; });
      });
    }
    function sent(key) { return sentSince(key, sessionStartMs); }

    var lastIn = incoming[incoming.length - 1];
    var lastInMs = toTime(lastIn.created_at);
    var lastHumanOutMs = humanOut.length ? toTime(humanOut[humanOut.length - 1].created_at) : 0;
    var customerWaiting = lastInMs > lastHumanOutMs; // customer spoke after our last typed reply

    result.debug = { lang: lang, route: route, customerWaiting: customerWaiting };

    // Other options: PDP first (if not sent), then every active canned response outside the sequence.
    var extraKeys = [];
    if (!(CONFIG.PDP_AS_PRIMARY) && !sent('pdp_consent')) extraKeys.push('pdp_consent');
    Object.keys(byKey).forEach(function (k) {
      var key = k.split('|')[0];
      if (PRIMARY_KEYS.indexOf(key) === -1 && key !== 'pdp_consent' && extraKeys.indexOf(key) === -1) extraKeys.push(key);
    });
    extraKeys.forEach(function (k) { push(result.extras, build(k)); });

    if (conversation.status === 'completed') {
      result.note = 'Conversation completed';
      return result;
    }

    // Follow-up: our side has replied and the customer has gone quiet.
    if (!customerWaiting) {
      var hoursSinceIn = (nowMs - lastInMs) / 36e5;
      var hoursSinceOut = (nowMs - lastHumanOutMs) / 36e5;
      var followUpUsed = Number(conversation.follow_up_stage || 0) > 0 || sentSince('follow_up', 0); // max 1 per user
      if (hoursSinceIn >= CONFIG.WINDOW_HOURS) {
        result.note = '24h window closed';
      } else if (!followUpUsed && hoursSinceOut >= CONFIG.FOLLOW_UP_MIN_HOURS) {
        push(result.primary, build('follow_up', 'Follow-up (no reply yet)'));
      }
      return result;
    }

    // Customer is waiting for us from here on.
    var optedOutMs = conversation.opted_out_at ? toTime(conversation.opted_out_at) : 0;
    if (conversation.opted_out === true && !sentSince('re_optin', optedOutMs)) {
      push(result.primary, build('re_optin', 'Re opt-in (must send first)'));
      return result;
    }

    if (route === 'unknown' && !sent('clarify_intent')) {
      push(result.primary, build('clarify_intent', 'Scenario 4 – confirm intent'));
      return result;
    }

    if (CONFIG.PDP_AS_PRIMARY && !sent('pdp_consent')) {
      push(result.primary, build('pdp_consent', 'PDP consent'));
      if (!sent('q1_health')) push(result.primary, build('q1_health'));
      return result;
    }

    if (!sent('q1_health')) {
      push(result.primary, build('q1_health'));
      return result;
    }

    if (route === 'unknown') {
      if (!sent('ingin_q2_patient') && !sent('check_db')) {
        push(result.primary, build('ingin_q2_patient', 'If customer chose (i) – learn more'));
        push(result.primary, build('check_db', 'If customer chose (ii) – ready to book'));
        return result;
      }
      route = sent('ingin_q2_patient') ? 'ingin' : 'tertarik';
    }

    var sequence = route === 'ingin' ? ['q1_health', 'ingin_q2_patient', 'check_db'] : ['q1_health', 'check_db'];
    for (var s = 0; s < sequence.length; s++) {
      if (!sent(sequence[s])) {
        push(result.primary, build(sequence[s]));
        return result;
      }
    }

    if (!sent('contact_number')) {
      push(result.primary, build('contact_number', 'If customer prefers a call'));
      return result;
    }

    result.note = 'Scripted steps done – free text';
    return result;
  }

  var api = { getSuggestedReplies: getSuggestedReplies, CONFIG: CONFIG, _normalize: normalize, _startsWithPrefix: startsWithPrefix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuggestedReply = api;
})(typeof window !== 'undefined' ? window : this);
