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

-- ----------------------------------------------------------------------------
-- 6. Realtime transport for group membership changes — Postgres Changes
-- ----------------------------------------------------------------------------
-- Unlike live location, membership changes are rare (someone joins/leaves)
-- and already live in a durable table, so Postgres Changes — not
-- Broadcast — is the right fit: the client just needs to know "something
-- changed, re-fetch the member list," not a high-frequency data stream.
--
-- This table must be added to the supabase_realtime publication for those
-- change events to fire at all. RLS on group_members (section 3 above)
-- already scopes who receives which rows' change events, same as any
-- other read. Wrapped in a check since, unlike `create policy`,
-- `alter publication ... add table` errors (doesn't no-op) if the table
-- is already a member — this keeps the file safe to re-run.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'group_members'
  ) then
    alter publication supabase_realtime add table public.group_members;
  end if;
end $$;

-- ============================================================================
-- 7. Usernames — unique, public, visible to every signed-in user
-- ============================================================================
-- Nullable: existing profiles predate this column and won't have one until
-- the app prompts them to set one. Format: 3-20 chars, lowercase a-z/0-9/_
-- (the app normalizes to lowercase before ever writing this column).

alter table public.profiles add column if not exists username text;

alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,20}$');

-- A unique INDEX rather than a unique column constraint, specifically so it
-- allows multiple NULLs (every pre-existing profile) while still enforcing
-- true uniqueness the moment a real value is set.
drop index if exists profiles_username_idx;
create unique index profiles_username_idx on public.profiles (username);

-- Usernames are explicitly public — broadens profile visibility from "your
-- own / a groupmate's" to "any signed-in user," which is what username
-- search for Add Friend needs. The narrower policies above stay in place
-- too (redundant now, but harmless — Postgres OR's permissive policies).
drop policy if exists "select all profiles" on public.profiles;
create policy "select all profiles"
  on public.profiles for select to authenticated
  using (true);

-- ============================================================================
-- 8. Friend requests — the only source of truth for "are these two friends"
-- ============================================================================
-- No separate `friendships` table: two people are friends exactly when an
-- accepted row exists between them (either direction). One row per pair,
-- never two — the unique constraint blocks a duplicate even if sent in the
-- other direction's column order wouldn't naturally collide on its own (the
-- app checks both directions before inserting; this is the hard backstop).

create table if not exists public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_not_self check (requester_id <> addressee_id),
  constraint friend_requests_unique_pair unique (requester_id, addressee_id)
);
alter table public.friend_requests enable row level security;

drop policy if exists "see my friend requests" on public.friend_requests;
drop policy if exists "send friend requests" on public.friend_requests;
drop policy if exists "respond to friend requests" on public.friend_requests;
drop policy if exists "remove friend requests" on public.friend_requests;

create policy "see my friend requests"
  on public.friend_requests for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy "send friend requests"
  on public.friend_requests for insert to authenticated
  with check (requester_id = auth.uid());

-- Only the addressee can accept/decline — the requester doesn't get to
-- flip their own pending request to "accepted".
create policy "respond to friend requests"
  on public.friend_requests for update to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

-- Either side can remove a request/friendship — cancelling a sent request,
-- declining by deleting instead of marking declined, or unfriending later.
create policy "remove friend requests"
  on public.friend_requests for delete to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'friend_requests'
  ) then
    alter publication supabase_realtime add table public.friend_requests;
  end if;
end $$;

-- ============================================================================
-- 9. Drive invites — "invite a friend for a drive"
-- ============================================================================
-- Deliberately reuses the existing group/invite-code machinery instead of
-- building a parallel location-sharing system: accepting an invite just
-- calls the same join_group_by_code() RPC every manual invite-code entry
-- already uses. invite_code is copied onto the row at creation time (not
-- looked up via group_id at accept time) so the recipient never needs
-- their own SELECT access to the `groups` table, which is deliberately
-- locked down — see the comment in section 3 above.

