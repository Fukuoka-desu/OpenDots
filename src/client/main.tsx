import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AvatarLab } from './AvatarLab';
import { Stage } from './Stage';
import './style.css';
import './editor.css';
const lab =
  import.meta.env.DEV && new URLSearchParams(location.search).has('avatar-lab');
const stage = new URLSearchParams(location.search).has('stage');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {lab ? <AvatarLab /> : stage ? <Stage /> : <App />}
  </React.StrictMode>,
);
