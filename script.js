// Drive Tracker — trip tracking + live stats

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

// View switching + leaderboard + map
const tabTrackerEl = document.getElementById('tabTracker');
const tabLeaderboardEl = document.getElementById('tabLeaderboard');
const tabMapEl = document.getElementById('tabMap');
const trackerViewEl = document.getElementById('trackerView');
const leaderboardViewEl = document.getElementById('leaderboardView');
const mapViewEl = document.getElementById('mapView');
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
// MOCK — simulated live friend locations (PART 2)
// ----------------------------------------------------------------------------
// Everything between the MOCK START / MOCK END markers is fake. It exists only
// to preview what live tracking will look like. To wire up Supabase Realtime:
//
//   1. Delete MOCK_FRIENDS_LIVE and stepFriendSimulation().
//   2. In startFriendSimulation(), instead of setInterval(...), subscribe:
//        supabase.channel('live-locations')
//          .on('postgres_changes',
//              { event: '*', schema: 'public', table: 'live_locations' },
//              ({ new: row }) => upsertFriendMarker(row.user_id, row.name,
//                                                    row.color, row.lat, row.lng))
//          .subscribe();
//   3. In the share toggle handler, when isSharingLocation is true, start
//      pushing your own {lat, lng} to that table; when false, stop and delete
//      your row so no one can see you. `isSharingLocation` already gates this.
//
// The rest of the app (map, markers, pins) does not care where the coordinates
// come from — it only needs {name, color, lat, lng} per friend.
// ============================================================================

let isSharingLocation = false; // mirrors the toggle; real code reads this too

// ----- MOCK START -----
const MOCK_FRIENDS_LIVE = [
  {
    id: 'f1', name: 'Priya Nair', color: '#7FB7C4',
    path: [[51.507, -0.093], [51.509, -0.086], [51.506, -0.080], [51.503, -0.089]],
  },
  {
    id: 'f2', name: 'Sam Okafor', color: '#9BC7D1',
    path: [[51.501, -0.100], [51.499, -0.092], [51.497, -0.101], [51.500, -0.110]],
  },
  {
    id: 'f3', name: 'Diego Santos', color: '#6BA9B6',
    path: [[51.512, -0.099], [51.514, -0.090], [51.511, -0.085], [51.509, -0.097]],
  },
];

let friendTimerId = null;

// Move every friend a little further along their loop and update their marker.
// `_t` counts path segments; the fractional part slides between two waypoints.
function stepFriendSimulation() {
  MOCK_FRIENDS_LIVE.forEach((friend) => {
    const count = friend.path.length;
    friend._t = (friend._t ?? 0) + 0.25;

    const seg = Math.floor(friend._t) % count;
    const frac = friend._t - Math.floor(friend._t);
    const [aLat, aLng] = friend.path[seg];
    const [bLat, bLng] = friend.path[(seg + 1) % count];

    const lat = aLat + (bLat - aLat) * frac;
    const lng = aLng + (bLng - aLng) * frac;
    friend._marker.setLatLng([lat, lng]);
  });
}

function startFriendSimulation() {
  MOCK_FRIENDS_LIVE.forEach((friend) => {
    friend._t = 0;
    friend._marker = L.marker(friend.path[0], {
      icon: makePin(friend.name, friend.color),
    }).addTo(friendLayer);
  });

  friendTimerId = setInterval(stepFriendSimulation, 2000);
}
// ----- MOCK END -----

// --- Share my live location toggle (PART 2) --------------------------------
// Default OFF. In this mock, "sharing" just shows a blue "You" marker on the
// map and flips the indicator; with a real backend this is also the switch
// that starts/stops publishing your coordinates to other people.

function applyShareState() {
  isSharingLocation = shareToggleEl.checked;

  shareStatusEl.textContent = isSharingLocation ? 'Sharing live' : 'Not sharing';
  shareStatusEl.className =
    'share__status ' + (isSharingLocation ? 'share__status--on' : 'share__status--off');

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
applyShareState(); // set the "Not sharing" indicator on load

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

  console.log('Full trip:', tripPoints);
  console.log('Stats:', stats);
});
