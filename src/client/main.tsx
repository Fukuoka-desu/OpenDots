import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AvatarLab } from './AvatarLab';
import { Stage } from './Stage';
import { Usage } from './Usage';
import './style.css';
import './editor.css';
const lab =
  import.meta.env.DEV && new URLSearchParams(location.search).has('avatar-lab');
const params = new URLSearchParams(location.search);
const stage = params.has('stage');
const usage = params.has('usage');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {lab ? <AvatarLab /> : usage ? <Usage /> : stage ? <Stage /> : <App />}
  </React.StrictMode>,
);
