-- Entanglement sync server schema (design spec §18.4, §19).
--
-- One account's history is:
--   ent_heads           the current revision, digest and schema gate (1 row)
--   ent_commits         change sets since the last compaction anchor
--   ent_checkpoints     complete states at selected revisions
--   ent_restore_points  user-visible labels on revisions
--
-- Clients can only READ these tables (row-level security, own rows). Every
-- write goes through the SECURITY DEFINER functions below, which enforce the
-- protocol's invariants — compare-and-swap, idempotency, the schema gate,
-- checkpoint verification and compaction safety — so a buggy or outdated
-- client cannot bypass them.
--
-- Result columns are prefixed `out_` so they can never collide with table
-- columns inside the function bodies.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.ent_heads (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  revision           bigint not null,
  schema_version     int    not null,
  -- Oldest schema version still allowed to read and write (spec §17.2).
  min_version        int    not null,
  state_digest       text   not null,
  -- Commits at or below this revision have been compacted away.
  compacted_through  bigint not null default 0,
  updated_at         timestamptz not null default now()
);

create table if not exists public.ent_commits (
  user_id           uuid   not null references auth.users (id) on delete cascade,
  revision          bigint not null,
  commit_id         uuid   not null,
  parent            bigint not null,
  schema_version    int    not null,
  compatible_since  int    not null,
  state_digest      text   not null,
  device_id         text   not null,
  device_label      text,
  client_time       bigint,
  message           text,
  changes           jsonb  not null,
  committed_at      timestamptz not null default now(),
  primary key (user_id, revision),
  unique (user_id, commit_id)
);

create table if not exists public.ent_checkpoints (
  user_id         uuid   not null references auth.users (id) on delete cascade,
  revision        bigint not null,
  schema_version  int    not null,
  state_digest    text   not null,
  entities        jsonb  not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, revision)
);

create table if not exists public.ent_restore_points (
  user_id       uuid    not null references auth.users (id) on delete cascade,
  revision      bigint  not null,
  kind          text    not null,
  label         text,
  pinned        boolean not null default false,
  device_label  text,
  created_at    timestamptz not null default now(),
  primary key (user_id, revision, kind)
);

-- ---------------------------------------------------------------------------
-- Row-level security: read own rows; no direct writes at all.
-- ---------------------------------------------------------------------------

alter table public.ent_heads          enable row level security;
alter table public.ent_commits        enable row level security;
alter table public.ent_checkpoints    enable row level security;
alter table public.ent_restore_points enable row level security;

-- Explicit table privileges, rather than relying on the project's default
-- grants (newer projects may not expose new tables automatically). Signed-in
-- users may SELECT — row-level security narrows that to their own rows — and
-- nobody may write directly.
revoke all on table public.ent_heads, public.ent_commits,
  public.ent_checkpoints, public.ent_restore_points from anon, authenticated;
grant select on table public.ent_heads, public.ent_commits,
  public.ent_checkpoints, public.ent_restore_points to authenticated;

drop policy if exists ent_heads_select_own on public.ent_heads;
create policy ent_heads_select_own on public.ent_heads
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists ent_commits_select_own on public.ent_commits;
create policy ent_commits_select_own on public.ent_commits
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists ent_checkpoints_select_own on public.ent_checkpoints;
create policy ent_checkpoints_select_own on public.ent_checkpoints
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists ent_restore_points_select_own on public.ent_restore_points;
create policy ent_restore_points_select_own on public.ent_restore_points
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ent_submit: compare-and-swap publish (spec §18.4).
-- ---------------------------------------------------------------------------

