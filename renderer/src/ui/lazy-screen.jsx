import { Suspense, lazy } from 'react';

/**
 * A screen or dialog that is opened rarely, loaded the first time it is shown
 * instead of with the window. It brings its own Suspense, so the places that
 * render it stay as they are. The app's main bundle had grown past 500 KB.
 */
export default function lazyScreen(load) {
  const Screen = lazy(load);
  function LazyScreen(props) {
    return <Suspense fallback={<div className="loading-shell" aria-label="Loading screen"><div className="skeleton" /></div>}><Screen {...props} /></Suspense>;
  }
  return LazyScreen;
}
