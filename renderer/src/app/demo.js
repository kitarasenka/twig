const subjects = [
  ['main', 'Refine the workspace layout', 'Keep the details close to the history.', 'Maya Chen', 0],
  ['origin/main', 'Merge branch feature/command-log', 'Bring the command console into the workspace.', 'Maya Chen', 0],
  ['feature/command-log', 'Stream command output as it arrives', 'Make long operations easy to follow.', 'Alex Morgan', 1],
  ['', 'Add keyboard navigation to commit details', 'Keep selection visible when changing panels.', 'Maya Chen', 0],
  ['', 'Keep console entries between sessions', 'Remember the last command and its result.', 'Alex Morgan', 1],
  ['', 'Use local fonts throughout the app', 'The workspace stays available offline.', 'Maya Chen', 0],
  ['', 'Add duration to command entries', 'Show elapsed time alongside the exit code.', 'Alex Morgan', 1],
  ['v0.0.2', 'Merge branch feature/repository-tabs', 'Preserve context across repositories.', 'Maya Chen', 0],
  ['feature/repository-tabs', 'Remember selection for each tab', 'Keep filters and scroll position together.', 'Sam Rivera', 2],
  ['', 'Improve empty repository guidance', 'Explain how to get started.', 'Maya Chen', 0],
  ['', 'Add close controls to workspace tabs', 'Closing a tab never removes files.', 'Sam Rivera', 2],
  ['', 'Polish focus states in the sidebar', 'Make every action reachable by keyboard.', 'Maya Chen', 0],
  ['', 'Group branch names into folders', 'Keep long branch lists easy to scan.', 'Sam Rivera', 2],
  ['', 'Define light and dark surface colors', 'Follow the system appearance by default.', 'Maya Chen', 0],
  ['v0.0.1', 'Create the first workspace shell', 'A quiet home for your repositories.', 'Maya Chen', 0],
  ['', 'Set up the desktop application', 'Start with an isolated renderer process.', 'Maya Chen', 0]
];

export const commits = subjects.map(([ref, subject, body, author, lane], index) => ({
  id: (0xa4f891c - index * 79343).toString(16), ref, subject, body, author, lane,
  date: index < 7 ? '2 hours ago' : 'Yesterday',
  authored: index < 7 ? 'Sep 5, 2026 · 10:42' : 'Sep 4, 2026 · 16:08',
  files: index === 0 ? ['renderer/src/app/App.jsx', 'renderer/src/ui/layout.css', 'design/TOKENS.md']
    : ['renderer/src/app/workspace.js', 'README.md'],
  parentIndex: index < subjects.length - 1 ? index + 1 : null
}));

export const sections = [
  ['LOCAL', ['main', 'feature/command-log', 'feature/repository-tabs']],
  ['REMOTE', ['origin/main']], ['STASHES', []],
  ['TAGS', ['v0.0.2', 'v0.0.1']], ['REMOTES', ['origin']]
];
