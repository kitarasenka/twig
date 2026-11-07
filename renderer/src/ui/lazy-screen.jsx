import { Suspense, lazy, useMemo, useState } from 'react';
import ErrorBoundary from './ErrorBoundary.jsx';
import { t } from '../i18n/i18n.js';

/**
 * A screen or dialog that is opened rarely, loaded the first time it is shown
 * instead of with the window. It brings its own Suspense, so the places that
 * render it stay as they are. The app's main bundle had grown past 500 KB.
 *
 * It also brings its own error boundary: a screen that fails to draw, or whose
 * chunk does not load, costs that screen and not the window. `lazy` remembers a
 * failed load, so Try again starts a new one.
 */
export default function lazyScreen(load) {
  const first = lazy(load);
  function LazyScreen(props) {
    const [attempt, setAttempt] = useState(0);
    const Screen = useMemo(() => (attempt ? lazy(load) : first), [attempt]);
    return <ErrorBoundary onRetry={() => setAttempt(value => value + 1)} onClose={props.onClose}>
      <Suspense fallback={<div className="loading-shell" aria-label={t('Loading screen')}><div className="skeleton" /></div>}><Screen {...props} /></Suspense>
    </ErrorBoundary>;
  }
  return LazyScreen;
}
