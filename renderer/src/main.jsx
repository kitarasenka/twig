import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/fira-sans/400.css';
import '@fontsource/fira-sans/500.css';
import '@fontsource/fira-sans/600.css';
import '@fontsource/fira-code/400.css';
import App from './app/App.jsx';
import ErrorBoundary from './ui/ErrorBoundary.jsx';
import { startLanguage } from './i18n/load.js';
import { getLocale } from './i18n/i18n.js';
import './ui/tokens.css';
import './ui/layout.css';
import './ui/history.css';
import './ui/automations.css';
import './ui/worktree.css';
import './ui/refs.css';
import './ui/ops.css';
import './ui/settings.css';
import './ui/repositories.css';

/** A language switch draws the window again from the top, in the new words. */
function Root() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const follow = () => setGeneration(value => value + 1);
    window.addEventListener('twig:language', follow);
    return () => window.removeEventListener('twig:language', follow);
  }, []);
  return <ErrorBoundary whole key={`${getLocale()}:${generation}`}><App /></ErrorBoundary>;
}

// The language comes before the first paint, so no screen flashes in English.
// A failed read leaves English; the app still opens.
startLanguage().finally(() => createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>));
