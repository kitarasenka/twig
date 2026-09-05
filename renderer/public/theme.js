try {
  const saved = localStorage.getItem('git-desk:theme');
  const preference = ['dark', 'light'].includes(saved) ? saved : 'system';
  document.documentElement.dataset.theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
} catch {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
