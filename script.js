// Drive Tracker — trip tracking + live stats

// ============================================================================
// SUPABASE CONFIG  (the only real backend wiring so far)
// ============================================================================
// Login / signup is REAL (Supabase Auth, email + password). Everything else —
// leaderboard, group, map friends — is still mock data (see the MOCK sections
// further down). Wiring those to the database comes later.
//
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
const SUPABASE_URL = 'https://jacsheofjgaysemerfln.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_AqA40yERnQIfhGnJvebYzQ_A91uk-9X';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// --- Leaderboard data ---------------------------------------------------------
// Hardcoded sample data standing in for a future database query. When a real
// backend exists, replace this array with whatever the query returns, e.g.
//   const LEADERBOARD_DATA = await fetchLeaderboardFromServer();
// Each item is one friend. Keep these four field names and the rest of the
// leaderboard code keeps working unchanged:
//   name      - string,  display name
//   totalKm   - number,  total distance driven, in kilometres
//   trips     - number,  how many trips they've recorded
//   longestKm - number,  their single longest trip, in kilometres
// (Order here does not matter — renderLeaderboard() sorts by totalKm.)
const LEADERBOARD_DATA = [
  { name: 'Alex Rivera',  totalKm: 1240.5, trips: 48, longestKm: 210.3 },
  { name: 'Priya Nair',   totalKm: 980.2,  trips: 39, longestKm: 175.0 },
  { name: 'Sam Okafor',   totalKm: 1520.8, trips: 61, longestKm: 305.6 },
  { name: 'Mia Chen',     totalKm: 445.9,  trips: 22, longestKm: 98.4  },
  { name: 'Diego Santos', totalKm: 760.0,  trips: 30, longestKm: 140.7 },
];

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
const shareToggleEl = document.getElementById('shareToggle');
const shareStatusEl = document.getElementById('shareStatus');

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

// --- Leaderboard ---------------------------------------------------------

