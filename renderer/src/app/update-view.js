// Words for the in-app update, from the state main broadcasts. Only the i18n
// import: Vite and the Node check both load this module.
import { t, tr } from '../i18n/i18n.js';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return t`${Math.max(1, Math.round(bytes / 1024))} KB`;
  return t`${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function percent(progress) {
  if (!progress || !(progress.total > 0)) return 0;
  return Math.min(100, Math.floor(progress.received * 100 / progress.total));
}

/** What restarting does on this system — the button says it, the hint explains it. */
export function installVerb(state) {
  return state?.kind === 'deb' ? t`Install ${state.latest}` : t('Restart to update');
}

/**
 * The toolbar button: shown only while there is something to act on.
 * `action` is what a click does — `download`, `install` or `settings` (open
 * Settings, where progress, Cancel and the reason live).
 */
export function toolbarUpdate(state) {
  if (!state) return null;
  const version = state.latest;
  switch (state.status) {
    case 'available':
      return state.installable && !state.installReason
        ? { label: t`Update to ${version}`, action: 'download', icon: 'download',
          title: state.error ? t`${tr(state.error)} Press to try again.` : t`Download and install 🌱 Twig ${version}` }
        : { label: t`${version} available`, action: 'settings', icon: 'download',
          title: tr(state.installReason) || t`🌱 Twig ${version} is available` };
    case 'downloading':
      return { label: t`Downloading ${percent(state.progress)}%`, action: 'settings', icon: 'progress', title: t('Open Settings to follow or cancel the download') };
    case 'preparing':
      return { label: t('Preparing update…'), action: 'settings', icon: 'progress', title: t('Checking the download and unpacking it') };
    case 'ready':
      return { label: installVerb(state), action: 'install', icon: 'restart',
        title: tr(state.error) || (state.kind === 'deb'
          ? t`Open the ${version} package in your system installer`
          : t`Close 🌱 Twig and reopen it as ${version}`) };
    case 'installing':
      return { label: t('Restarting…'), action: null, icon: 'progress', title: t('Restarting into the new version') };
    default:
      return null;
  }
}

/** One sentence for Settings → Updates about where things stand. */
export function updateStatusLine(state) {
  if (!state) return '';
  const version = state.latest;
  switch (state.status) {
    case 'checking': return t('Checking GitHub for a newer release…');
    case 'current': return t`🌱 Twig ${state.current} is the latest release.`;
    case 'available':
      if (state.error) return tr(state.error);
      if (state.installReason) return `${t`Version ${version} is available. You have ${state.current}.`} ${tr(state.installReason)}`;
      return t`Version ${version} is available. You have ${state.current}.`;
    case 'downloading': {
      const { received = 0, total = 0 } = state.progress || {};
      return t`Downloading ${version}: ${formatBytes(received)} of ${formatBytes(total)}.`;
    }
    case 'preparing': return state.kind === 'mac'
      ? t`Checking the download and copying 🌱 Twig ${version} next to this one…`
      : t`Checking the download of ${version}…`;
    case 'ready':
      if (state.error) return tr(state.error);
      return state.kind === 'deb'
        ? t`${version} is downloaded and checked, saved as ${state.savedTo}. Installing it opens your system’s package installer.`
        : state.kind === 'win'
          ? t`${version} is downloaded and checked. Restarting runs its installer and opens the new version.`
          : t`${version} is downloaded and checked. Restarting closes this window and opens ${version}.`;
    case 'installing': return t('Restarting into the new version…');
    case 'handed-off': return t`The ${version} package is open in your system installer. Restart 🌱 Twig after installing it.`;
    case 'error': return tr(state.error) || t('The update check did not finish.');
    default: return '';
  }
}

export function autoCheckExplanation(auto) {
  return auto
    ? t('Reads the latest release on GitHub at launch and once a day. A new version shows as a button in the top bar; nothing is downloaded until you press it.')
    : t('Reads the latest release on GitHub only when you press Check for updates.');
}
