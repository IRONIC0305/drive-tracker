// Drive Tracker — trip tracking + live stats

// ============================================================================
// SUPABASE CONFIG  (real backend for everything: auth, trips, groups, live
// sharing via Realtime Broadcast/Presence, and the group leaderboard)
// ============================================================================
// supabase-js v2 is loaded from a CDN <script> in index.html, which puts a
// global `supabase` object on the page. createClient(projectUrl, key) — the
// key is Supabase's new "publishable key", which replaces what used to be
// called the "anon" key. It goes in exactly the same place.
//
// Find both values in the Supabase dashboard: Project Settings -> API Keys.
//   - Project URL           -> SUPABASE_URL below
//   - "Publishable key"      -> SUPABASE_PUBLISHABLE_KEY below
//                               (it starts with  sb_publishable_...)
//
// SECURITY: never put the *secret* key (starts with sb_secret_, formerly the
// service_role key) in this file. It bypasses row-level security and this
// file is served to the browser and committed to git.
//
// The schema, RLS policies, and Realtime Authorization needed for groups and
// live sharing live in supabase-schema.sql (run once in the Supabase SQL
// editor) — not in this file, since this project has no migration tooling.
const SUPABASE_URL = 'https://jacsheofjgaysemerfln.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_AqA40yERnQIfhGnJvebYzQ_A91uk-9X';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let watchId = null;
let tripPoints = [];
let startTime = null;
let timerId = null;
let topSpeed = 0; // highest km/h seen so far this trip
let currentUserId = null; // set by onAuthStateChange / getSession, cleared on logout

// Grab the elements we update
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const distanceEl = document.getElementById('distance');
const durationEl = document.getElementById('duration');
const avgSpeedEl = document.getElementById('avgSpeed');
const curSpeedEl = document.getElementById('curSpeed');
const topSpeedEl = document.getElementById('topSpeed');
const pointsEl = document.getElementById('points');
const saveErrorEl = document.getElementById('saveError');
const tripHistoryListEl = document.getElementById('tripHistoryList');
const tripHistoryErrorEl = document.getElementById('tripHistoryError');

// View switching + leaderboard + map + group
const tabTrackerEl = document.getElementById('tabTracker');
const tabLeaderboardEl = document.getElementById('tabLeaderboard');
const tabMapEl = document.getElementById('tabMap');
const tabGroupEl = document.getElementById('tabGroup');
const trackerViewEl = document.getElementById('trackerView');
const leaderboardViewEl = document.getElementById('leaderboardView');
const mapViewEl = document.getElementById('mapView');
const groupViewEl = document.getElementById('groupView');
const groupBodyEl = document.getElementById('groupBody');
const leaderboardListEl = document.getElementById('leaderboardList');
const leaderboardRangeEl = document.getElementById('leaderboardRange');
const shareToggleEl = document.getElementById('shareToggle');
const shareStatusEl = document.getElementById('shareStatus');
const mapEmptyStateEl = document.getElementById('mapEmptyState');

// --- Math helpers -----------------------------------------------------------

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateTripStats(points) {
  if (points.length < 2) {
    return { distanceKm: 0, durationMin: 0, avgSpeedKmh: 0 };
  }

  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += calculateDistance(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat, points[i].lng
    );
  }

  const durationMs = points[points.length - 1].timestamp - points[0].timestamp;
  const durationMin = durationMs / 1000 / 60;
  const avgSpeedKmh = durationMin > 0 ? (totalDistance / (durationMin / 60)) : 0;

  return {
    distanceKm: totalDistance.toFixed(2),
    durationMin: durationMin.toFixed(1),
    avgSpeedKmh: avgSpeedKmh.toFixed(1)
  };
}

// --- UI helpers -----------------------------------------------------------

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status status--' + kind;
}

// Play the one-time "ignition" pulse on the status indicator. Removing the
// class on animationend lets it re-trigger on the next trip.
function igniteStatus() {
  statusEl.classList.remove('status--ignite');
  void statusEl.offsetWidth; // force reflow so the animation restarts
  statusEl.classList.add('status--ignite');
}

statusEl.addEventListener('animationend', () => {
  statusEl.classList.remove('status--ignite');
});

// Turn milliseconds into "M:SS" (or "H:MM:SS" once past an hour)
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function resetStats() {
  distanceEl.textContent = '0.00';
  durationEl.textContent = '0:00';
  avgSpeedEl.textContent = '0.0';
  curSpeedEl.textContent = '0.0';
  topSpeedEl.textContent = '0.0';
  pointsEl.textContent = '0';
}

// Redraw the numbers from the current trip data
function refreshStats() {
  pointsEl.textContent = tripPoints.length;

  if (startTime) {
    durationEl.textContent = formatDuration(Date.now() - startTime);
  }

  const stats = calculateTripStats(tripPoints);
  distanceEl.textContent = stats.distanceKm;
  avgSpeedEl.textContent = stats.avgSpeedKmh;
}

// Current speed: use the GPS-reported speed if we have it, otherwise
// estimate it from the last two points.
function currentSpeedKmh(position) {
  if (position.coords.speed != null && !Number.isNaN(position.coords.speed)) {
    return position.coords.speed * 3.6; // m/s -> km/h
  }

  if (tripPoints.length < 2) return 0;

  const a = tripPoints[tripPoints.length - 2];
  const b = tripPoints[tripPoints.length - 1];
  const km = calculateDistance(a.lat, a.lng, b.lat, b.lng);
  const hours = (b.timestamp - a.timestamp) / 1000 / 3600;
  return hours > 0 ? km / hours : 0;
}

// --- Trip History (real — Supabase `trips` table) --------------------------

function showSaveError(text) {
  saveErrorEl.textContent = text;
  saveErrorEl.hidden = false;
}

function hideSaveError() {
  saveErrorEl.hidden = true;
  saveErrorEl.textContent = '';
}

function showTripHistoryError(text) {
  tripHistoryErrorEl.textContent = text;
  tripHistoryErrorEl.hidden = false;
}

