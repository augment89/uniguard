/* =========================================================================
   Service Worker — تطبيق حضور الحماية العالمية (UniGuard)
   - يخزّن نماذج التعرف على الوجه ومكتبة face-api والخطوط بشكل دائم
   - يجعل التطبيق يفتح بدون إنترنت بعد أول زيارة
   - لا يتدخل أبدًا في طلبات المزامنة مع Google Sheet (POST / script.google.com)
   ضع هذا الملف بجانب app.html في نفس المجلد (مجلد public، وعلى https).
   ========================================================================= */

const VERSION = '2.9.4'; // يطابق APP_VERSION في js/config.js و ?v= في app.html؛ تغييره يحدّث الملفات المخزنة على الأجهزة
const SHELL_CACHE = 'hudurak-shell-' + VERSION;   // صفحة التطبيق وملفاته
const MODELS_CACHE = 'hudurak-models-v1';         // نماذج الوجه (ثقيلة، لا تتغير)
const LIB_CACHE = 'hudurak-lib-v1';               // مكتبة face-api
const FONT_CACHE = 'hudurak-fonts-v1';            // خطوط Google

const ALL_CACHES = [SHELL_CACHE, MODELS_CACHE, LIB_CACHE, FONT_CACHE];

// نسختان مستقلتان من هذا الملف: تطبيق العمال (نطاق ./) وتطبيق الإدارة (نطاق ./admin.html).
// لكل منهما اشتراك إشعارات وهوية خاصة، فلا يتداخلان إذا ثُبّت التطبيقان على نفس الجهاز.
const isAdminUrl = (u) => /\/admin\.html$/.test(new URL(u).pathname);
const ADMIN_SW = isAdminUrl(self.registration.scope);
const mine = (w) => isAdminUrl(w.url) === ADMIN_SW; // نافذة تخص هذا التطبيق (لا التطبيق الآخر)

// نطاقات لا يجوز للـ SW لمسها إطلاقًا (مزامنة الشيت وتسجيل الدخول)
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'accounts.google.com',
  'docs.google.com'
];

/* ---------------------------- التثبيت ---------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // تخزين مسبق "بأفضل جهد": فشل أي ملف لا يُفشل التثبيت
    const cache = await caches.open(SHELL_CACHE);
    const base = new URL('./', self.registration.scope).href, q = '?v=' + VERSION; // مجلد التطبيق (نطاق الإدارة ينتهي بـ admin.html)
    const pages = [base, base + 'index.html', base + 'app.html', base + 'admin.html', base + 'verify.html'];
    await Promise.all(
      [...pages, base + 'manifest.webmanifest', base + 'manifest-admin.webmanifest',
       base + 'css/app.css' + q, base + 'js/config.js' + q, base + 'js/app.js' + q, base + 'js/install.js' + q,
       base + 'img/logo.png', base + 'img/logo-admin.png', base + 'icon-admin-192.png', base + 'apple-touch-icon-admin.png', base + 'icon-192.png', base + 'icon-512.png', base + 'apple-touch-icon.png'].map(async (url) => {
        try {
          const page = pages.includes(url);
          // الصفحات برابط مميز للإصدار: ذاكرة GitHub المؤقتة قد تعطي الصفحة القديمة دقائق بعد النشر،
          // فتُخزَّن هنا مع ملفات الإصدار الجديد ويبقى المستخدم على القديم بعد «تحديث الآن»
          const res = await fetch(page ? url + q : url, { cache: 'reload' });
          if (!res || !res.ok || res.redirected) return;
          if (page) {
            const html = await res.clone().text();
            if (/\?v=/.test(html) && !html.includes(q)) return; // نسخة قديمة: تُجلب لاحقًا عند الفتح
          }
          await cache.put(url, res);
        } catch (e) { /* بدون اتصال أثناء التثبيت: لا مشكلة */ }
      })
    );
    await self.skipWaiting();
  })());
});

/* ---------------------------- التفعيل ---------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('hudurak-') && n !== 'hudurak-meta' && !ALL_CACHES.includes(n))
        .map((n) => caches.delete(n))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

/* ---------------------------- إشعارات الهاتف ----------------------------
   التطبيق يرسل هوية المستخدم (رقمه ومعرف جهازه، أو رمز الإدارة) فتُحفظ هنا، لأن الـ Service Worker
   لا يصل إلى localStorage. عند وصول تنبيه يجلب بها نصوص الإشعارات الجديدة من الخادم ويعرضها. */
const META_CACHE = 'hudurak-meta';
const IDENTITY_KEY = ADMIN_SW ? '/__identity_admin' : '/__identity';
async function getIdentity() {
  const r = await (await caches.open(META_CACHE)).match(IDENTITY_KEY);
  return r ? r.json() : null;
}
async function setIdentity(obj) {
  const c = await caches.open(META_CACHE);
  if (!obj) return c.delete(IDENTITY_KEY);
  return c.put(IDENTITY_KEY, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'identity') {
    event.waitUntil((async () => {
      if (!event.data.data) return setIdentity(null);
      const old = await getIdentity();
      const same = old && old.token === event.data.data.token && old.phone === event.data.data.phone;
      // since: آخر إشعار عُرض — لا نعيد عرض إشعارات قديمة عند تسجيل الدخول
      await setIdentity(Object.assign({}, event.data.data, { since: same && old.since ? old.since : Date.now() }));
    })());
  }
});

