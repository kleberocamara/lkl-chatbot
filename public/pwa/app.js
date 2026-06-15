const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBQAK0QyrJI8mikxb4-RNP-597YKGU_iLw',
  authDomain: 'lkl-grafica.firebaseapp.com',
  projectId: 'lkl-grafica',
  storageBucket: 'lkl-grafica.firebasestorage.app',
  messagingSenderId: '985126589887',
  appId: '1:985126589887:web:c79a5e67ec106e41f77d0a',
};
const VAPID_KEY = 'BFVONu-p0mCpsmq9XqT6E0pqzBgEAUEzXq3W_oR7YeunPko4oDZ2fVoKjtTJIprWrQYhF1gijFqdho4vj54gqjs';

function getToken() { return localStorage.getItem('lkl_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('lkl_user')); } catch { return null; }
}
function logout() {
  localStorage.removeItem('lkl_token');
  localStorage.removeItem('lkl_user');
  window.location.href = '/pwa/login.html';
}
function requireAuth() {
  if (!getToken()) window.location.href = '/pwa/login.html';
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); return null; }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function initFCM() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (!window.firebase) return;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const fcmToken = await messaging.getToken({ serviceWorkerRegistration: reg, vapidKey: VAPID_KEY });
    if (fcmToken) {
      await api('POST', '/api/v2/notifications/token', { token: fcmToken });
    }
    messaging.onMessage((payload) => {
      const { title, body } = payload.notification;
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icons/icon-192.png' });
      }
    });
  } catch (e) {
    console.warn('[FCM] Erro ao inicializar:', e.message);
  }
}
