// Words for the in-app update, from the state main broadcasts. No imports:
// Vite and the Node check both load this module.

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function percent(progress) {
  if (!progress || !(progress.total > 0)) return 0;
  return Math.min(100, Math.floor(progress.received * 100 / progress.total));
}

/** What restarting does on this system — the button says it, the hint explains it. */
export function installVerb(state) {
  return state?.kind === 'deb' ? `Install ${state.latest}` : 'Restart to update';
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
        ? { label: `Update to ${version}`, action: 'download', icon: 'download',
          title: state.error ? `${state.error} Press to try again.` : `Download and install 🌱 Twig ${version}` }
        : { label: `${version} available`, action: 'settings', icon: 'download',
          title: state.installReason || `🌱 Twig ${version} is available` };
    case 'downloading':
      return { label: `Downloading ${percent(state.progress)}%`, action: 'settings', icon: 'progress', title: 'Open Settings to follow or cancel the download' };
    case 'preparing':
      return { label: 'Preparing update…', action: 'settings', icon: 'progress', title: 'Checking the download and unpacking it' };
    case 'ready':
      return { label: installVerb(state), action: 'install', icon: 'restart',
        title: state.error || (state.kind === 'deb'
          ? `Open the ${version} package in your system installer`
          : `Close 🌱 Twig and reopen it as ${version}`) };
    case 'installing':
      return { label: 'Restarting…', action: null, icon: 'progress', title: 'Restarting into the new version' };
    default:
      return null;
  }
}

/** One sentence for Settings → Updates about where things stand. */
export function updateStatusLine(state) {
  if (!state) return '';
  const version = state.latest;
  switch (state.status) {
    case 'checking': return 'Checking GitHub for a newer release…';
    case 'current': return `🌱 Twig ${state.current} is the latest release.`;
    case 'available':
      if (state.error) return state.error;
      if (state.installReason) return `Version ${version} is available. You have ${state.current}. ${state.installReason}`;
      return `Version ${version} is available. You have ${state.current}.`;
    case 'downloading': {
      const { received = 0, total = 0 } = state.progress || {};
      return `Downloading ${version}: ${formatBytes(received)} of ${formatBytes(total)}.`;
    }
    case 'preparing': return state.kind === 'mac'
      ? `Checking the download and copying 🌱 Twig ${version} next to this one…`
      : `Checking the download of ${version}…`;
    case 'ready':
      if (state.error) return state.error;
      return state.kind === 'deb'
        ? `${version} is downloaded and checked, saved as ${state.savedTo}. Installing it opens your system’s package installer.`
        : state.kind === 'win'
          ? `${version} is downloaded and checked. Restarting runs its installer and opens the new version.`
          : `${version} is downloaded and checked. Restarting closes this window and opens ${version}.`;
    case 'installing': return 'Restarting into the new version…';
    case 'handed-off': return `The ${version} package is open in your system installer. Restart 🌱 Twig after installing it.`;
    case 'error': return state.error || 'The update check did not finish.';
    default: return '';
  }
}

export function autoCheckExplanation(auto) {
  return auto
    ? 'Reads the latest release on GitHub at launch and once a day. A new version shows as a button in the top bar; nothing is downloaded until you press it.'
    : 'Reads the latest release on GitHub only when you press Check for updates.';
}
