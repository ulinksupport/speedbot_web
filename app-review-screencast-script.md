# Meta App Review screencast script: Medical Tourism Indonesia (app 907387132170868)

Dashboard: https://ulink-social-media-platform.vercel.app
Record ONE continuous take (~4-5 min), 1080p, English UI, browser zoom 110%, narrate or caption each step. Upload the same video to every permission and paste the matching "Say" line into that permission's justification box.

## Before recording (checklist)
- [ ] Log in as a tester/role account on a fresh Chrome profile (so the Facebook login dialog is shown, not auto-skipped).
- [ ] If the Page is already connected, press Disconnect first so the reviewer sees Connect from scratch.
- [ ] A second device/account ready to send a Messenger DM and an Instagram DM (irfanazlan IG -> @ulinkassist.official works).
- [ ] App in Live mode OR the recording account has a role on the app; the Page "Ulink Assist Indonesia" must be one that account can manage.
- [ ] Hide the Supabase key / any tokens (Settings page shows key field: don't scroll there).
- [ ] Open the privacy / data-deletion URLs in the new Meta app settings first and confirm they load (privacy.html, data-deletion.html pushed in 50c84c9).

## Scenes
| # | On screen | Say (one line) | Permissions shown |
|---|-----------|----------------|-------------------|
| 1 | Login screen -> sign in. Point at Privacy / Terms / Data deletion links. | "Ulink Assist is a shared inbox for our medical-tourism support team. Our agents log in here." | n/a |
| 2 | Settings -> "Facebook & Instagram" -> click **Connect**. Facebook Login for Business dialog: show the permission list, pick the Page + linked Instagram account, Continue. | "The Page admin connects their Facebook Page and Instagram professional account. We request only what is needed to receive and answer customer messages." | pages_show_list, business_management, instagram_basic, pages_manage_metadata (webhook subscribe happens on this click) |
| 3 | Back in Settings: connected Page + @ulinkassist.official appear in the list. | "Connected channels are listed with the Page name and the linked Instagram account." | pages_show_list, instagram_basic, pages_read_engagement |
| 4 | Phone/2nd account: send a Messenger DM to the Page. Dashboard: conversation appears with the customer's name and message. | "A customer messages our Page; it arrives in the dashboard in real time." | pages_messaging, pages_read_engagement |
| 5 | Agent types a reply in the dashboard and sends. Show it arriving in Messenger on the phone. Also send an image/PDF. | "The agent replies from the dashboard, and the customer receives it in Messenger." | pages_messaging |
| 6 | Repeat 4-5 for Instagram DM (@irfanazlan -> @ulinkassist.official). | "Same flow for Instagram Direct messages." | instagram_manage_messages |
| 7 | Show conversation list filtered by platform + the bot/human handover toggle (agent takes over). | "Agents can take over from the automated assistant at any time." | n/a (context) |
| 8 | Settings -> **Disconnect** a channel, then open data-deletion page. | "Admins can disconnect a channel and customers can request deletion of their data here." | data handling |

## Justification text (paste per permission)
- **pages_show_list / business_management**: Lets the admin pick which of their Pages to connect during onboarding (scene 2-3). We do not read or modify any other business assets.
- **pages_manage_metadata**: Used once, at Connect, to subscribe the app to the Page's messaging webhooks (scene 2).
- **pages_read_engagement**: Used to read the Page and conversation participant name so agents see who they are talking to (scene 3-4).
- **pages_messaging**: Receive customer messages sent to the Page and send agent replies within the messaging window (scene 4-5).
- **instagram_basic**: Identify the Instagram professional account linked to the Page and show its @username (scene 3).
- **instagram_manage_messages**: Receive and reply to Instagram DMs sent to the connected account (scene 6).

## Not in scope
- Human Agent tag: skipped by decision, do not mention.
- WhatsApp: not part of this review; do not show WhatsApp chats (billing/inbound currently down, and the number is unverified).
- instagram_business_* permissions: remove from the submission (wrong login product).

## Open before submission
1. Reviewer login: dashboard has a single shared password. Create a separate reviewer password (not production) and put it in the "Instructions for reviewers" field.
2. Confirm API call counters are non-zero for every requested permission (they lagged on 2026-10-05).
3. Business Verification status for business 3648591925309896 (and partner business Ulink Assist 716739041811723 owning the Page): reviewers may block Advanced Access without it.
4. Per-asset Page access: the recording account must hold Messages access on "Ulink Assist Indonesia".