create table if not exists public.drive_invites (
  id           uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references auth.users(id) on delete cascade,
  to_user_id   uuid not null references auth.users(id) on delete cascade,
  group_id     uuid not null references public.groups(id) on delete cascade,
  invite_code  text not null,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  constraint drive_invites_not_self check (from_user_id <> to_user_id)
);
alter table public.drive_invites enable row level security;

drop policy if exists "see my drive invites" on public.drive_invites;
drop policy if exists "send drive invites" on public.drive_invites;
drop policy if exists "respond to drive invites" on public.drive_invites;

create policy "see my drive invites"
  on public.drive_invites for select to authenticated
  using (from_user_id = auth.uid() or to_user_id = auth.uid());

create policy "send drive invites"
  on public.drive_invites for insert to authenticated
  with check (from_user_id = auth.uid());

create policy "respond to drive invites"
  on public.drive_invites for update to authenticated
  using (to_user_id = auth.uid())
  with check (to_user_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'drive_invites'
  ) then
    alter publication supabase_realtime add table public.drive_invites;
  end if;
end $$;

-- ============================================================================
-- 10. Realtime transport for a personal channel — incoming friend requests
-- and drive invites, live, without a reload
-- ============================================================================
-- Same pattern as section 5's per-group channel: makes each user's own
-- `user:<user_id>` topic private to them, so the client can subscribe to
-- postgres_changes on friend_requests/drive_invites as soon as something
-- involving them changes, instead of only refreshing on tab-open.

drop policy if exists "users can use their own personal realtime channel" on realtime.messages;

create policy "users can use their own personal realtime channel"
  on realtime.messages for all to authenticated
  using (realtime.topic() = 'user:' || auth.uid()::text)
  with check (realtime.topic() = 'user:' || auth.uid()::text);

-- ============================================================================
-- 11. Backfill: assign a username to every existing profile that doesn't
-- have one yet
-- ============================================================================
-- Anyone who signed up or joined as a guest before this feature shipped has
-- a profile row with username = null — they're correctly prompted to pick
-- one next time they open the app (see the username banner), but until
-- they do, nobody can find or add them. This assigns each of them a random
-- one right now instead, the same scheme ensureProfile() uses for new
-- guests, so search works immediately for the whole existing user base.
-- Safe to re-run — only ever touches rows where username is still null.

do $$
declare
  rec record;
  candidate text;
  adjectives text[] := array['swift','turbo','night','rapid','cruise','drift','nimble','blaze','silent','steady'];
  nouns text[] := array['driver','racer','rider','wheels','engine','throttle','cruiser','pilot','voyager','roadster'];
  tries int;
begin
  for rec in select id from public.profiles where username is null loop
    tries := 0;
    loop
      candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
                || nouns[1 + floor(random() * array_length(nouns, 1))::int]
                || (10 + floor(random() * 80))::int::text;
      begin
        update public.profiles set username = candidate where id = rec.id;
        exit;
      exception when unique_violation then
        tries := tries + 1;
        exit when tries > 10; -- extremely unlikely; don't loop forever over one row
      end;
    end loop;
  end loop;
end $$;

-- ============================================================================
-- 12. TEMPORARY — leaderboard shows every signed-up user, not just groupmates
-- ============================================================================
-- Explicitly requested as a "for the time being" change. This is a real
-- privacy broadening from the original design (see the comment on "select
-- groupmates trips" above, section 3): every authenticated user can now see
-- every other user's individual trip rows (distance, top speed, timestamp),
-- not just a groupmate's. To revert: drop this policy — "select own
-- trips" and "select groupmates trips" stay in place underneath it, so
-- dropping this alone puts trip visibility straight back to how it was.

drop policy if exists "select all trips (temporary)" on public.trips;

create policy "select all trips (temporary)"
  on public.trips for select to authenticated
  using (true);