// Build the ranked leaderboard rows from LEADERBOARD_DATA.
function renderLeaderboard() {
  // Copy first (slice) so we never reorder the original data, then sort by
  // total distance, biggest first.
  const ranked = LEADERBOARD_DATA
    .slice()
    .sort((a, b) => b.totalKm - a.totalKm);

  leaderboardListEl.innerHTML = ranked.map((friend, index) => {
    const position = index + 1;          // P1, P2, P3 …
    const isP1 = position === 1;

    return `
      <div class="friend${isP1 ? ' friend--p1' : ''}">
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
  }, 160);
}

tabTrackerEl.addEventListener('click', () => showView('tracker'));
tabLeaderboardEl.addEventListener('click', () => showView('leaderboard'));
tabMapEl.addEventListener('click', () => showView('map'));
tabGroupEl.addEventListener('click', () => showView('group'));

renderLeaderboard();

// --- Map: setup + your trip route (PART 1) ----------------------------------
// Real data: this section draws the GPS points captured during a trip.

const MAP_CENTER = [51.505, -0.09]; // fallback view before any trip exists

let map = null;
let routeLayer = null;       // holds the polyline + start/end markers
let friendLayer = null;      // holds the simulated friend markers
let meMarker = null;         // the "You" marker, shown only while sharing
let tripRouteBounds = null;  // map bounds of the last drawn route

// Create the Leaflet map once, on first visit to the Map tab.
function ensureMap() {
  if (map) return;

  map = L.map('map').setView(MAP_CENTER, 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  friendLayer = L.layerGroup().addTo(map);

  startFriendSimulation(); // PART 2 — see the MOCK section below
}

// A small round pin with initials + a name label, used for friends and "You".
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
// MOCK — people, groups & membership (PARTS 2 + 3)
// ----------------------------------------------------------------------------
// None of this talks to a server. Each block below is labelled with the
// Supabase table it will become. To go real you replace the four data
// structures with query results and swap the timer in startFriendSimulation()
// for a `live_locations` Realtime subscription — the render code is unchanged.
// ============================================================================

let isSharingLocation = false; // mirrors YOUR toggle; real code reads this too
let myGroup = null;            // the group you're currently in, or null

// ----- MOCK: `profiles` table -----------------------------------------------
// One row per person: identity + map-pin colour + leaderboard stats. Keyed by
// user id so the other tables can reference people by id alone.
const MOCK_PROFILES = {
  me:      { id: 'me',      name: 'You',          color: '#E0A542', totalKm: 612.4,  trips: 27 },
  u_sam:   { id: 'u_sam',   name: 'Sam Okafor',   color: '#9BC7D1', totalKm: 1520.8, trips: 61 },
  u_priya: { id: 'u_priya', name: 'Priya Nair',   color: '#7FB7C4', totalKm: 980.2,  trips: 39 },
  u_diego: { id: 'u_diego', name: 'Diego Santos', color: '#6BA9B6', totalKm: 760.0,  trips: 30 },
  u_mia:   { id: 'u_mia',   name: 'Mia Chen',     color: '#B7D6DE', totalKm: 445.9,  trips: 22 },
};

// ----- MOCK: `live_locations` stream --------------------------------------
// A preset loop of [lat, lng] waypoints per user, used to fake movement.
// Real app: these coordinates arrive over Supabase Realtime instead.
const MOCK_LIVE_PATHS = {
  u_sam:   [[51.501, -0.100], [51.499, -0.092], [51.497, -0.101], [51.500, -0.110]],
  u_priya: [[51.507, -0.093], [51.509, -0.086], [51.506, -0.080], [51.503, -0.089]],
  u_diego: [[51.512, -0.099], [51.514, -0.090], [51.511, -0.085], [51.509, -0.097]],
  u_mia:   [[51.508, -0.105], [51.505, -0.099], [51.503, -0.104], [51.506, -0.112]],
};

// ----- MOCK: `groups` table -----------------------------------------------
// Keyed by group id. Ships with one pre-built group that any invite code will
// join (see handleJoinGroup()). Groups you create get added here at runtime.
const MOCK_GROUPS = {
  g_apex: { id: 'g_apex', name: 'Apex Hunters', inviteCode: 'A7X4K2', createdBy: 'u_sam' },
};

// ----- MOCK: `group_members` join table ---------------------------------
// One row per (group, user). `sharing` = that member is broadcasting their
// live location to this group right now. Your own row is pushed/spliced as
// you join and leave.
const MOCK_GROUP_MEMBERS = [
  { groupId: 'g_apex', userId: 'u_sam',   sharing: true  },
  { groupId: 'g_apex', userId: 'u_priya', sharing: true  },
  { groupId: 'g_apex', userId: 'u_diego', sharing: false },
  { groupId: 'g_apex', userId: 'u_mia',   sharing: false },
];
// ----- END MOCK data ------------------------------------------------------------

// Six visually-unambiguous characters (no 0/O/1/I) — e.g. "X7K2P9".
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// group_members rows for one group, resolved against MOCK_PROFILES.
// Returns [{ profile, sharing, isMe }]; skips any member with no profile row.
function groupMembers(groupId) {
  return MOCK_GROUP_MEMBERS
    .filter((m) => m.groupId === groupId)
    .map((m) => ({
      profile: MOCK_PROFILES[m.userId],
      sharing: m.sharing,
      isMe: m.userId === 'me',
    }))
    .filter((m) => m.profile);
}

// --- Live friend markers on the map (PART 4) -------------------------------
// A moving marker is shown ONLY for group members (not you) whose `sharing`
// is true. Members who are off get no marker at all — a greyed-out pin would
// leak "this person exists but is hiding", which defeats the off switch.

let friendTimerId = null;
const friendSim = {}; // userId -> { marker, path, t }

// The people who should currently have a marker.
function visibleGroupMembers() {
  if (!myGroup) return [];
  return groupMembers(myGroup.id)
    .filter((m) => !m.isMe && m.sharing && MOCK_LIVE_PATHS[m.profile.id])
    .map((m) => m.profile);
}

// Rebuild all friend markers from scratch. Safe to call whenever the group or
// a member's sharing state changes; a no-op until the map has been created.
function rebuildFriendMarkers() {
  if (!friendLayer) return;

  friendLayer.clearLayers();
  for (const key of Object.keys(friendSim)) delete friendSim[key];

  visibleGroupMembers().forEach((profile) => {
    const path = MOCK_LIVE_PATHS[profile.id];
    const marker = L.marker(path[0], {
      icon: makePin(profile.name, profile.color),
    }).addTo(friendLayer);
    friendSim[profile.id] = { marker, path, t: 0 };
  });
}

// Nudge every visible friend further along their loop. `t` counts path
// segments; its fractional part slides between two waypoints.
function stepFriendSimulation() {
  Object.values(friendSim).forEach((entry) => {
    const count = entry.path.length;
    entry.t += 0.25;

    const seg = Math.floor(entry.t) % count;
    const frac = entry.t - Math.floor(entry.t);
    const [aLat, aLng] = entry.path[seg];
    const [bLat, bLng] = entry.path[(seg + 1) % count];

    entry.marker.setLatLng([aLat + (bLat - aLat) * frac, aLng + (bLng - aLng) * frac]);
  });
}

function startFriendSimulation() {
  rebuildFriendMarkers();
  friendTimerId = setInterval(stepFriendSimulation, 2000);
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
      <button class="btn btn--ghost btn--block" id="joinBtn" type="button">Join Group</button>
    </div>`;

  groupBodyEl.querySelector('#createBtn').addEventListener('click', handleCreateGroup);
  groupBodyEl.querySelector('#joinBtn').addEventListener('click', handleJoinGroup);
}

// In a group — name, invite code, member list, leave.
function renderGroupHome() {
  const members = groupMembers(myGroup.id);

  groupBodyEl.innerHTML = `
    <div class="group__header">
      <h3 class="group__name">${myGroup.name}</h3>
      <div class="group__code-row">
        <span class="group__code-label">Invite code</span>
        <span class="group__code">${myGroup.inviteCode}</span>
        <button class="btn btn--ghost btn--sm" id="copyCodeBtn" type="button">Copy code</button>
      </div>
    </div>

    <h4 class="group__section-title">Members &middot; ${members.length}</h4>
    <div class="leaderboard__list">
      ${members.map(renderMemberRow).join('')}
    </div>

    <button class="btn btn--stop btn--block" id="leaveBtn" type="button" style="margin-top: 14px;">Leave Group</button>`;

  groupBodyEl.querySelector('#copyCodeBtn').addEventListener('click', handleCopyCode);
  groupBodyEl.querySelector('#leaveBtn').addEventListener('click', handleLeaveGroup);
}

// One member row — reuses the leaderboard's .friend styling for consistency.
function renderMemberRow({ profile, sharing, isMe }) {
  return `
    <div class="friend">
      <div class="friend__body">
        <span class="friend__name">${profile.name}${isMe ? ' <span class="tag">You</span>' : ''}</span>
        <div class="friend__stats">
          <span><strong>${profile.totalKm.toFixed(1)}</strong> km total</span>
          <span><strong>${profile.trips}</strong> trips</span>
        </div>
      </div>
      <span class="live-pill ${sharing ? 'live-pill--on' : 'live-pill--off'}">${sharing ? 'Sharing live' : 'Location off'}</span>
    </div>`;
}

// --- Group actions ----------------------------------------------------------

function handleCreateGroup() {
  const name = (groupBodyEl.querySelector('#createName').value || '').trim() || 'My Group';
  const group = {
    id: 'g_' + generateInviteCode().toLowerCase(),
    name,
    inviteCode: generateInviteCode(),
    createdBy: 'me',
  };
  MOCK_GROUPS[group.id] = group;
  MOCK_GROUP_MEMBERS.push({ groupId: group.id, userId: 'me', sharing: false });
  myGroup = group;
  onGroupChanged();
}

function handleJoinGroup() {
  // Mock: any code joins the one pre-built group. A real app would look the
  // group up by invite_code and show an error when nothing matched.
  const group = MOCK_GROUPS.g_apex;
  const alreadyIn = MOCK_GROUP_MEMBERS.some(
    (m) => m.groupId === group.id && m.userId === 'me'
  );
  if (!alreadyIn) {
    MOCK_GROUP_MEMBERS.push({ groupId: group.id, userId: 'me', sharing: false });
  }
  myGroup = group;
  onGroupChanged();
}

function handleLeaveGroup() {
  const i = MOCK_GROUP_MEMBERS.findIndex(
    (m) => m.groupId === myGroup.id && m.userId === 'me'
  );
  if (i !== -1) MOCK_GROUP_MEMBERS.splice(i, 1);
  myGroup = null;
  shareToggleEl.checked = false; // leaving a group also stops your sharing
  onGroupChanged();
}

function handleCopyCode() {
  const btn = groupBodyEl.querySelector('#copyCodeBtn');
  copyText(myGroup.inviteCode).then((ok) => {
    btn.textContent = ok ? 'Copied' : 'Press ⌘C';
    setTimeout(() => { btn.textContent = 'Copy code'; }, 1500);
  });
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

// Re-sync everything that depends on which group you're in.
function onGroupChanged() {
  renderGroup();          // the Group tab
  rebuildFriendMarkers(); // the map's live markers (no-op until the map exists)
  syncShareToggleEnabled();
  applyShareState();      // the share panel copy + your own "You" marker
}

// Your share toggle only makes sense inside a group.
function syncShareToggleEnabled() {
  shareToggleEl.disabled = !myGroup;
  if (!myGroup) shareToggleEl.checked = false;
}

// --- Share my live location toggle (PART 5) --------------------------------
// Default OFF, and it's scoped to YOUR CURRENT GROUP — not the whole app.
// In this mock, "sharing" shows the amber "You" marker on the map and updates
// the status line; with a real backend this same switch starts/stops writing
// your coordinates to the group's live_locations rows.

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

  updateMeMarker();
}

function updateMeMarker() {
  if (!map) return;

  if (!isSharingLocation) {
    if (meMarker) {
      map.removeLayer(meMarker);
      meMarker = null;
    }
    return;
  }

  // Show "You" at the last known point of the current/most recent trip,
  // or the map centre if there is no trip yet.
  const last = tripPoints[tripPoints.length - 1];
  const pos = last ? [last.lat, last.lng] : MAP_CENTER;

  if (meMarker) {
    meMarker.setLatLng(pos);
  } else {
    meMarker = L.marker(pos, { icon: makePin('You', '#E0A542') }).addTo(map);
  }
}

shareToggleEl.addEventListener('change', applyShareState);

// Initial state: you're not in a group yet, so render the Create/Join screen
// and disable the group-scoped share toggle until you join one.
syncShareToggleEnabled();
renderGroup();
applyShareState();

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
  updateMeMarker();   // keep the "You" marker on the finish point if sharing

  // Nothing worth logging for a trip with no real movement (e.g. an
  // accidental start/stop before a single GPS fix came in).
  if (tripPoints.length >= 2) {
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
const authFormEl = document.getElementById('authForm');
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

  authTitleEl.textContent = isLogin ? 'Log in' : 'Sign up';
  authSubEl.textContent = isLogin
    ? 'Sign in to your driving log.'
    : 'Create an account to start logging drives.';
  authToggleTextEl.textContent = isLogin
    ? "Don't have an account?"
    : 'Already have an account?';
  authToggleEl.textContent = isLogin ? 'Sign up' : 'Log in';

  // Emphasise (amber) whichever button matches the current mode.
  authLoginEl.className = 'btn btn--block ' + (isLogin ? 'btn--start' : 'btn--ghost');
  authSignupEl.className = 'btn btn--block ' + (isLogin ? 'btn--ghost' : 'btn--start');

  authPasswordEl.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
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
function friendlyAuthError(error) {
  const msg = (error && error.message ? error.message : '').toLowerCase();

  if (msg.includes('already registered') || msg.includes('already been registered') ||
      msg.includes('user already exists')) {
    return 'That email is already in use — try logging in instead.';
  }
  if (msg.includes('invalid login credentials')) {
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

  try {
    const { data, error } =
      authMode === 'signup'
        ? await supabaseClient.auth.signUp({ email, password })
        : await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      showAuthMessage(friendlyAuthError(error));
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

authToggleEl.addEventListener('click', () => {
  setAuthMode(authMode === 'login' ? 'signup' : 'login');
});

logoutBtnEl.addEventListener('click', async () => {
  await supabaseClient.auth.signOut(); // onAuthStateChange() handles the UI
});

async function initAuth() {
  setAuthMode('login');

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUserId = session.user.id;
    showAppScreen();
    loadTripHistory();
  } else {
    showAuthScreen();
    if (KEY_LOOKS_UNSET) {
      showAuthMessage('Add your Supabase publishable key in script.js to enable login.', 'info');
    }
  }

  // Fires on login, logout, token refresh, and once on load.
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session) {
      currentUserId = session.user.id;
      hideAuthMessage();
      authFormEl.reset();
      showAppScreen();
      loadTripHistory();
    } else {
      currentUserId = null;
      showAuthScreen();
    }
  });
}

initAuth();
