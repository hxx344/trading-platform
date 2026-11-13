import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './aster.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
