// ============================================================
// Speedbot — n8n Code Node: Parse AI Output
// Paste this into a Code node (Execute Once mode) placed
// IMMEDIATELY AFTER the AI Agent node.
//
// Input:  $input.first().json.output  (AI Agent text output)
// Output: { whatsapp_message, intel, escalate, escalate_reason,
//           patient_name, patient_phone, enquiry_condition }
// ============================================================

const raw = $input.first().json.output || '';

// ── 1. Extract <WHATSAPP> block ──────────────────────────────
const waMatch = raw.match(/<WHATSAPP>([\s\S]*?)<\/WHATSAPP>/i);
const whatsapp_message = waMatch
  ? waMatch[1].trim()
  : raw.replace(/<INTEL>[\s\S]*?<\/INTEL>/gi, '').trim(); // fallback: strip intel if tags missing

// ── 2. Extract <INTEL> block ────────────────────────────────
const intelMatch = raw.match(/<INTEL>([\s\S]*?)<\/INTEL>/i);
let intel = {};
let parseError = null;

if (intelMatch) {
  try {
    intel = JSON.parse(intelMatch[1].trim());
  } catch (e) {
    parseError = e.message;
    intel = { parse_error: parseError };
  }
}

// ── 3. Escalation flag ──────────────────────────────────────
const escalate       = intel.escalate === true;
const escalate_reason = intel.escalate_reason || null;

// ── 4. Convenience fields for downstream nodes ──────────────
const patient_name    = intel.patient?.name  || null;
const patient_phone   = intel.patient?.phone || null;
const contact_method  = intel.patient?.contact_method || null;
const enquiry_condition = intel.enquiry?.condition || null;
const current_step    = intel.step || null;
const lang            = intel.lang || 'id';

return [{
  json: {
    whatsapp_message,
    intel,
    escalate,
    escalate_reason,
    patient_name,
    patient_phone,
    contact_method,
    enquiry_condition,
    current_step,
    lang,
    parse_error: parseError,
  }
}];
