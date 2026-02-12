import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import Remote from './components/remote';
import MenuButton from './menu-button';
import { IMUProvider } from './contexts/IMUContext';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

// detect mobile/touch-capable devices and redirect to /remote
function isTouchDevice() {
  return (typeof window !== 'undefined') && (
    'ontouchstart' in window || navigator.maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

function Shell() {
  const pathname = (typeof window !== 'undefined') ? window.location.pathname : '/';
  const isRemote = pathname === '/remote';

  return (
    <div>
      {/* <MenuButton className="top-4 left-1/2 transform -translate-x-1/2 flex items-center justify-center text-white">
        <button onClick={() => { window.location.pathname = isRemote ? '/' : '/remote'; }}>
          {isRemote ? 'Dashboard' : 'Remote'}
        </button>
      </MenuButton> */}

      {isRemote ? (
        <Remote />
      ) : (
        <IMUProvider>
          <App />
        </IMUProvider>
      )}
    </div>
  );
}

root.render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>
);
// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
