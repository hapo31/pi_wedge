import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import './style.css';
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
