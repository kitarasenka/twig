import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/fira-sans/400.css';
import '@fontsource/fira-sans/500.css';
import '@fontsource/fira-sans/600.css';
import '@fontsource/fira-code/400.css';
import App from './app/App.jsx';
import './ui/tokens.css';
import './ui/layout.css';
import './ui/history.css';
import './ui/worktree.css';
import './ui/refs.css';
import './ui/ops.css';
import './ui/settings.css';
import './ui/repositories.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
