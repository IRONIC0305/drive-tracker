// Records a scripted tour of Drive Tracker with Playwright: serves the app
// locally, simulates a ~90s drive around Sydney via repeated
// context.setGeolocation() calls (respecting the app's own GPS-derived
// speed/distance logic — nothing here talks to the app except through
// real browser geolocation and real clicks), then tours Tracker -> Map ->
// Leaderboard -> Group -> Friends. Produces a raw .webm in demo/recording/
// — convert to the final mp4 separately (see README "Demo" section for the
// ffmpeg command).
//
// Run from the demo/ folder: node record-demo.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 8000;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(__dirname, 'recording');

// Real Sydney waypoints, Sydney CBD heading toward Kings Cross/Rushcutters
// Bay — piecewise-linear interpolation along these, not actual road
// geometry, but directionally and visually realistic for a demo.
const ROUTE = [
  { lat: -33.8688, lng: 151.2093 }, // Sydney CBD / Town Hall
  { lat: -33.8730, lng: 151.2150 },
  { lat: -33.8768, lng: 151.2225 }, // Kings Cross
  { lat: -33.8810, lng: 151.2300 },
  { lat: -33.8845, lng: 151.2370 }, // Rushcutters Bay
];

const DRIVE_SECONDS = 90;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function pointAtDistance(route, distKm) {
  let remaining = distKm;
  for (let i = 0; i < route.length - 1; i++) {
    const segLen = haversineKm(route[i], route[i + 1]);
    if (remaining <= segLen || i === route.length - 2) {
      const frac = segLen === 0 ? 0 : Math.max(0, Math.min(1, remaining / segLen));
      return {
        lat: route[i].lat + (route[i + 1].lat - route[i].lat) * frac,
        lng: route[i].lng + (route[i + 1].lng - route[i].lng) * frac,
      };
    }
    remaining -= segLen;
  }
  return route[route.length - 1];
}

// 0-30s: 0 -> 80 km/h. 30-60s: hold 80. 60-90s: 80 -> 0.
function speedKmhAt(t) {
  if (t <= 30) return 80 * (t / 30);
  if (t <= 60) return 80;
  if (t <= 90) return 80 * (1 - (t - 60) / 30);
  return 0;
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Local server at ${url} did not respond within ${timeoutMs}ms`);
}

function fail(step, reason) {
  console.error(`\nDemo recording failed at step: ${step}\n${reason}\n`);
  process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  console.log(`Starting local server on :${PORT}...`);
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
  });

  try {
    await waitForServer(`http://localhost:${PORT}/index.html`, 15000);
  } catch (err) {
    server.kill();
    return fail('server startup', err.message);
  }
  console.log('✓ Local server is up');

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    geolocation: { latitude: ROUTE[0].lat, longitude: ROUTE[0].lng, accuracy: 8 },
    permissions: ['geolocation'],
    recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } },
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const cleanup = async () => {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill();
  };

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForTimeout(3000); // let sign-in resolve, and give the viewer a moment to see it

    const appVisible = await page.evaluate(() => !document.getElementById('appView').hidden);
    if (!appVisible) {
      const authMsg = await page.evaluate(() => {
        const el = document.getElementById('authError');
        return el && !el.hidden ? el.textContent : null;
      });
      throw new Error(
        'Never reached the signed-in app screen. ' +
        (authMsg ? `Auth screen shows: "${authMsg}". ` : '') +
        'Most likely cause: Anonymous Sign-Ins is OFF in Supabase ' +
        '(Authentication -> Sign In / Providers -> Anonymous Sign-Ins). Enable it and re-run.'
      );
    }
    console.log('✓ Signed in (anonymous guest)');

    // --- Tracker: start a trip, simulate the drive, end it -----------------
    await page.click('#tabTracker');
    await page.waitForTimeout(1000);

    const startBtn = await page.$('#startBtn');
    if (!startBtn) throw new Error('Could not find #startBtn on the Tracker screen.');
    await startBtn.click();
    await page.waitForTimeout(800);

    const statusText = (await page.evaluate(() => document.getElementById('status').textContent)) || '';
    if (!/recording/i.test(statusText)) {
      throw new Error(
        `Expected the status pill to show "RECORDING..." after tapping Start trip, but it shows "${statusText}". ` +
        'Check that geolocation permission is actually being granted to the page.'
      );
    }
    console.log('✓ Trip started — simulating a 90s drive around Sydney...');

    let cumDistKm = 0;
    for (let t = 1; t <= DRIVE_SECONDS; t++) {
      cumDistKm += speedKmhAt(t) / 3600;
      const pos = pointAtDistance(ROUTE, cumDistKm);
      await context.setGeolocation({ latitude: pos.lat, longitude: pos.lng, accuracy: 8 });
      await page.waitForTimeout(1000);
    }
    console.log('✓ Drive simulation complete');

    await page.waitForTimeout(3500); // pause to read final speed/distance/time

    const stopBtn = await page.$('#stopBtn');
    if (!stopBtn) throw new Error('Could not find #stopBtn to end the trip.');
    await stopBtn.click();
    await page.waitForTimeout(3500); // pause on the "Trip saved" status + updated history

    // --- Map: route + markers ----------------------------------------------
    await page.click('#tabMap');
    await page.waitForTimeout(4000);

    // --- Leaderboard: cycle through the three ranking segments -------------
    await page.click('#tabLeaderboard');
    await page.waitForTimeout(3000);
    for (const metric of ['topSpeed', 'trips', 'distance']) {
      const seg = await page.$(`[data-metric="${metric}"]`);
      if (seg) {
        await seg.click();
        await page.waitForTimeout(2500);
      }
    }

    // --- Group ---------------------------------------------------------------
    await page.click('#tabGroup');
    await page.waitForTimeout(4000);

    // --- Friends ---------------------------------------------------------------
    await page.click('#tabFriends');
    await page.waitForTimeout(4000);

    if (pageErrors.length > 0) {
      console.warn('\nNote: page errors occurred during recording (video was still saved):');
      pageErrors.forEach((e) => console.warn('  - ' + e));
    }
  } catch (err) {
    await cleanup();
    return fail('tour', err.message);
  }

  const video = page.video();
  await context.close();
  const videoPath = video ? await video.path() : null;
  await browser.close();
  server.kill();

  if (!videoPath) {
    return fail('video export', 'Playwright did not produce a video file.');
  }
  console.log(`\n✓ Raw recording saved: ${videoPath}`);
}

main();