function hideTripHistoryError() {
  tripHistoryErrorEl.hidden = true;
  tripHistoryErrorEl.textContent = '';
}

// Whether the logged-in user has ever completed a trip — drives the Map
// tab's empty state. Starts true (empty state hidden) so nothing flashes
// before the first history load resolves; set for real once it does.
let hasSavedTrips = true;

function updateMapEmptyState() {
  mapEmptyStateEl.hidden = hasSavedTrips;
}

// Insert the just-finished trip as a row in `trips`, then refresh the list.
async function saveTrip(stats) {
  if (!currentUserId) return;
  hideSaveError();

  const { error } = await supabaseClient.from('trips').insert({
    user_id: currentUserId,
    distance_km: parseFloat(stats.distanceKm),
    duration_min: parseFloat(stats.durationMin),
    avg_speed_kmh: parseFloat(stats.avgSpeedKmh),
    top_speed_kmh: Number(topSpeed.toFixed(1)),
  });

  if (error) {
    console.error('Trip save failed:', error);
    showSaveError("Couldn't save this trip — " + (error.message || 'try again later') + '.');
    return;
  }

  loadTripHistory();
  loadGroupLeaderboard(); // this trip may change your group's leaderboard totals
}

// Pull the logged-in user's past trips, most recent first, and render them.
async function loadTripHistory() {
  if (!currentUserId) return;

  hideTripHistoryError();
  tripHistoryListEl.innerHTML = '<p class="hint">Loading…</p>';

  const { data, error } = await supabaseClient
    .from('trips')
    .select('distance_km, top_speed_kmh, created_at')
    .eq('user_id', currentUserId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Trip history load failed:', error);
    tripHistoryListEl.innerHTML = '';
    showTripHistoryError("Couldn't load trip history — " + (error.message || 'try again later') + '.');
    return;
  }

  hasSavedTrips = (data || []).length > 0;
  updateMapEmptyState();
  renderTripHistory(data || []);
}

function renderTripHistory(trips) {
  if (trips.length === 0) {
    tripHistoryListEl.innerHTML = '<p class="hint">No trips yet — start your first one!</p>';
    return;
  }

  tripHistoryListEl.innerHTML = trips.map((trip) => {
    const when = new Date(trip.created_at);
    const dateStr = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return `
      <div class="trip-row">
        <span class="trip-row__date">${dateStr} &middot; ${timeStr}</span>
        <span class="trip-row__stats">
          <span><strong>${Number(trip.distance_km).toFixed(2)}</strong> km</span>
          <span><strong>${Number(trip.top_speed_kmh).toFixed(1)}</strong> km/h top</span>
        </span>
      </div>`;
  }).join('');
}

// --- View switching ----------------------------------------------------------

// Every tab: which button activates it and which section it shows.
const VIEWS = {
  tracker:     { tab: tabTrackerEl,     section: trackerViewEl },
  leaderboard: { tab: tabLeaderboardEl, section: leaderboardViewEl },
  map:         { tab: tabMapEl,         section: mapViewEl },
  group:       { tab: tabGroupEl,       section: groupViewEl },
};

let currentView = 'tracker';

function showView(name) {
  if (name === currentView || !VIEWS[name]) return;

  const leavingSection = VIEWS[currentView].section;
  const enteringSection = VIEWS[name].section;

  for (const [key, view] of Object.entries(VIEWS)) {
    view.tab.classList.toggle('tab--active', key === name);
  }

  // Crossfade: fade the current view out, swap, fade the next one in.
  leavingSection.classList.add('view--exit');

  setTimeout(() => {
    leavingSection.classList.remove('view--exit');
    leavingSection.hidden = true;

    enteringSection.hidden = false;
    enteringSection.classList.add('view--enter');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => enteringSection.classList.remove('view--enter'));
    });

    currentView = name;

    // Leaflet can't measure a map that was hidden when it was created, so
    // build it (once) and re-measure every time the Map tab is shown.
    if (name === 'map') {
      ensureMap();
      setTimeout(() => {
        map.invalidateSize();
        if (tripRouteBounds) map.fitBounds(tripRouteBounds, { padding: [30, 30] });
      }, 120);
    }

    // Pull fresh totals every time the tab is opened — a groupmate's trip
    // saved while you were elsewhere wouldn't otherwise show up until some
    // other refresh trigger (your own trip, a range change, rejoining).
    if (name === 'leaderboard') {
      loadGroupLeaderboard();
    }
  }, 160);
}

tabTrackerEl.addEventListener('click', () => showView('tracker'));
tabLeaderboardEl.addEventListener('click', () => showView('leaderboard'));
tabMapEl.addEventListener('click', () => showView('map'));
tabGroupEl.addEventListener('click', () => showView('group'));

updateMapEmptyState();

// --- Map: setup + your trip route (PART 1) ----------------------------------
// Real data: this section draws the GPS points captured during a trip.

// Neutral fallback view — the whole world, zoomed out — used until
// geolocation resolves, or permanently if it's denied/unavailable. Never
// falls back to a specific hardcoded city.
let MAP_CENTER = [20, 0];
const WORLD_ZOOM = 2;
const USER_ZOOM = 13;

let map = null;
let routeLayer = null;       // holds the polyline + start/end markers
let friendLayer = null;      // holds the live group-member markers
let meMarker = null;         // the "You" marker, shown only while sharing
let tripRouteBounds = null;  // map bounds of the last drawn route

// Create the Leaflet map once, on first visit to the Map tab.
function ensureMap() {
  if (map) return;

  map = L.map('map').setView(MAP_CENTER, WORLD_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  friendLayer = L.layerGroup().addTo(map);

  centerMapOnUser();
  rebuildFriendMarkers(); // no-op until you're in a group with someone sharing
  updateMeMarker();
}

// Recenter on the browser's current-position fix, once, on map creation.
// Silently keeps the neutral world view if permission is denied or the
// device has no GPS. A real trip route already on screen takes priority.
function centerMapOnUser() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      MAP_CENTER = [position.coords.latitude, position.coords.longitude];
      if (!tripRouteBounds) {
        map.setView(MAP_CENTER, USER_ZOOM);
      }
    },
    () => {
      // Denied or unavailable — MAP_CENTER stays the neutral world view.
    },
    { maximumAge: 5 * 60 * 1000 }
  );
}

