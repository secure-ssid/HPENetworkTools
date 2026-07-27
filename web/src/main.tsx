import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { NightdeskProvider, ToastProvider } from './nightdesk';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NightdeskProvider>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </NightdeskProvider>
  </React.StrictMode>,
);
