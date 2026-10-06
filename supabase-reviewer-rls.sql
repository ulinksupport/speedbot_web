-- Meta App Review reviewer access (Option A: RLS + reviewer JWT).
-- The worker mints a JWT {role:authenticated, app_role:reviewer}; these policies
-- let that token see ONLY conversations flagged review_visible. The service_role
-- key (admin dashboard, worker, n8n) bypasses RLS, so existing flows are unchanged.
-- anon gets no policy => no access to any of these tables.
-- Roll back a table with:  alter table <t> disable row level security;

alter table conversations add column if not exists review_visible boolean not null default false;

alter table conversations         enable row level security;
alter table messages              enable row level security;
alter table conversation_comments enable row level security;
alter table template_sends        enable row level security;

create or replace function is_reviewer() returns boolean
language sql stable as $$ select coalesce(auth.jwt() ->> 'app_role','') = 'reviewer' $$;

create policy reviewer_conv_select on conversations for select to authenticated
  using (is_reviewer() and review_visible);
create policy reviewer_conv_update on conversations for update to authenticated
  using (is_reviewer() and review_visible) with check (is_reviewer() and review_visible);

create policy reviewer_msg_select on messages for select to authenticated
  using (is_reviewer() and exists (select 1 from conversations c where c.id = messages.conversation_id and c.review_visible));
create policy reviewer_msg_insert on messages for insert to authenticated
  with check (is_reviewer() and exists (select 1 from conversations c where c.id = messages.conversation_id and c.review_visible));

create policy reviewer_comment_select on conversation_comments for select to authenticated
  using (is_reviewer() and exists (select 1 from conversations c where c.id = conversation_comments.conversation_id and c.review_visible));
create policy reviewer_comment_insert on conversation_comments for insert to authenticated
  with check (is_reviewer() and exists (select 1 from conversations c where c.id = conversation_comments.conversation_id and c.review_visible));

-- Test set shown to reviewers (confirm these are test contacts first):
update conversations set review_visible = true where id in (8549, 8550);
