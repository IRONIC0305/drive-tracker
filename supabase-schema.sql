-- ============================================================================
-- Drive Tracker — real groups + live sharing + group leaderboard schema
-- ============================================================================
-- Paste this whole file into the Supabase SQL editor for project
-- jacsheofjgaysemerfln and run it once, top to bottom. It's written to be
-- safe to re-run (drops policies/functions before recreating them) except
-- for the `create table` statements — drop those manually first if you need
-- to re-run from scratch on a project that already has them.
--
-- After running this, also check the "Realtime transport" section near the
-- bottom — it configures Realtime Authorization for private per-group
-- channels, which is what live location sharing runs on.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  color        text not null,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique,
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);
alter table public.groups enable row level security;

-- Durable membership only. Deliberately NO "sharing" boolean column — whether
-- someone is currently broadcasting their location is ephemeral connection
-- state and belongs in Realtime Presence, not Postgres (a crashed tab would
-- otherwise leave a row stuck showing "sharing" forever).
create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.group_members enable row level security;

alter table public.trips enable row level security;

-- ----------------------------------------------------------------------------
-- 2. Helper functions (SECURITY DEFINER to dodge RLS self-recursion)
-- ----------------------------------------------------------------------------
-- A naive "you can see group_members rows for groups you belong to" policy,
-- written directly on group_members, references group_members from within
-- its own policy and Postgres rejects that with "infinite recursion detected
-- in policy for relation group_members". Routing the membership check
-- through a SECURITY DEFINER function sidesteps that, since the function
-- body runs with elevated privilege and isn't itself subject to RLS.

create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$$;

create or replace function public.user_shares_group_with(target_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.group_members gm1
    join public.group_members gm2 on gm1.group_id = gm2.group_id
    where gm1.user_id = auth.uid()
      and gm2.user_id = target_user
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. RLS policies
-- ----------------------------------------------------------------------------

drop policy if exists "members can view their groups" on public.groups;
drop policy if exists "creator can view their created groups" on public.groups;
drop policy if exists "authenticated users can create a group" on public.groups;

create policy "members can view their groups"
  on public.groups for select to authenticated
  using (id in (select group_id from public.group_members where user_id = auth.uid()));

-- Fixes a real gap: right after `insert into groups ... returning *`, the
-- creator has no group_members row yet (that insert happens a moment
-- later), so the membership-based policy above would make the INSERT's
-- RETURNING clause come back empty — Postgres applies SELECT policies to
-- RETURNING too. This second (OR'd) policy covers that instant.
create policy "creator can view their created groups"
  on public.groups for select to authenticated
  using (created_by = auth.uid());

create policy "authenticated users can create a group"
  on public.groups for insert to authenticated
  with check (created_by = auth.uid());

-- Deliberately NO broad/public select policy on groups. RLS filters rows,
-- not query predicates — any policy loose enough to let someone look up
-- *their* group by invite code would be equally loose for `select * from
-- groups`, leaking every group's name and code to every logged-in user.
-- Joining by code goes through the join_group_by_code() RPC below instead,
-- which runs as the table owner and bypasses RLS internally.

drop policy if exists "members can view fellow members" on public.group_members;
drop policy if exists "users can add themselves to a group" on public.group_members;
drop policy if exists "users can remove themselves from a group" on public.group_members;

create policy "members can view fellow members"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

create policy "users can add themselves to a group"
  on public.group_members for insert to authenticated
  with check (user_id = auth.uid());

create policy "users can remove themselves from a group"
  on public.group_members for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "select own profile" on public.profiles;
drop policy if exists "select groupmates profiles" on public.profiles;
drop policy if exists "upsert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;

create policy "select own profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy "select groupmates profiles"
  on public.profiles for select to authenticated
  using (public.user_shares_group_with(id));

create policy "upsert own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid());

drop policy if exists "insert own trips" on public.trips;
drop policy if exists "select own trips" on public.trips;
drop policy if exists "select groupmates trips" on public.trips;

create policy "insert own trips"
  on public.trips for insert to authenticated
  with check (user_id = auth.uid());

create policy "select own trips"
  on public.trips for select to authenticated
  using (user_id = auth.uid());

-- Two permissive SELECT policies on the same table are OR'd by Postgres, so
-- together these two give "your own trips, or a groupmate's trips" — which
-- is exactly what the group-scoped leaderboard query needs. Trade-off, made
-- explicit: this lets group members see each other's individual trip rows
-- (distance + timestamp), which is a reasonable, expected thing inside a
-- trusted car-meet group. If that stops being true, tighten this by
-- dropping this policy and replacing the client-side leaderboard query with
-- a SECURITY DEFINER RPC that returns only pre-aggregated per-user totals.
create policy "select groupmates trips"
  on public.trips for select to authenticated
  using (public.user_shares_group_with(user_id));

-- ----------------------------------------------------------------------------
-- 4. Join-by-invite-code RPC
-- ----------------------------------------------------------------------------

create or replace function public.join_group_by_code(p_code text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
begin
  select * into g from public.groups where invite_code = upper(trim(p_code));
  if not found then
    raise exception 'No group found with that invite code';
  end if;

  insert into public.group_members (group_id, user_id)
  values (g.id, auth.uid())
  on conflict (group_id, user_id) do nothing;

  return g;
end;
$$;

revoke all on function public.join_group_by_code(text) from public;
grant execute on function public.join_group_by_code(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Realtime transport for live location — Broadcast + Presence
-- ----------------------------------------------------------------------------
-- Live location intentionally does NOT get a table. For 10-15 people
-- broadcasting a GPS fix every ~2s for about an hour, a `live_locations`
-- table + Postgres Changes would mean a durable write for every tick of
-- data nobody wants retained past the meet, plus materially higher latency
-- than Broadcast. Presence also gives connection-drop detection for free —
-- a closed tab or dead network auto-clears that user's presence, no manual
-- "last_seen" sweep needed to make a stale marker disappear.
--
-- This policy makes each group's Realtime channel private: only that
-- group's members can join the `group:<group_id>` topic to broadcast or
-- receive locations / presence for it.
--
-- NOTE: Realtime Authorization is a newer Supabase feature — if this
-- statement errors, check the current Supabase docs for whether the
-- `realtime.messages` table name or `realtime.topic()` helper have moved,
-- and adjust accordingly. The pattern (RLS on realtime.messages, keyed by
-- topic, delegating to is_group_member) is what matters.

drop policy if exists "group members can use their group's realtime channel" on realtime.messages;

create policy "group members can use their group's realtime channel"
  on realtime.messages for all to authenticated
  using (
    public.is_group_member((split_part(realtime.topic(), ':', 2))::uuid, auth.uid())
  )
  with check (
    public.is_group_member((split_part(realtime.topic(), ':', 2))::uuid, auth.uid())
  );
