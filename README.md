# Drive Tracker

A mobile-first web app for tracking drives with friends — live GPS trip
tracking, a map-first group view with live location sharing, a
leaderboard, hazard reporting, and a username-based friends system.

**Live app:** https://ironic0305.github.io/drive-tracker/

## Features

- **Tracker** — GPS trip tracking with a live speedometer, distance/speed
  stats, a 10-minute speed chart, and pause/resume.
- **Map + Group** — a dark, full-bleed map with a draggable bottom sheet.
  Create or join a group by invite code, share your live location (and
  optionally your speed) with the group, and see everyone's position on
  the map in real time.
- **Leaderboard** — ranks drivers by distance, top speed, or trip count,
  for this week / this month / all time.
- **Friends** — search by username, send/accept friend requests, and
  invite a friend for a drive (creates or reuses a shared group and
  notifies them live).
- **Hazard reports** — flag police, hazards, accidents, or traffic on the
  map, visible to your group for 30 minutes.
- Email/password accounts or anonymous guest sessions (guests get a
  random username so they're still findable by friends).

## Tech stack

Plain HTML/CSS/JS — no build step, no framework. [Leaflet](https://leafletjs.com/)
for the map, [Supabase](https://supabase.com/) for auth, Postgres data, and
Realtime (Presence, Broadcast, and Postgres Changes).

## Running it locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The Supabase project URL and
publishable key are already set in `script.js` — no `.env` or build
config needed.

## Database setup

All tables, RLS policies, and Realtime configuration live in
[`supabase-schema.sql`](./supabase-schema.sql). Paste the whole file into
the Supabase SQL editor and run it — it's written to be safe to re-run,
and only adds what's missing.

## Branches & deployment

GitHub Pages serves the live site from the **`production`** branch, not
`main`. The workflow:

- `main` — default branch, not deployed. Documentation and anything not
  tied to a specific feature area live here.
- `production` — what's actually live. Merge a feature branch in here
  when it's ready to ship.
- `tracker`, `map`, `leaderboard`, `group`, `friends` — one branch per
  feature area. Work for that area happens here and merges into
  `production` when it's ready, rather than every change going straight
  to the live branch.
