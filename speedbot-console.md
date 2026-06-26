# Speedbot Console — Reference Guide

## Overview

The Speedbot Console (`index (2).html`) is a single-file web dashboard for managing WhatsApp conversations routed through the Ulink Assist AI agent. It connects to Supabase for real-time data and posts to an n8n webhook when a human agent replies.

---

## Architecture

```
WhatsApp → n8n (Speedbot Chat Flow) → Supabase → Console (Realtime)
                                                 ↑
Human Agent replies in Console → n8n (Human WhatsApp Reply) → WhatsApp
```

### Key Supabase Tables

| Table | Purpose |
|---|---|
| `conversations` | One row per WhatsApp contact. Fields: `id`, `phone`, `name`, `platform`, `status`, `bot_enabled`, `last_message`, `last_message_time`, `assigned_to`, `follow_up` |
| `messages` | All messages. Fields: `id`, `phone`, `conversation_id`, `message`, `sender` (`incoming`/`outgoing`), `sender_type` (`human`/`bot`), `created_at`, `created_at_sgt` |

### n8n Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `Speedbot Chat Flow` | WhatsApp Webhook → `whatsapp-agent-webhook` | Receives inbound WhatsApp messages, routes to AI Agent (GPT-4), saves to Supabase |
| `Socials Dashboard - Human Whatsapp Reply` | POST `human-send-message` | Sends human reply back to WhatsApp, saves outgoing message row |

### Supabase Realtime
- **`messages` table** — INSERT triggers live message append in open chat; UPDATE re-fetches messages
- **`conversations` table** — INSERT/UPDATE refreshes the chat list and syncs `bot_enabled` state

---

## Console Features

### Bot / Human Mode Toggle
- **AI Active** (green pill, robot icon): `bot_enabled = true` in Supabase. Input is disabled. n8n AI Agent handles all replies.
- **Human Active** (blue pill, person icon): `bot_enabled = false`. Input is enabled. Agent types and sends manually.
- Clicking the pill button toggles mode and writes to Supabase instantly.

### Auto-Detect Country & Language
When a chat is opened or a new enquiry arrives:
1. **Country** is inferred from the phone number's international dialling prefix (e.g. `+62` → Indonesia).
2. **Language** is first detected from the message text using keyword patterns (supports Indonesian, Malay, Thai, Arabic, Mandarin, Hindi). Falls back to the country's default language.
3. Values populate the **Country** and **Language** fields in the right-hand profile panel.

Detection runs on: initial load, new message via realtime, `openChat()`.

### Resizable Profile Panel
- A drag handle sits between the chat window and the profile panel.
- Drag left/right to resize the profile panel (min 200 px, max 500 px).
- Width is stored in the CSS custom property `--profile-width`.

### Sidebar Filters

| Filter | Shows |
|---|---|
| All | Every conversation |
| My Inbox | Assigned conversations |
| Unassigned | `status = open` AND `assigned_to` is null |
| Unreplied | Conversations with no outgoing reply yet |
| Follow Up | `follow_up = true` |
| Unread | Conversations with `unread_count > 0` |

### Message Colours
| Colour | Meaning |
|---|---|
| White bubble | Incoming message from customer |
| Dark navy bubble | Outgoing — AI bot reply |
| Blue bubble | Outgoing — Human agent reply |

---

## Credentials & Endpoints

| Resource | Value |
|---|---|
| Supabase Project | `ehhynoowqlsgmcfyqofh.supabase.co` |
| n8n Cloud | `ulink.app.n8n.cloud` |
| Human reply webhook | `POST /webhook/human-send-message` |
| WhatsApp inbound webhook | `POST /webhook/whatsapp-agent-webhook` |
| WhatsApp Phone Number ID | `970011649529902` |
| WhatsApp Business Number | `60178097754` |
| n8n WhatsApp credential | `WhatsApp account 9` |
| n8n Supabase credential | `Supabase account 2` |
| n8n OpenAI credential | `OpenAi account` (GPT-4) |

---

## Known Limitations / Future Work

- Country and language detection is client-side only; not persisted back to Supabase unless `country`/`language` columns are added to the `conversations` table.
- The `conversations` table does not yet have `country` or `language` columns — add them to persist auto-detected values.
- AI agent uses GPT-4 (OpenAI); swap `OpenAI Chat Model` node in `Speedbot Chat Flow` to change model.
- Login is a hardcoded password (`admin123`) — replace with Supabase Auth for production.
- Analytics, Calls, and Settings sidebar items are placeholders.
- Messenger and Instagram filters exist in the UI but inbound flows are not wired in n8n yet.

---

## Common Tasks

### Disable bot for a conversation
Click the green **AI Active** pill in the chat header → turns blue **Human Active**. Agent can now type freely.

### Re-enable bot
Click the blue **Human Active** pill → returns to green **AI Active**. Input locks again.

### Mark for follow-up
Click the ★ star icon in the chat header. Saves `follow_up = true` in Supabase.

### Assign conversation
Click the ✓ user-check icon → select agent from modal.

### Add a new language pattern
In `detectLanguageFromText()` (bottom of `<script>`), add an entry to the `patterns` array:
```js
{ lang: "Tamil", words: ["நன்றி", "வணக்கம்", "மருத்துவர்"] }
```

### Add a new country prefix
In `PHONE_COUNTRY_MAP`, add `["prefix", "Country Name"]`. For the language default, also add to `COUNTRY_LANGUAGE_MAP`.