// A small round pin with initials + a name label, used for group members and "You".
function makePin(name, color) {
  const initials = name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return L.divIcon({
    className: 'map-pin-wrap',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html:
      `<span class="map-pin" style="--pin:${color}">` +
        `<span class="map-pin__dot">${initials}</span>` +
        `<span class="map-pin__label">${name}</span>` +
      `</span>`,
  });
}

// Draw the just-finished trip: connected line + green start / red end markers.
function renderTripRoute() {
  ensureMap();
  routeLayer.clearLayers();
  tripRouteBounds = null;

  if (tripPoints.length < 2) return;

  const latlngs = tripPoints.map((p) => [p.lat, p.lng]);

  const line = L.polyline(latlngs, { color: '#E0A542', weight: 4 });
  routeLayer.addLayer(line);

  routeLayer.addLayer(
    L.circleMarker(latlngs[0], {
      radius: 8, color: '#16181C', weight: 2, fillColor: '#E0A542', fillOpacity: 1,
    }).bindPopup('Start')
  );
  routeLayer.addLayer(
    L.circleMarker(latlngs[latlngs.length - 1], {
      radius: 8, color: '#16181C', weight: 2, fillColor: '#EDEDEA', fillOpacity: 1,
    }).bindPopup('Finish')
  );

  tripRouteBounds = line.getBounds();

  // If the map is already on screen, fit it to the new route right away.
  if (!mapViewEl.hidden) {
    map.invalidateSize();
    map.fitBounds(tripRouteBounds, { padding: [30, 30] });
  }
}

// ============================================================================
// GROUPS & LIVE SHARING  (real — Supabase `groups`/`group_members`/`profiles`
// tables for membership, Realtime Broadcast + Presence for live location)
// ----------------------------------------------------------------------------
// See supabase-schema.sql for the tables, RLS policies, the
// join_group_by_code() RPC, and the Realtime Authorization policy this
// section depends on.
// ============================================================================

// A small fixed palette, deterministically hashed from each user's id so
// their pin color is stable across devices/sessions without coordination.
const PIN_COLORS = ['#9BC7D1', '#7FB7C4', '#6BA9B6', '#B7D6DE', '#D98C8C', '#C7A9D1', '#A9C7A0', '#D9BE8C'];

function colorForUserId(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PIN_COLORS[hash % PIN_COLORS.length];
}

let myProfile = null;          // { display_name, color } for the logged-in user
let myGroup = null;            // { id, name, invite_code, created_by }, or null
let groupMembersCache = [];    // [{ profile: { id, display_name, color }, isMe }]
let presenceState = {};        // userId -> true, who currently has sharing ON
let friendPositions = {};      // userId -> [lat, lng], last broadcast position received
let friendMarkers = {};        // userId -> Leaflet marker
let myGroupChannel = null;     // the Realtime channel for the current group
let isSharingLocation = false; // mirrors YOUR toggle
let myLivePos = null;          // your own last GPS fix while sharing
let shareWatchId = null;       // geolocation watch dedicated to broadcasting
let lastBroadcastAt = 0;

const BROADCAST_INTERVAL_MS = 2000;

// Ensure a `profiles` row exists for the logged-in user. Display name comes
// from signup metadata (falls back to the email's local-part); color is
// deterministic from the user id. `ignoreDuplicates` means this never
// clobbers a name/color after the first write.
async function ensureProfile(session) {
  const meta = session.user.user_metadata || {};
  const fallback = (session.user.email || '').split('@')[0] || 'Driver';
  const displayName = (meta.display_name && meta.display_name.trim()) || fallback;
  const color = colorForUserId(session.user.id);

  const { error: upsertError } = await supabaseClient
    .from('profiles')
    .upsert({ id: session.user.id, display_name: displayName, color }, { onConflict: 'id', ignoreDuplicates: true });

  if (upsertError) {
    console.error('Profile upsert failed:', upsertError);
  }

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('display_name, color')
    .eq('id', session.user.id)
    .single();

  if (error) {
    console.error('Profile load failed:', error);
    myProfile = { display_name: displayName, color };
  } else {
    myProfile = data;
  }
}

// Restore which group you're in (if any) after login/refresh — you can only
// be in one group at a time in this app.
async function loadMyGroup() {
  const { data, error } = await supabaseClient
    .from('group_members')
    .select('groups(id, name, invite_code, created_by)')
    .eq('user_id', currentUserId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Load group failed:', error);
    myGroup = null;
    return;
  }

  myGroup = (data && data.groups) || null;
}

// group_members rows for one group, resolved against `profiles`.
// Returns [{ profile, isMe }]; skips any member with no profile row.
async function groupMembers(groupId) {
  const { data, error } = await supabaseClient
    .from('group_members')
    .select('user_id, profiles(id, display_name, color)')
    .eq('group_id', groupId);

  if (error) {
    console.error('Load group members failed:', error);
    return [];
  }

  return (data || [])
    .filter((m) => m.profiles)
    .map((m) => ({
      profile: m.profiles,
      isMe: m.user_id === currentUserId,
    }));
}

// --- Live friend markers on the map (PART 4) -------------------------------
// A moving marker is shown ONLY for group members (not you) who are
// currently present (sharing) on the group's Realtime channel AND whose
// first position fix has arrived. Members who are off get no marker at
// all — a greyed-out pin would leak "this person exists but is hiding",
// which defeats the off switch.

// The people who should currently have a marker.
function visibleGroupMembers() {
  return groupMembersCache
    .filter((m) => !m.isMe && presenceState[m.profile.id])
    .map((m) => m.profile);
}