const NOTIF_ICON = ADMIN_SW ? 'icon-admin-192.png' : 'icon-192.png';
const NOTIF_OPTS = { icon: NOTIF_ICON, badge: NOTIF_ICON, dir: 'rtl', lang: 'ar', vibrate: [120, 60, 120] };
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(mine);
    const visible = wins.some((w) => w.visibilityState === 'visible');
    const id = await getIdentity();
    let items = [];
    if (id && id.url) {
      try {
        const data = id.token ? { token: id.token } : { phone: id.phone, deviceId: id.deviceId };
        data.since = id.since || 0;
        const res = await fetch(id.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ apiKey: id.apiKey, action: 'getNotifications', data }) });
        const j = await res.json();
        if (j.ok && Array.isArray(j.items)) items = j.items;
      } catch (e) { /* بلا اتصال: نعرض إشعارًا عامًا أدناه */ }
      if (items.length) { id.since = Math.max.apply(null, items.map((i) => i.timestamp)); await setIdentity(id); }
    }
    wins.forEach((w) => w.postMessage({ type: 'sync' })); // التطبيق المفتوح يحدّث شاشته فورًا
    if (visible) return; // التطبيق أمام المستخدم: يعرض التحديث داخله
    if (!items.length) {
      return self.registration.showNotification('UniGuard — الحماية العالمية', Object.assign({ body: 'لديك تحديث جديد — افتح التطبيق', tag: 'hudurak' }, NOTIF_OPTS));
    }
    for (const it of items.slice(-3)) {
      await self.registration.showNotification(it.title, Object.assign({ body: it.body, tag: it.tag || it.id, renotify: true }, NOTIF_OPTS));
    }
  })());
});

// الضغط على الإشعار: يُظهر نافذة التطبيق المفتوحة، أو يفتحه إن كان مغلقًا
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope) && mine(w));
    if (win) return win.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});

/* ------------------------- أدوات مساعدة ------------------------- */
function isCacheable(res) {
  // نقبل الردود الناجحة، والردود "opaque" (طلبات cross-origin بدون CORS)
  return res && (res.ok || res.type === 'opaque');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  let res = await network;
  // شبكة متقطعة (مثل خطأ 502 من النفق): محاولة ثانية، ثم أي نسخة محفوظة من نفس الملف — أفضل من صفحة بلا تنسيق
  if (!res || !res.ok) {
    const again = await fetch(request).catch(() => null);
    if (again && again.ok) { cache.put(request, again.clone()).catch(() => {}); return again; }
    const older = await cache.match(request, { ignoreSearch: true });
    if (older) return older;
    res = res || again;
  }
  return res || Response.error();
}

// الصفحة: من نسخة الجهاز فورًا (فتح سريع بلا انتظار الشبكة)، وتُحدَّث النسخة في الخلفية.
// نسخة الصفحة المخزنة تطابق دائمًا ملفات css/js في نفس الذاكرة (نفس VERSION)؛ الإصدار الجديد يصل
// بتحديث هذا الملف (يتحقق منه المتصفح عند كل فتح) فيظهر في الفتح التالي.
async function cacheFirstPage(event) {
  const request = event.request;
  const cache = await caches.open(SHELL_CACHE);
  // الصفحة تُحفظ بلا الاستعلام (?id=...): كل رابط تحقق من تقرير مختلف كان يضيف نسخة جديدة من نفس الصفحة
  const key = request.url.split(/[?#]/)[0];
  const network = (async () => {
    try {
      const res = (event.preloadResponse && await event.preloadResponse) || await fetch(request);
      if (res && res.ok && !res.redirected) {
        const html = await res.clone().text();
        // صفحة من إصدار أحدث لا تُخزَّن هنا (ملفاتها ليست في هذه الذاكرة) — يجلبها الـ SW الجديد
        if (!/\?v=/.test(html) || html.includes('?v=' + VERSION)) await cache.put(key, res.clone());
      }
      return res;
    } catch (e) { return null; }
  })();
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) { event.waitUntil(network); return cached; }
  const res = await network;
  if (res) return res;
  {
    const cached =
      (await cache.match(self.registration.scope, { ignoreSearch: true })) ||
      (await cache.match(new URL('index.html', self.registration.scope).href)) ||
      (await cache.match(new URL('app.html', self.registration.scope).href));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font-family:sans-serif;text-align:center;padding:40px;direction:rtl">' +
      '<h2>لا يوجد اتصال بالإنترنت</h2><p>افتح التطبيق مرة واحدة وأنت متصل ليعمل بعدها بدون إنترنت.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* --------------------------- الطلبات --------------------------- */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 1) أي طلب غير GET (ومنها POST لمزامنة الشيت) يمر مباشرة دون تدخل،
  //    وكذلك طلبات no-store (مثل فحص «هل يوجد إصدار جديد؟») فتصل للخادم ولا تُخزَّن
  if (request.method !== 'GET' || request.cache === 'no-store') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 2) نطاقات جوجل الخاصة بالشيت وتسجيل الدخول: لا نتدخل
  if (BYPASS_HOSTS.includes(url.hostname)) return;

  // 3) نماذج التعرف على الوجه — cache-first
  if (url.hostname === 'justadudewhohacks.github.io' && url.pathname.includes('/face-api.js/models')) {
    event.respondWith(cacheFirst(request, MODELS_CACHE));
    return;
  }

  // 4) مكتبة face-api من jsDelivr (نسخة مثبّتة) — cache-first
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('@')) { // نسخ مثبّتة فقط
    event.respondWith(cacheFirst(request, LIB_CACHE));
    return;
  }

  // 4ب) مكتبة إنشاء PDF من cdnjs (نسخة مثبّتة) — cache-first لتعمل بسرعة بعد أول استخدام
  if (url.hostname === 'cdnjs.cloudflare.com' && /\/(html2canvas|jspdf|qrcode-generator)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request, LIB_CACHE));
    return;
  }

  // 5) خطوط Google
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // 6) ملفات موقعك نفسه
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(cacheFirstPage(event));
    } else {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    }
    return;
  }

  // 7) أي شيء آخر: يمر كما هو
});