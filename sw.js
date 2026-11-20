importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyD0hZwfRfiYJliysT4v42JT0r7HV37IxIU",
  authDomain: "app-crm-camiones.firebaseapp.com",
  projectId: "app-crm-camiones",
  storageBucket: "app-crm-camiones.firebasestorage.app",
  messagingSenderId: "241190039626",
  appId: "1:241190039626:web:ebb95aca494519083df6b3",
  measurementId: "G-CZF5RBFQ68",
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: './img/logo-quzare.jpeg'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// ─── Caché ──────────────────────────────────────────────────────────────────
const CACHE_NAME = 'crm-camiones-v48';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './img/logo-quzare.jpeg'
];

// Instalar: guardar en caché y activar de inmediato
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Fetch: estrategia Network-First para HTML y JS (siempre busca lo más nuevo)
// Para el resto (imágenes, CDN) usa Cache-First.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;
  const isHtmlOrJs = url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname === '/';

  if (isLocal && isHtmlOrJs) {
    // Network First: descarga la versión más reciente; si falla usa caché
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const clonedResponse = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clonedResponse));
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache First para el resto (iconos, fuentes externas, etc.)
    event.respondWith(
      caches.match(event.request)
        .then((response) => response || fetch(event.request))
    );
  }
});

// Activar: limpiar cachés anteriores y tomar control inmediato
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[SW] Eliminando caché antigua:', cache);
            return caches.delete(cache);
          }
        })
      ).then(() => self.clients.claim());
    })
  );
});