// Rebuild all friend markers from scratch. Safe to call whenever the group or
// presence state changes; a no-op until the map has been created.
function rebuildFriendMarkers() {
  if (!friendLayer) return;

  friendLayer.clearLayers();
  friendMarkers = {};

  visibleGroupMembers().forEach((profile) => {
    const pos = friendPositions[profile.id];
    if (!pos) return; // present but no GPS fix received yet
    const marker = L.marker(pos, { icon: makePin(profile.display_name, profile.color) }).addTo(friendLayer);
    friendMarkers[profile.id] = marker;
  });
}

// A single broadcast tick from a group member — cheaper than a full rebuild.
function updateFriendMarker(payload) {
  const { user_id: userId, lat, lng } = payload;
  if (!userId || userId === currentUserId) return; // ignore malformed/self payloads

  friendPositions[userId] = [lat, lng];
  if (!presenceState[userId]) return; // not currently marked as sharing

  const member = groupMembersCache.find((m) => m.profile.id === userId);
  if (!member) return; // not a member of the group we're currently viewing

  if (!friendLayer) return;

  if (friendMarkers[userId]) {
    friendMarkers[userId].setLatLng([lat, lng]);
  } else {
    friendMarkers[userId] = L.marker([lat, lng], {
      icon: makePin(member.profile.display_name, member.profile.color),
    }).addTo(friendLayer);
  }
}

// --- Realtime channel lifecycle ---------------------------------------------

function joinGroupChannel(groupId) {
  myGroupChannel = supabaseClient.channel(`group:${groupId}`, {
    config: { private: true, presence: { key: currentUserId } },
  });

  myGroupChannel.on('presence', { event: 'sync' }, () => {
    const state = myGroupChannel.presenceState();
    presenceState = {};
    Object.keys(state).forEach((userId) => { presenceState[userId] = true; });
    rebuildFriendMarkers();
    if (currentView === 'group') renderGroup(); // refresh the "Sharing live" pills
  });

  myGroupChannel.on('broadcast', { event: 'location' }, ({ payload }) => {
    updateFriendMarker(payload);
  });

  myGroupChannel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error('Group realtime channel error:', status);
    }
  });
}

function leaveGroupChannel() {
  if (!myGroupChannel) return;

  myGroupChannel.untrack();
  supabaseClient.removeChannel(myGroupChannel);
  myGroupChannel = null;
  presenceState = {};
  friendPositions = {};
  friendMarkers = {};
  if (friendLayer) friendLayer.clearLayers();
}

// --- Group view: setup screen + in-group screen ---------------------------

function renderGroup() {
  if (myGroup) {
    renderGroupHome();
  } else {
    renderGroupSetup();
  }
}

// No group yet — offer Create or Join.
function renderGroupSetup() {
  groupBodyEl.innerHTML = `
    <div class="panel">
      <h3 class="panel__title">Create a Group</h3>
      <p class="panel__hint">Start a group and get an invite code to share with friends.</p>
      <input class="field" id="createName" type="text" placeholder="Group name" maxlength="30" autocomplete="off">
      <button class="btn btn--start btn--block" id="createBtn" type="button">Create Group</button>
    </div>
    <div class="panel">
      <h3 class="panel__title">Join a Group</h3>
      <p class="panel__hint">Enter a 6-character invite code from a friend.</p>
      <input class="field field--code" id="joinCode" type="text" placeholder="X7K2P9" maxlength="6" autocomplete="off">
      <p class="auth__error" id="joinError" hidden></p>
      <button class="btn btn--ghost btn--block" id="joinBtn" type="button">Join Group</button>
    </div>`;

  groupBodyEl.querySelector('#createBtn').addEventListener('click', handleCreateGroup);
  groupBodyEl.querySelector('#joinBtn').addEventListener('click', handleJoinGroup);
}

// In a group — name, invite code, member list, leave.
function renderGroupHome() {
  const members = groupMembersCache;

  groupBodyEl.innerHTML = `
    <div class="group__header">
      <h3 class="group__name">${myGroup.name}</h3>
      <div class="group__code-row">
        <span class="group__code-label">Invite code</span>
        <span class="group__code">${myGroup.invite_code}</span>
        <button class="btn btn--ghost btn--sm" id="copyCodeBtn" type="button">Copy code</button>
        <button class="btn btn--start btn--sm" id="inviteBtn" type="button">Invite</button>
      </div>
    </div>

    <h4 class="group__section-title">Members &middot; ${members.length}</h4>
    <div class="leaderboard__list">
      ${members.map(renderMemberRow).join('')}
    </div>

    <button class="btn btn--stop btn--block" id="leaveBtn" type="button" style="margin-top: 14px;">Leave Group</button>`;

  groupBodyEl.querySelector('#copyCodeBtn').addEventListener('click', handleCopyCode);
  groupBodyEl.querySelector('#inviteBtn').addEventListener('click', handleInvite);
  groupBodyEl.querySelector('#leaveBtn').addEventListener('click', handleLeaveGroup);
}

// One member row — reuses the leaderboard's .friend styling for consistency.
function renderMemberRow({ profile, isMe }) {
  const sharing = !!presenceState[profile.id] || (isMe && isSharingLocation);
  return `
    <div class="friend">
      <div class="friend__body">
        <span class="friend__name">${profile.display_name}${isMe ? ' <span class="tag">You</span>' : ''}</span>
      </div>
      <span class="live-pill ${sharing ? 'live-pill--on' : 'live-pill--off'}">${sharing ? 'Sharing live' : 'Location off'}</span>
    </div>`;
}

// --- Group actions ----------------------------------------------------------

// Six visually-unambiguous characters (no 0/O/1/I) — e.g. "X7K2P9".
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function showGroupSetupError(text) {
  const el = groupBodyEl.querySelector('#joinError');
  if (el) {
    el.textContent = text;
    el.hidden = false;
  }
}

function hideGroupSetupError() {
  const el = groupBodyEl.querySelector('#joinError');
  if (el) {
    el.hidden = true;
    el.textContent = '';
  }
}

