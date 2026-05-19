# Speedbot n8n Workflow — Escalation & Intelligence Guide

## Files in this folder
| File | Purpose |
|---|---|
| `n8n_prompt.txt` | System prompt — paste into AI Agent node |
| `n8n_code_parser.js` | Code node JavaScript — place after AI Agent |
| `n8n_workflow_guide.md` | This guide |

---

## Updated Flow Diagram

```
WhatsApp Webhook
     │
Edit Fields  (phone, name, message)
     │
Get Rows By Phone
     │
If conversation exists?
  YES ──► Update conversation row ──┐
  NO  ──► Create conversation row ──┘
                                    │
                         Create incoming message row
                                    │
                         If bot_enabled?
                           YES ──► AI Agent (GPT-4)
                                        │
                              ┌─── Code Node: Parse AI Output ───┐
                              │  (n8n_code_parser.js)            │
                              └──────────────────────────────────┘
                                        │
                              If escalate === true ?
                                YES ──► Gmail: Send to ops@ulinkassist.com
                                              │
                                        WhatsApp Reply  ◄── NO branch also goes here
                                              │
                                   Create outgoing message row
```

---

## Step 1 — Update the AI Agent System Prompt

1. Open your `Speedbot Chat Flow` in n8n.
2. Click the **AI Agent** node.
3. Find the **System Prompt** (or "Instructions") field.
4. **Replace all existing content** with the contents of `n8n_prompt.txt`.
5. Save.

---

## Step 2 — Add the Code Node (Parse AI Output)

1. After the **AI Agent** node, click **+** to add a node.
2. Choose **Code** → **Execute Once**.
3. Set language to **JavaScript**.
4. Paste the full contents of `n8n_code_parser.js`.
5. Connect: `AI Agent` → `Code Node`.

**Output fields produced:**
- `whatsapp_message` — the clean text to send to WhatsApp
- `escalate` — boolean
- `escalate_reason` — string or null
- `patient_name` — collected name or null
- `patient_phone` — collected phone or null
- `contact_method` — "call" or "whatsapp" or null
- `enquiry_condition` — brief health condition description
- `intel` — full JSON object for storage/analysis

---

## Step 3 — Add the IF (Escalation Router) Node

1. After the Code Node, add an **IF** node.
2. Condition: `{{ $json.escalate }}` **equals** `true`
3. Rename branches:
   - TRUE → "Escalate"
   - FALSE → "Normal"

---

## Step 4 — Add the Gmail Node (Escalation Branch)

1. On the **TRUE** branch, add a **Gmail** node.
2. Configure:

**Operation:** Send

**To:** `ops@ulinkassist.com`

**Subject:**
```
[Speedbot Escalation] {{ $json.escalate_reason }} — {{ $json.patient_name ?? 'Unknown' }} ({{ $('Edit Fields').item.json.phone }})
```

**Body (HTML):**
```html
<h2 style="color:#d9534f;">⚠️ Speedbot Escalation Alert</h2>
<table border="0" cellpadding="6" style="font-family:sans-serif;font-size:14px;">
  <tr><td><strong>Reason</strong></td><td>{{ $json.escalate_reason }}</td></tr>
  <tr><td><strong>Step Reached</strong></td><td>{{ $json.current_step }}</td></tr>
  <tr><td><strong>WhatsApp Phone</strong></td><td>{{ $('Edit Fields').item.json.phone }}</td></tr>
  <tr><td><strong>Patient Name</strong></td><td>{{ $json.patient_name ?? '—' }}</td></tr>
  <tr><td><strong>Patient Phone</strong></td><td>{{ $json.patient_phone ?? '—' }}</td></tr>
  <tr><td><strong>Contact Method</strong></td><td>{{ $json.contact_method ?? '—' }}</td></tr>
  <tr><td><strong>Condition / Enquiry</strong></td><td>{{ $json.enquiry_condition ?? '—' }}</td></tr>
  <tr><td><strong>Language</strong></td><td>{{ $json.lang }}</td></tr>
</table>

<h3>Last User Message</h3>
<blockquote style="background:#f8f8f8;padding:10px;border-left:4px solid #ccc;">
  {{ $('Edit Fields').item.json.message }}
</blockquote>

<h3>AI Reply Sent</h3>
<blockquote style="background:#f0f7ff;padding:10px;border-left:4px solid #4f81f1;">
  {{ $json.whatsapp_message }}
</blockquote>

<h3>Full Intelligence JSON</h3>
<pre style="background:#f8f8f8;padding:10px;font-size:12px;">{{ JSON.stringify($json.intel, null, 2) }}</pre>

<p style="color:#888;font-size:12px;">Conversation history available in Supabase → messages table, filter by phone: {{ $('Edit Fields').item.json.phone }}</p>
```

