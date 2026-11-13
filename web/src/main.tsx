import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './aster.css';
// After aster.css: the whole shell sits in .aster-desk, so on equal specificity the options page's own copy must win.
import './options.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
