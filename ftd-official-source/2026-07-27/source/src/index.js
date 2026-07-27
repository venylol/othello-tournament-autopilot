import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
// import {Workbox, messageSW} from 'workbox-window';
import swDev from './swDev' 

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <App />
);
if('serviceWorker' in navigator) {
swDev();
}

reportWebVitals();