3. After Gmail node, connect to the **WhatsApp Reply** node.

---

## Step 5 — Update the WhatsApp Reply Node

The WhatsApp Reply node currently sends the AI Agent's raw output.  
**Change its message field to:** `{{ $json.whatsapp_message }}`  
(This sends only the clean text, with INTEL stripped out.)

---

## Step 6 — (Optional) Store Intelligence in Supabase

Add a **Supabase** node after the Code Node (parallel to the IF node or after WhatsApp Reply):

**Table:** `conversation_intel` (create this table first — see schema below)

**Operation:** Insert

**Fields to map:**
| Supabase column | n8n value |
|---|---|
| `phone` | `{{ $('Edit Fields').item.json.phone }}` |
| `step` | `{{ $json.current_step }}` |
| `lang` | `{{ $json.lang }}` |
| `escalated` | `{{ $json.escalate }}` |
| `escalate_reason` | `{{ $json.escalate_reason }}` |
| `patient_name` | `{{ $json.patient_name }}` |
| `patient_phone` | `{{ $json.patient_phone }}` |
| `contact_method` | `{{ $json.contact_method }}` |
| `condition` | `{{ $json.enquiry_condition }}` |
| `destination` | `{{ $json.intel.enquiry?.destination }}` |
| `enquiry_type` | `{{ $json.intel.enquiry?.type }}` |
| `questions_asked` | `{{ JSON.stringify($json.intel.questions_asked) }}` |
| `intel_raw` | `{{ JSON.stringify($json.intel) }}` |
| `created_at` | (auto, use Supabase default) |

### Supabase SQL — Create the table:
```sql
create table conversation_intel (
  id uuid default gen_random_uuid() primary key,
  phone text,
  step integer,
  lang text,
  escalated boolean default false,
  escalate_reason text,
  patient_name text,
  patient_phone text,
  contact_method text,
  condition text,
  destination text,
  enquiry_type text,
  questions_asked jsonb,
  intel_raw jsonb,
  created_at timestamptz default now()
);
```

---

## Escalation Reason Reference

| `escalate_reason` value | Trigger |
|---|---|
| `angry` | User frustrated, angry, or dissatisfied |
| `cost_inquiry` | User asks for specific price/cost |
| `dr_recommendation` | User asks for specific doctor |
| `human_requested` | User gave name + phone (Step 5 complete) |
| `emergency` | Medical emergency / evacuation / repatriation |
| `ai_uncertain` | AI confidence < 50% |
| `incorrect_answer` | User says answer is wrong |
| `human_agent` | User explicitly asked for human |

---

## Intelligence JSON Sample

```json
{
  "step": 5,
  "lang": "en",
  "escalate": true,
  "escalate_reason": "human_requested",
  "patient": {
    "name": "Budi Santoso",
    "phone": "+62812345678",
    "is_self": true,
    "contact_method": "whatsapp"
  },
  "enquiry": {
    "condition": "knee replacement surgery",
    "destination": "malaysia",
    "type": "surgery"
  },
  "questions_asked": [
    "My number is +62812345678"
  ]
}
```
