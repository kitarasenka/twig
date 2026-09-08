const siteDocument = globalThis.document;
const tablist = siteDocument.querySelector('.demo-tabs');
const tabs = [...tablist.querySelectorAll('[role="tab"]')];
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
tablist.hidden = false;
tablist.addEventListener('click', event => {
  const index = tabs.indexOf(event.target.closest('[role="tab"]'));
  if (index >= 0) selectTab(index);
});
tablist.addEventListener('keydown', event => {
  const current = tabs.indexOf(siteDocument.activeElement);
  if (current < 0) return;
  const next = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(next, true);
});

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
