import { relativeTime } from '../ui/relative-time.js';
import { t, tr } from '../i18n/i18n.js';

/**
 * Words for the background fetch: the Settings choice, the line under it and
 * the Pull button's tooltip. Pure; Vite and the Node check both load it.
 */

/** 0 → "Off", 5 → "Every 5 minutes", 60 → "Every hour". */
export function intervalLabel(minutes) {
  if (!minutes) return t('Off');
  return minutes === 60 ? t('Every hour') : t`Every ${minutes} minutes`;
}

/** What the setting does, in the state it is in. */
export function fetchExplanation(interval) {
  if (!interval) return t('Off. 🌱 Twig does not reach the network by itself: Pull and Push show what your last fetch knew.');
  return interval === 60
    ? t('Runs git fetch --all --no-tags for the repository in the open tab every hour, so Pull and Push show what the server has. This is the only network access 🌱 Twig makes by itself. Branches, files and tags stay as they are.')
    : t`Runs git fetch --all --no-tags for the repository in the open tab every ${interval} minutes, so Pull and Push show what the server has. This is the only network access 🌱 Twig makes by itself. Branches, files and tags stay as they are.`;
}

/**
 * How the open repository's schedule stands, or '' when it is off.
 * @param {{ interval: number, lastSuccess: ?number, error: ?string, running: boolean }} status  times in ms
 */
export function fetchStatusLine(status, now = Date.now()) {
  if (!status?.interval) return '';
  if (status.running) return t('Fetching now…');
  if (status.error) return tr(status.error);
  if (status.lastSuccess) return t`Last fetched ${relativeTime(status.lastSuccess / 1000, now)}.`;
  return t('Not fetched yet; the first fetch starts a few seconds after a repository opens.');
}

/** The Pull button's tooltip: how fresh the badges are. */
export function pullTitle(status, now = Date.now()) {
  if (!status?.interval) return t('Pull · the badge shows what your last fetch knew');
  if (status.error) return t`Pull · background fetch failed: ${tr(status.error)}`;
  return status.lastSuccess ? t`Pull · remote checked ${relativeTime(status.lastSuccess / 1000, now)}` : t('Pull · background fetch has not run yet');
}
