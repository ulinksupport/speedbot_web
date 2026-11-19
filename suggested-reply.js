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

  // Route openers. Indonesian from the ad buttons; English equivalents so an English opener
  // follows the same deck route instead of falling into Scenario 4.
  var PREFIXES_INGIN = ['saya ingin', 'i want', 'i would like', "i'd like", 'id like'];
  var PREFIXES_TERTARIK = ['saya tertarik', "i'm interested", 'im interested', 'i am interested'];

  // Words that mark a customer message as Indonesian or English. Used to switch the
  // suggestion language per message (6A, 18 Nov call). "hi"/"hello"/"ok" are left out on purpose:
  // Indonesian customers use them too, so they keep the current language.
  var ID_WORDS = ('saya aku ingin mau tertarik untuk di ke dan yang apa apakah bisa tidak tak gak nggak enggak ada berapa harga ' +
    'dokter rumah sakit janji temu medis terima kasih ya iya iyah iya boleh sendiri kak pak bu ibu bapak sudah belum dengan ' +
    'ini itu kami anda mohon tolong lutut pesan telepon telpon halo selamat pagi siang sore malam kalau bagaimana gimana dari ' +
    'saja aja juga mana orang lain berobat periksa kapan biaya mahal murah sehat keluhan jantung kanker ' +
    'yg sy ia makasih mlm slmt kk ka kakak obat asam urat nyeri bengkak mantap kawan baik tanya lokasi alamat sekarang udh').split(' ');
  var EN_WORDS = ("i i'm im want would like to the a an is are am my me you your can could please how what where when much " +
    'cost price doctor appointment hospital interested in for and of with yes no thank thanks good morning afternoon ' +
    "evening need help know about do does have has it this that myself someone else call chat message phone number knee " +
    "treatment check if not just will be there here which who").split(' ');
  var ID_SET = {}, EN_SET = {};
  ID_WORDS.forEach(function (w) { ID_SET[w] = true; });
  EN_WORDS.forEach(function (w) { EN_SET[w] = true; });

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

  function startsWithAny(n, list) {
    for (var i = 0; i < list.length; i++) if (n.indexOf(list[i]) === 0) return true;
    return false;
  }

  function startsWithPrefix(text) {
    var n = normalize(text).replace(/^[^a-z0-9]+/, '');
    if (startsWithAny(n, PREFIXES_INGIN)) return 'ingin';
    if (startsWithAny(n, PREFIXES_TERTARIK)) return 'tertarik';
    return null;
  }

  // 'en', 'id', or null when the message doesn't clearly lean either way (e.g. "ok", a number, an emoji).
  function detectLang(text) {
    var words = normalize(text).replace(/[^a-z' ]+/g, ' ').split(' ').filter(Boolean);
    var id = 0, en = 0;
    words.forEach(function (w) { if (ID_SET[w]) id++; if (EN_SET[w]) en++; });
    if (id > en) return 'id';
    if (en > id) return 'en';
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
    var byKey = indexCanned(canned);

    var msgs = (messages || []).slice().sort(function (a, b) {
      return toTime(a.created_at) - toTime(b.created_at);
    });

    var incoming = msgs.filter(function (m) { return m.sender === 'incoming' && hasText(m); });

    // Language: follow the customer's latest message that clearly leans one way; if none do,
    // use the channel default (ID channels Indonesian, non-ID English).
    var channelLang = pickLang(conversation);
    var lang = channelLang, langFrom = 'channel';
    for (var li = incoming.length - 1; li >= 0; li--) {
      var dl = detectLang(incoming[li].message);
      if (dl) { lang = dl; langFrom = 'customer message'; break; }
    }
    var otherLang = lang === 'en' ? 'id' : 'en';
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

    result.debug = { lang: lang, langFrom: langFrom, route: route, customerWaiting: customerWaiting };

    function isKey(m, key) {
      if (!m) return false;
      var n = normalize(m.message);
      return fingerprintsFor(key, canned).some(function (fp) { return n.indexOf(fp) !== -1; });
    }
    var lastHumanOut = humanOut.length ? humanOut[humanOut.length - 1] : null;

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

    // Consent is passive (no reply needed), so right after it goes out, suggest the phone number.
    if (!customerWaiting && isKey(lastHumanOut, 'pdp_consent') && !sent('contact_number')
        && (nowMs - lastInMs) / 36e5 < CONFIG.WINDOW_HOURS) {
      push(result.primary, build('contact_number', 'Phone number (after consent)'));
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

    // Scenario 4 only makes sense before Q1. If an agent already asked Q1, don't go back to it.
    if (route === 'unknown' && !sent('clarify_intent') && !sent('q1_health')) {
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

    // Customer replied after the "continue by call or chat" question: consent first, then phone number.
    if (!sent('pdp_consent')) {
      push(result.primary, build('pdp_consent', 'Consent (no reply needed)'));
      result.extras = result.extras.filter(function (e) { return e.key !== 'pdp_consent'; });
      return result;
    }
    if (!sent('contact_number')) {
      push(result.primary, build('contact_number', 'Phone number'));
      return result;
    }

    result.note = 'Scripted steps done – free text';
    return result;
  }

  var api = { getSuggestedReplies: getSuggestedReplies, CONFIG: CONFIG, _normalize: normalize, _startsWithPrefix: startsWithPrefix, _detectLang: detectLang };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuggestedReply = api;
})(typeof window !== 'undefined' ? window : this);