async function handleCreateGroup() {
  const name = (groupBodyEl.querySelector('#createName').value || '').trim() || 'My Group';
  const createBtn = groupBodyEl.querySelector('#createBtn');
  createBtn.disabled = true;
  hideGroupSetupError();

  let inserted = null;
  let lastError = null;

  // A generated code colliding with an existing one is rare but possible —
  // retry a few times on a unique-violation (Postgres code 23505) before
  // giving up.
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const { data, error } = await supabaseClient
      .from('groups')
      .insert({ name, invite_code: generateInviteCode(), created_by: currentUserId })
      .select()
      .single();

    if (error) {
      lastError = error;
      if (error.code !== '23505') break;
    } else {
      inserted = data;
    }
  }

  if (!inserted) {
    showGroupSetupError((lastError && lastError.message) || 'Could not create group — try again.');
    createBtn.disabled = false;
    return;
  }

  const { error: memberError } = await supabaseClient
    .from('group_members')
    .insert({ group_id: inserted.id, user_id: currentUserId });

  if (memberError) {
    console.error('Join own group failed:', memberError);
    showGroupSetupError(memberError.message);
    createBtn.disabled = false;
    return;
  }

  myGroup = inserted;
  await onGroupChanged();
}

async function handleJoinGroup() {
  const codeInput = groupBodyEl.querySelector('#joinCode');
  const code = (codeInput.value || '').trim();
  const joinBtn = groupBodyEl.querySelector('#joinBtn');

  hideGroupSetupError();
  if (!code) {
    showGroupSetupError('Enter an invite code.');
    return;
  }

  joinBtn.disabled = true;
  const { data, error } = await supabaseClient.rpc('join_group_by_code', { p_code: code });
  joinBtn.disabled = false;

  if (error) {
    showGroupSetupError(error.message || "Couldn't join that group.");
    return;
  }

  myGroup = data;
  await onGroupChanged();
}

async function handleLeaveGroup() {
  if (!myGroup) return;

  const { error } = await supabaseClient
    .from('group_members')
    .delete()
    .eq('group_id', myGroup.id)
    .eq('user_id', currentUserId);

  if (error) {
    console.error('Leave group failed:', error);
  }

  myGroup = null;
  shareToggleEl.checked = false;
  await onGroupChanged();
}

function handleCopyCode() {
  const btn = groupBodyEl.querySelector('#copyCodeBtn');
  copyText(myGroup.invite_code).then((ok) => {
    btn.textContent = ok ? 'Copied' : 'Press ⌘C';
    setTimeout(() => { btn.textContent = 'Copy code'; }, 1500);
  });
}

// Invite a new person to the group — native share sheet where available
// (mobile Safari/Chrome), falling back to copying a ready-to-send message.
// The link carries ?join=CODE, which consumeInviteLinkIfAny() picks up and
// auto-joins on the other end — no manual code entry needed.
async function handleInvite() {
  const btn = groupBodyEl.querySelector('#inviteBtn');
  const message = `Join my group "${myGroup.name}" on Drive Tracker!`;

  btn.disabled = true;
  btn.textContent = 'Invite…';
  const link = await shortenLink(buildInviteLink(myGroup.invite_code));
  btn.disabled = false;
  btn.textContent = 'Invite';

  if (navigator.share) {
    navigator.share({ title: 'Drive Tracker invite', text: message, url: link }).catch(() => {
      // User cancelled the share sheet or it failed silently — no fallback needed.
    });
    return;
  }

  copyText(`${message} ${link}`).then((ok) => {
    btn.textContent = ok ? 'Invite copied' : 'Press ⌘C';
    setTimeout(() => { btn.textContent = 'Invite'; }, 1500);
  });
}

function buildInviteLink(code) {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
}

// Best-effort shortening via TinyURL's free, keyless API — falls back to
// the full link on any failure (offline, rate-limited, CORS hiccup, etc.)
// so a shortener outage never blocks inviting someone.
async function shortenLink(longUrl) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
    if (!res.ok) return longUrl;
    const short = (await res.text()).trim();
    return short.startsWith('https://tinyurl.com/') ? short : longUrl;
  } catch {
    return longUrl;
  }
}

// Consumes a `?join=CODE` link. Called once app data (and the group panel
// DOM) is ready. Strips the param right away so the extra onAuthStateChange
// firing Supabase does on initial load doesn't process it twice.
function consumeInviteLinkIfAny() {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (!code) return;

  params.delete('join');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));

  if (myGroup) return; // already in a group — the app only supports being in one at a time

  showView('group');
  const codeInput = groupBodyEl.querySelector('#joinCode');
  if (codeInput) {
    codeInput.value = code.toUpperCase();
    handleJoinGroup();
  }
}

// Clipboard write with a fallback for insecure (file://) contexts.
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// Re-sync everything that depends on which group you're in: reload members,
// (re)connect the group's realtime channel, and refresh every view that
// shows group data.
async function onGroupChanged() {
  leaveGroupChannel();

  if (myGroup) {
    groupMembersCache = await groupMembers(myGroup.id);
    joinGroupChannel(myGroup.id);
  } else {
    groupMembersCache = [];
  }

  renderGroup();          // the Group tab
  syncShareToggleEnabled();
  applyShareState();      // the share panel copy + your own "You" marker
  loadGroupLeaderboard(); // the Leaderboard tab
}

// Your share toggle only makes sense inside a group.
function syncShareToggleEnabled() {
  shareToggleEl.disabled = !myGroup;
  if (!myGroup) shareToggleEl.checked = false;
}

// --- Share my live location toggle (PART 5) --------------------------------
// Default OFF, and it's scoped to YOUR CURRENT GROUP — not the whole app.
// Turning it on tracks Presence on the group's realtime channel (drives the
// "Sharing live" pill everywhere) and starts broadcasting your GPS fixes;
// turning it off (or losing the tab/connection) stops both.

