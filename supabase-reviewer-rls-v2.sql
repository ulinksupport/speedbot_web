-- Reviewer-connected Pages: conversations on a Page a reviewer connected themselves
-- (channel_connections.is_review = true) are visible to the reviewer session.
alter table channel_connections add column if not exists is_review boolean not null default false;

create or replace function is_review_recipient(rid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from channel_connections
                 where is_review and (page_id = rid or ig_business_account_id = rid))
$$;

drop policy if exists reviewer_conv_select on conversations;
drop policy if exists reviewer_conv_update on conversations;
drop policy if exists reviewer_msg_select on messages;
drop policy if exists reviewer_msg_insert on messages;
drop policy if exists reviewer_comment_select on conversation_comments;
drop policy if exists reviewer_comment_insert on conversation_comments;

create policy reviewer_conv_select on conversations for select to authenticated
  using (is_reviewer() and (review_visible or is_review_recipient(meta_recipient_id::text)));
create policy reviewer_conv_update on conversations for update to authenticated
  using (is_reviewer() and (review_visible or is_review_recipient(meta_recipient_id::text)))
  with check (is_reviewer() and (review_visible or is_review_recipient(meta_recipient_id::text)));

create policy reviewer_msg_select on messages for select to authenticated
  using (is_reviewer() and exists (select 1 from conversations c where c.id = messages.conversation_id
         and (c.review_visible or is_review_recipient(c.meta_recipient_id::text))));
create policy reviewer_msg_insert on messages for insert to authenticated
  with check (is_reviewer() and exists (select 1 from conversations c where c.id = messages.conversation_id
         and (c.review_visible or is_review_recipient(c.meta_recipient_id::text))));

create policy reviewer_comment_select on conversation_comments for select to authenticated
  using (is_reviewer() and exists (select 1 from conversations c where c.id = conversation_comments.conversation_id
         and (c.review_visible or is_review_recipient(c.meta_recipient_id::text))));
create policy reviewer_comment_insert on conversation_comments for insert to authenticated
  with check (is_reviewer() and exists (select 1 from conversations c where c.id = conversation_comments.conversation_id
         and (c.review_visible or is_review_recipient(c.meta_recipient_id::text))));
