// Her notifications, while the page is not open. This worker exists for exactly two things:
// show what the host pushed, and open (or focus) her page when the owner taps it.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = { title: 'Fairy', body: '她找你有事。', url: '/fairy/app/' }
  try {
    data = { ...data, ...event.data.json() }
  } catch {
    // A push without a readable body still means she wants to say something.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'fairy',
      renotify: true,
      data: { url: data.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url ?? '/fairy/app/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.includes('/fairy/app/'))
      return open ? open.focus() : self.clients.openWindow(target)
    }),
  )
})