function applyShareState() {
  isSharingLocation = shareToggleEl.checked && !!myGroup;

  if (!myGroup) {
    shareStatusEl.textContent = 'Join a group to share your location';
    shareStatusEl.className = 'share__status share__status--off';
  } else {
    shareStatusEl.textContent = isSharingLocation
      ? `Sharing live with ${myGroup.name}`
      : `Not sharing with ${myGroup.name}`;
    shareStatusEl.className =
      'share__status ' + (isSharingLocation ? 'share__status--on' : 'share__status--off');
  }

  if (isSharingLocation) {
    if (myGroupChannel) myGroupChannel.track({ user_id: currentUserId });
    startLocationBroadcast();
  } else {
    if (myGroupChannel) myGroupChannel.untrack();
    stopLocationBroadcast();
  }

  if (currentView === 'group') renderGroup(); // reflect your own pill instantly
}

function updateMeMarker() {
  if (!map) return;

  if (!isSharingLocation || !myLivePos) {
    if (meMarker) {
      map.removeLayer(meMarker);
      meMarker = null;
    }
    return;
  }

  if (meMarker) {
    meMarker.setLatLng(myLivePos);
  } else {
    meMarker = L.marker(myLivePos, { icon: makePin('You', '#E0A542') }).addTo(map);
  }
}

// Start a geolocation watch dedicated to sharing (independent of trip
// tracking): updates your own marker on every fix, and broadcasts to the
// group channel at most once every BROADCAST_INTERVAL_MS.
function startLocationBroadcast() {
  if (!navigator.geolocation || shareWatchId != null) return;

  shareWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      myLivePos = [lat, lng];
      updateMeMarker();

      const now = Date.now();
      if (now - lastBroadcastAt < BROADCAST_INTERVAL_MS) return;
      lastBroadcastAt = now;

      if (myGroupChannel) {
        myGroupChannel.send({
          type: 'broadcast',
          event: 'location',
          payload: { user_id: currentUserId, lat, lng, ts: now },
        });
      }
    },
    (error) => {
      console.error('Share GPS error:', error);
    },
    { enableHighAccuracy: true }
  );
}

function stopLocationBroadcast() {
  if (shareWatchId != null) {
    navigator.geolocation.clearWatch(shareWatchId);
    shareWatchId = null;
  }
  myLivePos = null;
  updateMeMarker();
}

shareToggleEl.addEventListener('change', applyShareState);

// Initial state: you're not in a group yet, so render the Create/Join screen
// and disable the group-scoped share toggle until you join one.
syncShareToggleEnabled();
renderGroup();
applyShareState();

// ============================================================================
// LEADERBOARD  (real — aggregated from the `trips` table, scoped to your
// current group)
// ============================================================================

let leaderboardRange = 'all'; // 'week' | 'month' | 'all'
let leaderboardCache = [];    // [{ name, totalKm, trips, longestKm }]

function computeRangeSince(range) {
  if (range === 'all') return null;
  const since = new Date();
  if (range === 'week') since.setDate(since.getDate() - 7);
  if (range === 'month') since.setMonth(since.getMonth() - 1);
  return since.toISOString();
}

// Pull every group member's trips (RLS allows seeing a groupmate's trip
// rows), aggregate per user in JS, and render.
async function loadGroupLeaderboard() {
  if (!myGroup || groupMembersCache.length === 0) {
    leaderboardCache = [];
    renderLeaderboard();
    return;
  }

  leaderboardListEl.innerHTML = '<p class="hint">Loading…</p>';

  const memberIds = groupMembersCache.map((m) => m.profile.id);
  let query = supabaseClient
    .from('trips')
    .select('user_id, distance_km, created_at')
    .in('user_id', memberIds);

  const since = computeRangeSince(leaderboardRange);
  if (since) query = query.gte('created_at', since);

  const { data, error } = await query;

  if (error) {
    console.error('Leaderboard load failed:', error);
    leaderboardListEl.innerHTML = '<p class="hint">Could not load the leaderboard — try again later.</p>';
    return;
  }

  const totalsByUser = {};
  (data || []).forEach((trip) => {
    const km = Number(trip.distance_km) || 0;
    const entry = totalsByUser[trip.user_id] || { totalKm: 0, trips: 0, longestKm: 0 };
    entry.totalKm += km;
    entry.trips += 1;
    entry.longestKm = Math.max(entry.longestKm, km);
    totalsByUser[trip.user_id] = entry;
  });

  leaderboardCache = groupMembersCache.map((m) => {
    const totals = totalsByUser[m.profile.id] || { totalKm: 0, trips: 0, longestKm: 0 };
    return {
      name: m.profile.display_name + (m.isMe ? ' (You)' : ''),
      totalKm: totals.totalKm,
      trips: totals.trips,
      longestKm: totals.longestKm,
    };
  });

  renderLeaderboard();
}