create or replace function public.ent_submit(p_request jsonb)
returns table (out_status text, out_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_commit_id  uuid;
  v_parent     bigint;
  v_schema     int;
  v_compat     int;
  v_digest     text;
  v_existing   bigint;
  v_head       public.ent_heads%rowtype;
  v_revision   bigint;
begin
  if v_uid is null then
    raise exception 'ent_submit requires an authenticated session'
      using errcode = '28000';
  end if;

  begin
    v_commit_id := (p_request ->> 'commitId')::uuid;
    v_parent    := (p_request ->> 'parent')::bigint;
    v_schema    := (p_request ->> 'schemaVersion')::int;
    v_compat    := (p_request ->> 'compatibleSince')::int;
    v_digest    := p_request ->> 'stateDigest';
  exception when others then
    return query select 'rejected_invalid'::text, null::bigint;
    return;
  end;
  if v_commit_id is null or v_parent is null or v_schema is null
     or v_compat is null or v_digest is null or length(v_digest) <> 64
     or jsonb_typeof(p_request -> 'changes') is distinct from 'array' then
    return query select 'rejected_invalid'::text, null::bigint;
    return;
  end if;

  -- Make sure a head row exists to lock. Two first commits racing both reach
  -- here; ON CONFLICT turns the loser into an ordinary conflict below.
  insert into public.ent_heads (user_id, revision, schema_version, min_version, state_digest)
  values (v_uid, 0, v_schema, v_compat, repeat('0', 64))
  on conflict (user_id) do nothing;

  select * into v_head from public.ent_heads h where h.user_id = v_uid for update;

  -- 1. Idempotency, checked under the lock so a retry racing the original
  --    still sees it.
  select c.revision into v_existing
  from public.ent_commits c
  where c.user_id = v_uid and c.commit_id = v_commit_id;
  if found then
    return query select 'accepted'::text, v_existing;
    return;
  end if;

  -- 2. Schema gate (spec §17.2). A head at revision 0 has no data to protect.
  if v_head.revision > 0 and v_schema < v_head.min_version then
    return query select 'rejected_schema_too_old'::text, v_head.revision;
    return;
  end if;

  -- 3. Compare-and-swap.
  if v_parent <> v_head.revision then
    return query select 'conflict'::text, v_head.revision;
    return;
  end if;

  -- 4. Advance.
  v_revision := v_head.revision + 1;
  insert into public.ent_commits (
    user_id, revision, commit_id, parent, schema_version, compatible_since,
    state_digest, device_id, device_label, client_time, message, changes
  ) values (
    v_uid, v_revision, v_commit_id, v_parent, v_schema, v_compat,
    v_digest, coalesce(p_request ->> 'deviceId', ''), p_request ->> 'deviceLabel',
    (p_request ->> 'clientTime')::bigint, p_request ->> 'message',
    p_request -> 'changes'
  );

  update public.ent_heads h
  set revision       = v_revision,
      schema_version = v_schema,
      min_version    = case when v_head.revision = 0 then v_compat
                            else greatest(h.min_version, v_compat) end,
      state_digest   = v_digest,
      updated_at     = now()
  where h.user_id = v_uid;

  if p_request ->> 'message' is not null then
    insert into public.ent_restore_points (user_id, revision, kind, label, device_label)
    values (v_uid, v_revision, 'commit', p_request ->> 'message', p_request ->> 'deviceLabel')
    on conflict (user_id, revision, kind) do nothing;
  end if;

  return query select 'accepted'::text, v_revision;
end;
$$;

-- ---------------------------------------------------------------------------
-- ent_put_checkpoint: accepted only if it matches its commit's digest.
-- ---------------------------------------------------------------------------

create or replace function public.ent_put_checkpoint(p_checkpoint jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_revision  bigint := (p_checkpoint ->> 'revision')::bigint;
  v_expected  text;
begin
  if v_uid is null then
    raise exception 'ent_put_checkpoint requires an authenticated session'
      using errcode = '28000';
  end if;
  select c.state_digest into v_expected
  from public.ent_commits c
  where c.user_id = v_uid and c.revision = v_revision;
  if not found then
    raise exception 'no commit at revision %', v_revision using errcode = 'P0002';
  end if;
  if v_expected <> p_checkpoint ->> 'stateDigest' then
    raise exception 'checkpoint digest does not match its commit'
      using errcode = '22000';
  end if;
  insert into public.ent_checkpoints (user_id, revision, schema_version, state_digest, entities)
  values (
    v_uid, v_revision, (p_checkpoint ->> 'schemaVersion')::int,
    p_checkpoint ->> 'stateDigest', p_checkpoint -> 'entities'
  )
  on conflict (user_id, revision) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Restore points.
-- ---------------------------------------------------------------------------

create or replace function public.ent_put_restore_point(
  p_revision     bigint,
  p_kind         text,
  p_label        text,
  p_pinned       boolean,
  p_device_label text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_head  bigint;
begin
  if v_uid is null then
    raise exception 'ent_put_restore_point requires an authenticated session'
      using errcode = '28000';
  end if;
  select h.revision into v_head from public.ent_heads h where h.user_id = v_uid;
  if p_revision < 0 or p_revision > coalesce(v_head, 0) then
    raise exception 'revision % not found', p_revision using errcode = 'P0002';
  end if;
  insert into public.ent_restore_points (user_id, revision, kind, label, pinned, device_label)
  values (v_uid, p_revision, p_kind, p_label, coalesce(p_pinned, false), p_device_label)
  on conflict (user_id, revision, kind)
  do update set label = excluded.label, pinned = excluded.pinned,
                device_label = excluded.device_label;
end;
$$;

create or replace function public.ent_delete_restore_points(p_keys jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ent_delete_restore_points requires an authenticated session'
      using errcode = '28000';
  end if;
  delete from public.ent_restore_points p
  using jsonb_to_recordset(p_keys) as k(revision bigint, kind text)
  where p.user_id = v_uid and p.revision = k.revision and p.kind = k.kind;
end;
$$;

-- ---------------------------------------------------------------------------
-- ent_compact: drop history older than a checkpoint anchor (spec §15.3).
-- ---------------------------------------------------------------------------

create or replace function public.ent_compact(p_anchor bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ent_compact requires an authenticated session'
      using errcode = '28000';
  end if;
  -- Serialise with ent_submit for this account.
  perform 1 from public.ent_heads h where h.user_id = v_uid for update;
  if not exists (
    select 1 from public.ent_checkpoints c
    where c.user_id = v_uid and c.revision = p_anchor
  ) then
    raise exception 'no checkpoint at revision %', p_anchor using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.ent_restore_points p
    where p.user_id = v_uid and p.pinned and p.revision < p_anchor
  ) then
    raise exception 'a pinned restore point precedes revision %', p_anchor
      using errcode = '22000';
  end if;
  delete from public.ent_commits c where c.user_id = v_uid and c.revision <= p_anchor;
  delete from public.ent_checkpoints c where c.user_id = v_uid and c.revision < p_anchor;
  update public.ent_heads h
  set compacted_through = greatest(h.compacted_through, p_anchor)
  where h.user_id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.ent_submit(jsonb) from public, anon;
revoke all on function public.ent_put_checkpoint(jsonb) from public, anon;
revoke all on function public.ent_put_restore_point(bigint, text, text, boolean, text) from public, anon;
revoke all on function public.ent_delete_restore_points(jsonb) from public, anon;
revoke all on function public.ent_compact(bigint) from public, anon;

grant execute on function public.ent_submit(jsonb) to authenticated;
grant execute on function public.ent_put_checkpoint(jsonb) to authenticated;
grant execute on function public.ent_put_restore_point(bigint, text, text, boolean, text) to authenticated;
grant execute on function public.ent_delete_restore_points(jsonb) to authenticated;
grant execute on function public.ent_compact(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime hints (spec §19.3). ent_heads holds only revision metadata, so no
-- user data ever travels on the socket.
-- ---------------------------------------------------------------------------

alter table public.ent_heads replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ent_heads'
  ) then
    alter publication supabase_realtime add table public.ent_heads;
  end if;
end $$;
