import { relativeTime } from '../ui/relative-time.js';

/**
 * Words for the background fetch: the Settings choice, the line under it and
 * the Pull button's tooltip. Pure; Vite and the Node check both load it.
 */

/** 0 → "Off", 5 → "Every 5 minutes", 60 → "Every hour". */
export function intervalLabel(minutes) {
  if (!minutes) return 'Off';
  return minutes === 60 ? 'Every hour' : `Every ${minutes} minutes`;
}

const every = minutes => (minutes === 60 ? 'every hour' : `every ${minutes} minutes`);

/** What the setting does, in the state it is in. */
export function fetchExplanation(interval) {
  return interval
    ? `Runs git fetch --all --no-tags for the repository in the open tab ${every(interval)}, so Pull and Push show what the server has. This is the only network access 🌱 Twig makes by itself. Branches, files and tags stay as they are.`
    : 'Off. 🌱 Twig does not reach the network by itself: Pull and Push show what your last fetch knew.';
}

/**
 * How the open repository's schedule stands, or '' when it is off.
 * @param {{ interval: number, lastSuccess: ?number, error: ?string, running: boolean }} status  times in ms
 */
export function fetchStatusLine(status, now = Date.now()) {
  if (!status?.interval) return '';
  if (status.running) return 'Fetching now…';
  if (status.error) return status.error;
  if (status.lastSuccess) return `Last fetched ${relativeTime(status.lastSuccess / 1000, now)}.`;
  return 'Not fetched yet; the first fetch starts a few seconds after a repository opens.';
}

/** The Pull button's tooltip: how fresh the badges are. */
export function pullTitle(status, now = Date.now()) {
  if (!status?.interval) return 'Pull · the badge shows what your last fetch knew';
  if (status.error) return `Pull · background fetch failed: ${status.error}`;
  return status.lastSuccess ? `Pull · remote checked ${relativeTime(status.lastSuccess / 1000, now)}` : 'Pull · background fetch has not run yet';
}
