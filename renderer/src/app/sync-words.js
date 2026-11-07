import { mark, t } from '../i18n/i18n.js';

/** Whole phrases for the toolbar's Pull, Push, Stash and Pop: `push-upstream` is a mode, not a word. */
const WORDS = {
  pull: { finished: mark('Pull finished.'), running: mark('Pull is running'), wait: mark('Wait for the pull to finish') },
  push: { finished: mark('Push finished.'), running: mark('Push is running'), wait: mark('Wait for the push to finish') },
  stash: { running: mark('Stash is running'), wait: mark('Wait for the stash to finish') },
  pop: { running: mark('Stash pop is running'), wait: mark('Wait for the stash pop to finish') }
};
const words = mode => WORDS[mode.startsWith('push') ? 'push' : mode] ?? WORDS.pull;

export const syncFinished = mode => t(words(mode).finished);
export const syncRunning = mode => t(words(mode).running);
export const syncWait = mode => t(words(mode).wait);
