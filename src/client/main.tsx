import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AvatarLab } from './AvatarLab';
import './style.css';
import './editor.css';
const lab =
  import.meta.env.DEV && new URLSearchParams(location.search).has('avatar-lab');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{lab ? <AvatarLab /> : <App />}</React.StrictMode>,
);
