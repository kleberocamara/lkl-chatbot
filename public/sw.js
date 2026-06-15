importScripts('/js/firebase/firebase-app-compat.js');
importScripts('/js/firebase/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBQAK0QyrJI8mikxb4-RNP-597YKGU_iLw',
  authDomain: 'lkl-grafica.firebaseapp.com',
  projectId: 'lkl-grafica',
  storageBucket: 'lkl-grafica.firebasestorage.app',
  messagingSenderId: '985126589887',
  appId: '1:985126589887:web:c79a5e67ec106e41f77d0a',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data,
  });
});

const CACHE = 'lkl-pwa-v1';
const OFFLINE_URLS = ['/pwa/login.html', '/pwa/pedidos.html', '/pwa/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const pwa = list.find(c => c.url.includes('/pwa/'));
      if (pwa) return pwa.focus();
      return clients.openWindow('/pwa/pedidos.html');
    })
  );
});
