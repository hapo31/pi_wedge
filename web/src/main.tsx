import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { History } from './History.js';
import './style.css';
createRoot(document.getElementById('root')!).render(
  window.location.pathname === '/history' ? <History /> : <App />,
);
