import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { consumeLink } from './lib/forms';
import './styles.css';

const actionLink = consumeLink();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App actionLink={actionLink} />
    </BrowserRouter>
  </React.StrictMode>
);
