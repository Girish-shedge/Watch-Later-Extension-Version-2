-- Queue impact intercept: cooldown row + tunable numeric config keys.
-- Countable unit stays videohistory rows (watched_at / removed / forced).

create table if not exists public.queue_intercept_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_shown_at timestamptz,
  last_shown_after_weeks numeric(6, 2)
);

comment on table public.queue_intercept_state is
  'Per-user cooldown for the schedule queue-impact intercept sheet.';

alter table public.queue_intercept_state enable row level security;

create policy queue_intercept_state_select_own
  on public.queue_intercept_state
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy queue_intercept_state_insert_own
  on public.queue_intercept_state
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy queue_intercept_state_update_own
  on public.queue_intercept_state
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy queue_intercept_state_delete_own
  on public.queue_intercept_state
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.queue_intercept_state to authenticated;
revoke all on table public.queue_intercept_state from anon, public;

insert into public.slot_algorithm_config (key, value) values
  ('QUEUE_PACE_WINDOW_DAYS', 28),
  ('QUEUE_PACE_MIN_SAMPLE', 3),
  ('QUEUE_INTERCEPT_MIN_WEEKS', 3),
  ('QUEUE_INTERCEPT_TIER_LOW', 4),
  ('QUEUE_INTERCEPT_TIER_HIGH', 13),
  ('QUEUE_INCLUDE_NEEDS_ATTENTION', 1),
  ('QUEUE_DISPLAY_CAP_WEEKS', 26),
  ('QUEUE_INTERCEPT_COOLDOWN_DAYS', 30)
on conflict (key) do nothing;