// Build the ranked leaderboard rows for the current time range.
function renderLeaderboard() {
  if (!myGroup) {
    leaderboardListEl.innerHTML = '<p class="hint">Join a group to see its leaderboard.</p>';
    return;
  }

  if (leaderboardCache.length === 0) {
    leaderboardListEl.innerHTML = '<p class="hint">No trips recorded in this range yet.</p>';
    return;
  }

  // Copy first (slice) so we never reorder the cache, then sort by total
  // distance, biggest first.
  const ranked = leaderboardCache
    .slice()
    .sort((a, b) => b.totalKm - a.totalKm);

  leaderboardListEl.innerHTML = ranked.map((friend, index) => {
    const position = index + 1;          // P1, P2, P3 …
    const isP1 = position === 1;
    // The pack visibly thins out below P1: P2/P3 get a slight boost,
    // P4+ fade slightly — P1's own styling is untouched.
    const tierClass = isP1 ? '' : position <= 3 ? ' friend--rank-upper' : ' friend--rank-lower';

    return `
      <div class="friend${isP1 ? ' friend--p1' : ''}${tierClass}">
        <span class="pos-badge${isP1 ? ' pos-badge--p1' : ''}">P${position}</span>
        <div class="friend__body">
          <span class="friend__name">${friend.name}</span>
          <div class="friend__stats">
            <span><strong>${friend.totalKm.toFixed(1)}</strong> km total</span>
            <span><strong>${friend.trips}</strong> trips</span>
            <span><strong>${friend.longestKm.toFixed(1)}</strong> km longest</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function setLeaderboardRange(range) {
  if (range === leaderboardRange || !['week', 'month', 'all'].includes(range)) return;
  leaderboardRange = range;

  leaderboardRangeEl.querySelectorAll('.range-filter__btn').forEach((btn) => {
    btn.classList.toggle('range-filter__btn--active', btn.dataset.range === range);
  });

  loadGroupLeaderboard();
}

leaderboardRangeEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.range-filter__btn');
  if (btn) setLeaderboardRange(btn.dataset.range);
});

renderLeaderboard(); // shows the "join a group" prompt until real data loads

// --- Buttons -----------------------------------------------------------

startBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('This browser has no GPS support', 'error');
    return;
  }

  tripPoints = [];
  startTime = Date.now();
  topSpeed = 0;
  resetStats();
  if (routeLayer) routeLayer.clearLayers(); // drop the previous trip's line
  tripRouteBounds = null;
  setStatus('Tracking…', 'tracking');
  igniteStatus(); // one-time amber pulse — the "ignition" moment
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Tick the duration every second so it counts up even between GPS fixes
  timerId = setInterval(refreshStats, 1000);

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const point = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        timestamp: position.timestamp
      };
      tripPoints.push(point);

      const speed = currentSpeedKmh(position);
      curSpeedEl.textContent = speed.toFixed(1);
      if (speed > topSpeed) {
        topSpeed = speed;
        topSpeedEl.textContent = topSpeed.toFixed(1);
      }

      refreshStats();
      console.log('New point:', point);
    },
    (error) => {
      console.error('GPS error:', error);
      setStatus('Error: ' + error.message, 'error');
    },
    { enableHighAccuracy: true }
  );
});

stopBtn.addEventListener('click', () => {
  navigator.geolocation.clearWatch(watchId);
  clearInterval(timerId);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  curSpeedEl.textContent = '0.0';

  const stats = calculateTripStats(tripPoints);
  refreshStats();
  setStatus(
    `Trip: ${stats.distanceKm} km, ${stats.durationMin} min, avg ${stats.avgSpeedKmh} km/h`,
    'done'
  );

  renderTripRoute();  // draw the path on the Map tab

  // Nothing worth logging for a trip with no real movement (e.g. an
  // accidental start/stop before a single GPS fix came in).
  if (tripPoints.length >= 2) {
    hasSavedTrips = true;
    updateMapEmptyState();
    saveTrip(stats);
  }

  console.log('Full trip:', tripPoints);
  console.log('Stats:', stats);
});

// ============================================================================
// AUTH  (real — Supabase email + password)
// ----------------------------------------------------------------------------
// Logged out  -> only #authView is shown; the whole app (#appView with the
//                tabs + views) is hidden.
// Logged in   -> #appView is shown and a "Log out" button appears in the
//                header. onAuthStateChange() keeps the two in sync.
// ============================================================================

const authViewEl = document.getElementById('authView');
const appViewEl = document.getElementById('appView');
const logoutBtnEl = document.getElementById('logoutBtn');
const authPanelEl = document.getElementById('authPanel');
const authBodyEl = document.getElementById('authBody');
const authFormEl = document.getElementById('authForm');
const authDisplayNameEl = document.getElementById('authDisplayName');
const authEmailEl = document.getElementById('authEmail');
const authPasswordEl = document.getElementById('authPassword');
const authErrorEl = document.getElementById('authError');
const authTitleEl = document.getElementById('authTitle');
const authSubEl = document.getElementById('authSub');
const authLoginEl = document.getElementById('authLogin');
const authSignupEl = document.getElementById('authSignup');
const authToggleEl = document.getElementById('authToggle');
const authToggleTextEl = document.getElementById('authToggleText');

let authMode = 'login';                 // 'login' | 'signup' — which button was pressed
let submittingAuth = false;

const KEY_LOOKS_UNSET =
  !SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.indexOf('PASTE_') === 0;

// --- Screen switching -----------------------------------------------------

function showAuthScreen() {
  appViewEl.hidden = true;
  logoutBtnEl.hidden = true;
  statusEl.hidden = true;         // the "Not tracking" pill belongs to the app
  authViewEl.hidden = false;
}

function showAppScreen() {
  authViewEl.hidden = true;
  appViewEl.hidden = false;
  logoutBtnEl.hidden = false;
  statusEl.hidden = false;
}

// --- Form copy + the login/signup toggle --------------------------------

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';

  authTitleEl.textContent = isLogin ? 'Welcome back' : 'Create your account';
  authSubEl.textContent = isLogin
    ? 'Sign in to your driving log.'
    : 'Track drives and join a group with friends.';
  authToggleTextEl.textContent = isLogin
    ? "Don't have an account?"
    : 'Already have an account?';
  authToggleEl.textContent = isLogin ? 'Sign up' : 'Log in';

  // Only one primary action is ever visible — login (amber) or create
  // account (teal) — instead of both buttons always shown and recolored.
  authLoginEl.hidden = !isLogin;
  authSignupEl.hidden = isLogin;

  // Also flip `type` so exactly one button is ever type="submit". A form's
  // implicit-submission "default button" (Enter key, or keyboard-activated
  // submit) is the first submit button in DOM order — `hidden` alone does
  // NOT disqualify it. With both left as type="submit", submitting the Sign
  // Up form via Enter would silently activate the hidden Log In button
  // instead, leaving authMode stuck on 'login' and running
  // signInWithPassword() against a brand-new account (surfacing as "Wrong
  // email or password" on the Sign Up screen).
  authLoginEl.type = isLogin ? 'submit' : 'button';
  authSignupEl.type = isLogin ? 'button' : 'submit';

  authPanelEl.classList.toggle('auth--signup', !isLogin);

  authPasswordEl.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
  authDisplayNameEl.hidden = isLogin; // only asked for at signup

  hideAuthMessage();
}

// --- Message area near the form ----------------------------------------

function showAuthMessage(text, tone) {
  authErrorEl.textContent = text;
  authErrorEl.className = 'auth__error' + (tone === 'info' ? ' auth__error--info' : '');
  authErrorEl.hidden = false;
}

function hideAuthMessage() {
  authErrorEl.hidden = true;
  authErrorEl.textContent = '';
  authErrorEl.className = 'auth__error';
}

// Map Supabase's raw error text to something a person can act on.
// `mode` guards against ever showing a login-specific message on the
// signup screen (or vice versa) even if the wrong Supabase call somehow
// runs again in the future — see the type="submit" fix in setAuthMode().
function friendlyAuthError(error, mode) {
  const msg = (error && error.message ? error.message : '').toLowerCase();

  if (msg.includes('already registered') || msg.includes('already been registered') ||
      msg.includes('user already exists')) {
    return 'That email is already in use — try logging in instead.';
  }
  // "Invalid login credentials" only ever comes from signInWithPassword —
  // signUp() has no equivalent error, so this check is login-only.
  if (mode === 'login' && msg.includes('invalid login credentials')) {
    return 'Wrong email or password.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Confirm your email first — check your inbox for the link.';
  }
  if (msg.includes('password should be at least')) {
    return 'Password is too short (minimum 6 characters).';
  }
  if (msg.includes('unable to validate email address') || msg.includes('invalid format')) {
    return "That doesn't look like a valid email address.";
  }
  if (msg.includes('for security purposes') || msg.includes('rate limit')) {
    return 'Too many attempts — wait a minute and try again.';
  }
  return (error && error.message) || 'Something went wrong. Try again.';
}

// --- Submit (shared by the Log In and Sign Up buttons) ------------------

async function submitAuth() {
  if (submittingAuth) return;

  const email = authEmailEl.value.trim();
  const password = authPasswordEl.value;
  const displayName = authDisplayNameEl.value.trim();

  hideAuthMessage();

  if (!email || !password) {
    showAuthMessage('Enter your email and password.');
    return;
  }
  if (password.length < 6) {
    showAuthMessage('Password must be at least 6 characters.');
    return;
  }
  if (KEY_LOOKS_UNSET) {
    showAuthMessage('Add your Supabase publishable key in script.js first.');
    return;
  }

  submittingAuth = true;
  authLoginEl.disabled = true;
  authSignupEl.disabled = true;

  // TEMP DEBUG — remove once the signup bug is confirmed fixed. Confirms
  // what's actually being sent and which branch (signUp vs
  // signInWithPassword) is about to run.
  console.log('[auth] submitting', { authMode, email, passwordLength: password.length });

  try {
    const { data, error } =
      authMode === 'signup'
        ? await supabaseClient.auth.signUp({
            email,
            password,
            options: {
              data: { display_name: displayName || undefined },
              // Preserves ?join=CODE across the "confirm your email" redirect,
              // so clicking an invite link, signing up, then confirming still
              // lands back on the link that auto-joins the group.
              emailRedirectTo: location.href,
            },
          })
        : await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      // TEMP DEBUG — remove once the signup bug is confirmed fixed.
      console.error('[auth] raw Supabase error', { authMode, error });
      showAuthMessage(friendlyAuthError(error, authMode));
      return;
    }

    // Signup with "Confirm email" ON returns no session — the user must click
    // the emailed link before they can log in.
    if (authMode === 'signup' && !data.session) {
      setAuthMode('login');
      showAuthMessage('Account created. Check your email to confirm, then log in.', 'info');
      return;
    }

    // Success with a session: onAuthStateChange() will swap to the app.
  } catch (err) {
    showAuthMessage('Network error — could not reach Supabase.');
  } finally {
    submittingAuth = false;
    authLoginEl.disabled = false;
    authSignupEl.disabled = false;
  }
}

// --- Wiring ------------------------------------------------------------------

authLoginEl.addEventListener('click', () => { authMode = 'login'; });
authSignupEl.addEventListener('click', () => { authMode = 'signup'; });

authFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth();
});

// Crossfade the title/fields/button on mode switch — same 160ms
// exit-then-enter pattern showView() uses for tab switching.
authToggleEl.addEventListener('click', () => {
  const nextMode = authMode === 'login' ? 'signup' : 'login';
  authBodyEl.classList.add('auth__body--fade');
  setTimeout(() => {
    setAuthMode(nextMode);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => authBodyEl.classList.remove('auth__body--fade'));
    });
  }, 160);
});

logoutBtnEl.addEventListener('click', async () => {
  await supabaseClient.auth.signOut(); // onAuthStateChange() handles the UI
});

// Everything that needs to happen once we know who's logged in: profile,
// group membership + realtime channel, trip history.
async function loadAppData(session) {
  currentUserId = session.user.id;
  await ensureProfile(session);
  await loadMyGroup();
  await onGroupChanged();
  loadTripHistory();
  consumeInviteLinkIfAny();
}

// Tear down everything that only makes sense while logged in.
function clearAppData() {
  currentUserId = null;
  myGroup = null;
  groupMembersCache = [];
  myProfile = null;
  leaveGroupChannel();
  stopLocationBroadcast();
}

async function initAuth() {
  setAuthMode('login');

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    showAppScreen();
    await loadAppData(session);
  } else {
    showAuthScreen();
    if (KEY_LOOKS_UNSET) {
      showAuthMessage('Add your Supabase publishable key in script.js to enable login.', 'info');
    }
  }

  // Fires on login, logout, token refresh, and once on load.
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session) {
      hideAuthMessage();
      authFormEl.reset();
      showAppScreen();
      loadAppData(session);
    } else {
      clearAppData();
      showAuthScreen();
    }
  });
}

initAuth();
