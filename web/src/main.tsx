import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './aster.css';
// After aster.css: the asset page's rules replace the ASTER ones of equal weight (.aster-desk .panel and the like).
import './asset.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
