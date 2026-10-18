const siteDocument = globalThis.document;
// The scenario tabs exist only on the main page; other pages use the reveals below.
const tablist = siteDocument.querySelector('.demo-tabs');
if (tablist) setupTabs(tablist);

function setupTabs(list) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => siteDocument.getElementById(tab.getAttribute('aria-controls')));
  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
      panels[i].classList.toggle('is-active', selected);
    });
    if (focus) tabs[index].focus();
  }
  panels.forEach((panel, index) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[index].id);
    panel.tabIndex = 0;
  });
  selectTab(0);
  list.hidden = false;
  list.addEventListener('click', event => {
    const index = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (index >= 0) selectTab(index);
  });
  list.addEventListener('keydown', event => {
    const current = tabs.indexOf(siteDocument.activeElement);
    if (current < 0) return;
    const next = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next, true);
  });
}

const motion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
let observer;
function observeReveals() {
  observer?.disconnect();
  if (motion.matches || !globalThis.IntersectionObserver) return;
  observer = new globalThis.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  siteDocument.querySelectorAll('[data-reveal]:not(.is-revealed)').forEach(element => observer.observe(element));
}
observeReveals();
motion.addEventListener('change', observeReveals);
globalThis.addEventListener('pagehide', () => observer?.disconnect());
globalThis.addEventListener('pageshow', observeReveals);

// First screen: the background loop plays muted, and the steps over it come
// in one at a time as the pinned stage scrolls. Reduced motion (or Save-Data)
// keeps the plain stacked layout over the poster; the loop then does not play.
const cinema = siteDocument.querySelector('.cinema');
if (cinema) setupCinema(cinema);

function setupCinema(section) {
  const video = section.querySelector('.cinema-video');
  const steps = [...section.querySelectorAll('.cinema-step')];
  const toggle = section.querySelector('.cinema-toggle');
  const cue = section.querySelector('.cinema-cue');
  const saveData = Boolean(globalThis.navigator.connection?.saveData);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  let userPaused = saveData;
  let onScreen = true;
  let frame = 0;

  const still = () => motion.matches;
  const syncPlayback = () => {
    if (still() || userPaused || !onScreen) video.pause();
    else video.play().catch(() => {});
  };
  const label = () => { toggle.textContent = video.paused ? 'Смотреть' : 'Пауза'; };

  function layout() {
    frame = 0;
    if (!section.classList.contains('is-scrolly')) return;
    const rect = section.getBoundingClientRect();
    const span = Math.max(1, rect.height - globalThis.innerHeight);
    const progress = clamp(-rect.top / span, 0, 1);
    const last = steps.length - 1;
    const half = 0.5 / last;
    steps.forEach((step, index) => {
      const offset = progress - index / last;
      let opacity = 1 - Math.abs(offset) / half;
      if ((index === 0 && offset < 0) || (index === last && offset > 0)) opacity = 1;
      opacity = clamp(opacity, 0, 1);
      step.style.opacity = String(opacity);
      step.style.transform = `translateY(${clamp(-offset / half, -1, 1) * 48}px)`;
      step.style.pointerEvents = opacity > 0.5 ? '' : 'none';
    });
    section.style.setProperty('--shade', String(0.86 + 0.14 * progress));
    section.style.setProperty('--zoom', String(1 + 0.08 * progress));
    if (cue) cue.style.opacity = String(clamp(1 - progress * 12, 0, 1));
  }
  const schedule = () => { if (!frame) frame = globalThis.requestAnimationFrame(layout); };

  function apply() {
    const scrolly = !still();
    section.classList.toggle('is-scrolly', scrolly);
    if (!scrolly) {
      steps.forEach(step => { step.style.opacity = ''; step.style.transform = ''; step.style.pointerEvents = ''; });
      section.style.removeProperty('--shade');
      section.style.removeProperty('--zoom');
    }
    toggle.hidden = !scrolly;
    syncPlayback();
    layout();
  }

  toggle.addEventListener('click', () => {
    userPaused = !video.paused;
    syncPlayback();
  });
  video.addEventListener('play', label);
  video.addEventListener('pause', label);
  // Tabbing into a step that is faded out scrolls the page to it.
  section.addEventListener('focusin', event => {
    const index = steps.findIndex(step => step.contains(event.target));
    if (index < 0 || !section.classList.contains('is-scrolly')) return;
    const span = section.offsetHeight - globalThis.innerHeight;
    globalThis.scrollTo({ top: section.offsetTop + span * index / (steps.length - 1), behavior: 'instant' });
  });
  if (globalThis.IntersectionObserver) {
    new globalThis.IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; syncPlayback(); }).observe(section);
  }
  globalThis.addEventListener('scroll', schedule, { passive: true });
  globalThis.addEventListener('resize', schedule);
  motion.addEventListener('change', apply);
  apply();
  label();
}
