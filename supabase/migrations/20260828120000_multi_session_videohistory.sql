-- Multi-session scheduling: videohistory session columns + long-video threshold
alter table public.videohistory
  add column if not exists session_group_id uuid,
  add column if not exists session_index smallint,
  add column if not exists session_count smallint,
  add column if not exists video_offset_start_sec integer,
  add column if not exists video_offset_end_sec integer,
  add column if not exists all_sessions_watched boolean not null default false;

create index if not exists videohistory_session_group_id_idx
  on public.videohistory (session_group_id)
  where session_group_id is not null;

insert into public.slot_algorithm_config (key, value)
values ('LONG_VIDEO_THRESHOLD_MINUTES', '165')
on conflict (key) do update set value = excluded.value;
