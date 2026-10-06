# Meta App Review screencast package: Medical Tourism Indonesia (app 907387132170868)

Dashboard: https://ulink-social-media-platform.vercel.app
Reviewer login for the dashboard: password `Reviewer-Meta-2026!` (sees only test conversations: Faisal Imtiaz, @irfanazlan)

## Meta's rules (from developers.facebook.com App Review submission guide)
- 1080p or higher; monitor width 1440px or less while recording; record the app window full screen.
- Audio NOT required (reviewers don't listen) -> burn in captions / on-screen text for every step. UI must be English.
- Use the MOUSE (not keyboard shortcuts) and enlarge the cursor so every click is visible.
- Show each permission being GRANTED by an app user (full login, consent dialog, tick the permission, Continue), then the feature using it.
- One recording per permission AND a UNIQUE written description per permission (no copy-paste between permissions).
- Don't submit personal Meta credentials; reviewers use their own test accounts, so the flow must be reproducible by them.
- Instagram messaging is for business-to-customer support conversations; use a Business/Creator IG account, never personal.
- Webhook must answer 200 OK within 20 s (worker does).
- Common rejections: skipped/started-already-logged-in; consent screen not shown; reviewer can't reproduce; a permission missing from the video; description doesn't match the video.

## Recording setup
- OBS (free), 1920x1080, 30 fps, MP4; browser window full screen at 100-110% zoom; cursor size large; Windows notifications off (Focus Assist).
- Chrome: fresh profile, log OUT of Facebook before scene 2 so the full login is captured. Use the test Facebook user that has a role on the app and manages the Page.
- Second device (phone) for the customer side: one Messenger account and one Instagram account (non-business personal customer account messaging the business account is fine).
- Disconnect the Page in the dashboard before recording so Connect is shown from zero.
- Never show tokens, the Supabase key, or the n8n URL.
- Add captions in the editor (Clipchamp/CapCut/DaVinci): one caption per step, exactly the "Caption" text below.

## Segments (record each as its own file; same scenes may be reused, descriptions must differ)

### Segment 0, shared opening (put at the start of EVERY segment file)
1. Caption "Step 1: Reviewer opens the app and logs in". Open dashboard URL, enter `Reviewer-Meta-2026!`, press Sign In.
2. Caption "Settings > Facebook & Instagram". Open Settings, show the Connect button.

### Segment A: pages_show_list + business_management + pages_manage_metadata
1. Caption "Admin clicks Connect". Click Connect; Facebook Login for Business popup appears.
2. Caption "Facebook login (logged out first)": enter test user email+password.
3. Caption "Consent screen: user grants permissions". Slow scroll the dialog so every requested permission is readable; select the Page and linked Instagram account; Continue/Save.
4. Caption "Pages the admin manages are listed (pages_show_list)". Show the Page picker.
5. Caption "Connected. App subscribed the Page to messaging webhooks (pages_manage_metadata)". Back in Settings show the connected Page row with no warning badge.

### Segment B: pages_messaging + pages_read_engagement
1. Segment 0, then connected Page visible.
2. Caption "Customer sends a Messenger message to the Page" (phone screen recording or screen-share of Messenger web, show Page name and typed message).
3. Caption "Message arrives in the dashboard; sender name read from the Page conversation (pages_read_engagement)". Open the conversation.
4. Caption "Agent replies from the dashboard (pages_messaging)". Type and send; then show the reply arriving in Messenger.
5. Caption "Agent sends an attachment". Send an image; show it received.

### Segment C: instagram_basic + instagram_manage_messages
1. Segment 0, then the connected row showing IG @ulinkassist.official (instagram_basic).
2. Caption "Customer sends an Instagram DM to the business account" (show @ulinkassist.official chat on phone).
3. Caption "DM appears in the dashboard with the username". Open it.
4. Caption "Agent replies to the customer (instagram_manage_messages)". Send; show it arriving in Instagram.

### Segment D (optional context): data handling
Caption "Admin can disconnect; customers can request deletion". Show Privacy, Terms, Data deletion links on login screen and open data-deletion page. (Disconnect is hidden for reviewer login; show it with the admin login only if you want it.)

## Written descriptions (unique per permission; paste into each box)
- **pages_show_list**: "During onboarding the admin clicks Connect and signs in with Facebook. The app calls /me/accounts to list the Pages the admin manages so they can choose which Page to connect (Segment A, 0:20-0:50). No other Page data is requested."
- **business_management**: "Required because the Page is owned by a Business Manager portfolio; the app uses it only to return the business-owned Page in /me/accounts so it can be selected at Connect (Segment A)."
- **pages_manage_metadata**: "Right after Connect, the app calls POST /{page-id}/subscribed_apps with the messages webhook fields so Messenger and Instagram messages reach our inbox (Segment A, final step). It is not used for anything else."
- **pages_read_engagement**: "Used to read the Page conversation participant's name so the agent sees who they are talking to in the inbox (Segment B 0:40)."
- **pages_messaging**: "Used to receive Messenger messages sent to the connected Page and to send an agent's reply and attachments within the standard messaging window (Segment B). Messages are only sent in reply to a customer who messaged first."
- **instagram_basic**: "Used to read the Instagram professional account linked to the connected Page and display its @username in Settings and on conversations (Segment C)."
- **instagram_manage_messages**: "Used to receive Instagram DMs sent to our business account and to let a support agent reply (Segment C). Customer-service conversations only."

## Instructions for reviewers (paste in submission notes)
1. Open https://ulink-social-media-platform.vercel.app and sign in with password `Reviewer-Meta-2026!` (limited demo access; shows demo conversations only).
2. Click the gear (Settings) -> Facebook & Instagram -> Connect and sign in with your own test user who has a role on the app and manages a Page (with a linked Instagram Business/Creator account).
3. Send a message to the Page on Messenger and a DM to the linked Instagram account; reply from the dashboard.
(Add whichever of these steps applies once the open item below is decided.)

## Status / open items
- Done: reviewer login (server-verified, RLS-limited to test conversations 8549 and 8550), legal pages, Connect flow, Messenger+IG send/receive pipeline, failed-send indicator.
- OPEN, reviewer replication gap: if a reviewer connects THEIR OWN Page, their new conversations are not flagged `review_visible`, so the reviewer login will not display them (it only shows the two test threads). Needs a rule that marks conversations from non-Ulink Pages visible to reviewers (the conversations table has no page id column, so this needs a small schema addition).
- OPEN: API-call counters were 0 on 2026-10-05; recheck before "Request advanced access".
- OPEN: Business Verification (business 3648591925309896 / partner Ulink Assist 716739041811723).
- Remove instagram_business_* permissions from the submission; do not request Human Agent; leave WhatsApp out of the video.
- Rotate Page access tokens (they were readable with the public anon key until RLS was enabled on channel_connections 2026-10-06); re-Connect before recording.
