/* =========================================================================
   الجزء المشترك بين تطبيق العمال (app.html + worker.js) وتطبيق الإدارة (admin.html + admin.js):
   الاتصال بالخادم، صندوق الإرسال، الهوية المحلية، «حول التطبيق»، التحديثات، التحديث الخلفي، الإشعارات، والبدء.
   ما يخص كل تطبيق يُستدعى عبر «خطافات» يعرّفها ملفه بالأسماء نفسها:
     roleOnResponse(res, action)  بيانات مرفقة بكل رد من الخادم
     roleOutboxAuth()             هوية إرسال العمليات المؤجلة (أو null بلا جلسة)
     roleOutboxDone(it, res, err) نتيجة عملية مؤجلة وصلت متأخرة
     roleNotify(tag, title, body) إشعار للمستخدم (العامل يحفظه في مركز إشعاراته)
     roleShowScreen(id)           عند تبديل الشاشة
     roleSync(screen)             التحديث الخلفي للشاشة الظاهرة
     roleForceRefresh()           «اسحب للتحديث»: تحديث كامل
     roleRelock()                 العودة للتطبيق بعد دقيقة في الخلفية
     roleInit(handoff, updated)   بدء التطبيق
     logout(), unlockApp(), enablePasskey(), passkeyLater()   أزرار مشتركة في الصفحتين
   ========================================================================= */
const $id = id => document.getElementById(id);
const ADMIN_MODE = IS_ADMIN_APP; // admin.html (من config.js)
// الصفحة لا تتحرك خلف الشاشات الثابتة (التحميل، التثبيت، القفل) — تُحسب من الحالة الفعلية في كل تغيير للشاشات
// (ومن المؤقت الدوري احتياطًا): لا يمكن أن تبقى الصفحة «مقفلة التمرير» بعد اختفائها
function updateScrollLock(){
  const vis = (id, cls) => { const e = $id(id); return !!e && !e.classList.contains(cls); };
  const splash = $id('splash'), splashOn = !!splash && !splash.classList.contains('sp-hide') && !splash.classList.contains('sp-out');
  document.documentElement.classList.toggle('scroll-lock', splashOn || vis('installGate', 'hidden') || vis('screen-lock', 'hidden'));
}
window.updateScrollLock = updateScrollLock;

/* =========================================================================
   شعار التطبيق (Uniguard) — مصدر واحد يُستخدم في الأيقونة وكل صور الشعار
   ========================================================================= */

function applyLogo(){
  const favicon = $id('appFavicon');
  if(favicon) favicon.href = IS_ADMIN_APP ? 'icon-admin-192.png' : LOGO_SRC;
  document.querySelectorAll('img.brand-logo').forEach(img => { img.src = UI_LOGO_SRC; });
}
applyLogo();

/* =========================================================================
   شاشة التحميل: تظهر من أول لحظة وتبقى حتى يجهز كل ما تحتاجه الشاشة الأولى.
   التقدم حقيقي (مكتبة الوجه، كل نموذج من الثلاثة، تجهيز المعالج الرسومي، الخادم) — لا عدّاد وهمي.
   ========================================================================= */
const Splash = (()=>{
  // داخل الحساب (sp-skip في رأس الصفحة) تبدأ مخفية: الإخفاء لا يفعل شيئًا، والإظهار الصريح (رسالة انتظار) يعيدها
  let pct = 0, gone = document.documentElement.classList.contains('sp-skip');
  function set(p, text){
    if(gone) return;
    pct = Math.max(pct, Math.min(100, Math.round(p)));
    $id('spBar').style.width = Math.max(pct, 4) + '%';
    $id('spPct').textContent = pct + '%';
    if(text) $id('spText').textContent = text;
  }
  function show(text){
    const el = $id('splash');
    gone = false; pct = 0;
    document.documentElement.classList.remove('sp-skip');
    el.classList.remove('sp-hide', 'sp-out');
    if(window.SplashFX) SplashFX.reset();
    $id('spErr').classList.add('hidden');
    set(10, text);
    updateScrollLock();
  }
  function hide(){
    if(gone) return;
    if(!window.SplashFX) set(100);
    gone = true;
    const el = $id('splash');
    const fadeStart = () => { el.classList.add('sp-out'); updateScrollLock(); };
    const fadeEnd = () => { if(gone) el.classList.add('sp-hide'); };
    // js/splash.js: يملأ شريط التحميل من النسبة الحالية إلى 100%، ثم ينقل الشعار إلى صفحة الدخول (إن كانت ظاهرة) أو يتلاشى
    if(window.SplashFX) SplashFX.out(fadeStart, fadeEnd, pct);
    else{ fadeStart(); setTimeout(fadeEnd, 380); }
  }
  function error(text){
    $id('spErrText').textContent = text;
    $id('spErr').classList.remove('hidden');
  }
  return { set, show, hide, error, isOn: ()=> !gone };
})();
/* =========================================================================
   إعدادات عامة — Configuration
   ========================================================================= */

/* =========================================================================
   الاتصال بالخادم (Google Apps Script) — المصدر الوحيد للبيانات
   كل قراءة وكل كتابة تمر من هنا. (النسخة المحلية على الجهاز للفتح السريع فقط — انظر CACHE_W/CACHE_A)
   ========================================================================= */

// نداء عام للخادم. يرمي خطأً واضحًا عند فشل الشبكة أو رفض الخادم للعملية.
let _apiCallsInFlight = 0;
function setApiBusy(busy){
  const bar = $id('apiProgressBar');
  if(!bar) return;
  if(busy){ _apiCallsInFlight++; bar.classList.add('show'); }
  else{ _apiCallsInFlight = Math.max(0, _apiCallsInFlight-1); if(_apiCallsInFlight===0) bar.classList.remove('show'); }
}

// عمليات القراءة الآمنة لإعادة المحاولة. عمليات الكتابة تُعاد أيضًا لكن بنفس requestId
// فيتعرّف الخادم على التكرار ويعيد النتيجة السابقة بدل التنفيذ مرتين.
const API_TIMEOUT_MS = 25000;
const API_RETRIES = 2;
const _inFlight = new Map(); // نداءات متطابقة متزامنة (نقرة مزدوجة) تشترك في نفس الطلب

function newRequestId(){ return (crypto.randomUUID ? crypto.randomUUID() : uid() + uid()); }

// التصفية الشهرية تكتب الأرشيف وورقة التقرير وقد تتجاوز 25 ثانية على Google: مهلة أطول حتى لا تظهر
// "انتهت المهلة" بينما التصفية نجحت فعلًا
const LONG_ACTIONS = { closeMonthForAll:1, previewMonthReport:1, getArchive:1, getAdminData:1, adminLogin:1, adminUnlock:1 };
async function fetchWithTimeout(body, timeoutMs = API_TIMEOUT_MS){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    return await fetch(WEB_APP_URL, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      // text/plain يتجنب طلب الفحص المسبق (preflight) الذي لا يدعمه Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body
    });
  } finally { clearTimeout(timer); }
}

// opts.silent: طلب خلفي (التحديث الدوري) — بلا شريط تحميل وبلا إعادة محاولات
function apiCall(action, data = {}, opts = {}){
  const key = action + '|' + JSON.stringify(data);
  if(_inFlight.has(key)) return _inFlight.get(key);
  const p = _apiCallOnce(action, data, opts).finally(()=> _inFlight.delete(key));
  _inFlight.set(key, p);
  return p;
}

// opts.requestId: رقم طلب ثابت (إعادة إرسال عملية من صندوق الإرسال — الخادم ينفّذها مرة واحدة فقط)
// خطأ الاتصال (لا شبكة/مهلة/خادم غير متاح) يُعلَّم بـ net: التطبيق لا يعرضه كخطأ، بل يكمل ويعيد المحاولة تلقائيًا
/* سجل المطوّر للاتصال: كل طلب (العملية، المدة، الحالة، سبب الفشل) في ذاكرة التطبيق (آخر 40) وفي Console المتصفح.
   يظهر في «حول التطبيق ← تشخيص الاتصال» بلوحة الإدارة. لا تُسجَّل بيانات شخصية (لا أرقام، لا رموز، لا بصمات) */
const API_LOG = [];
let _lastOkAt = 0;
function apiLog(action, ms, status, note){
  if(status === 'ok') _lastOkAt = Date.now();
  API_LOG.push({ t: Date.now(), action, ms, status, note: note || '' });
  if(API_LOG.length > 40) API_LOG.shift();
  if(status !== 'ok') console.warn('[UniGuard API]', action, status, ms + 'ms', note || '');
}
async function _apiCallOnce(action, data, opts = {}){
  const silent = !!opts.silent, t0 = performance.now();
  if(!silent) setApiBusy(true);
  const body = JSON.stringify({ apiKey: SHEET_API_KEY, action, data, requestId: opts.requestId || newRequestId() });
  try{
    let res, lastErr;
    for(let attempt = 0; attempt <= (silent ? 0 : API_RETRIES); attempt++){
      if(attempt) await sleep(600 * attempt);
      let response;
      try{ response = await fetchWithTimeout(body, LONG_ACTIONS[action] ? 90000 : API_TIMEOUT_MS); }
      catch(error){
        lastErr = new Error(error.name === 'AbortError'
          ? 'انتهت مهلة الاتصال بالخادم، حاول مجددًا'
          : 'تعذر الاتصال بالخادم، تحقق من اتصال الإنترنت وحاول مجددًا');
        apiLog(action, Math.round(performance.now() - t0), error.name === 'AbortError' ? 'timeout' : 'network', 'محاولة ' + (attempt + 1));
        continue; // خطأ شبكة: نعيد المحاولة بنفس requestId
      }
      if(!response.ok && (response.status >= 500 || response.status === 429)){
        lastErr = new Error('الخادم مشغول لحظيًا، حاول بعد ثوانٍ');
        apiLog(action, Math.round(performance.now() - t0), 'http ' + response.status, 'محاولة ' + (attempt + 1));
        continue;
      }
      // صفحة خطأ من Google بدل البيانات (ضغط أو حصة مؤقتة): عابر — إعادة محاولة بصمت، لا «رد غير صالح»
      const text = await response.text().catch(() => '');
      try{ res = JSON.parse(text); }
      catch(error){
        lastErr = new Error('الخادم مشغول لحظيًا، حاول بعد ثوانٍ');
        // للمطوّر: بداية الصفحة التي وصلت بدل البيانات (عادة صفحة خطأ من Google: حصة، ضغط، صلاحيات النشر)
        apiLog(action, Math.round(performance.now() - t0), 'not-json ' + response.status, text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140));
        continue;
      }
      if(res && res.ok === false && res.busy){
        lastErr = new Error(res.error || 'الخادم مشغول لحظيًا');
        apiLog(action, Math.round(performance.now() - t0), 'busy', res.detail || '');
        res = null; continue;
      }
      break;
    }
    if(!res){ lastErr.net = true; setOffline(true); throw lastErr; }
    apiLog(action, Math.round(performance.now() - t0), res.ok ? 'ok' : 'rejected', res.ok ? '' : String(res.error || '').slice(0, 120) + (res.detail ? ' | ' + res.detail : ''));
    setOffline(false);
    if(res.v) setServerVersion(String(res.v));
    if(!res.ok){
      // الخادم لا يعرف هذه العملية = نسخة قديمة أو ناقصة منشورة (قد يحمل رقم الإصدار الجديد إن نُسخ Code.gs
      // ناقصًا): الإدارة ترى ما يجب فعله بالضبط (رسالة + بطاقة)، والعامل لا يرى رسالة تقنية
      if(/إجراء غير معروف/.test(res.error || '')){
        if(ADMIN_MODE){ _serverMissing = action; renderServerNotice(); }
        throw new Error(ADMIN_MODE ? 'الخادم المنشور لا يعرف هذه العملية (' + action + ') — انسخ ملف Code.gs كاملًا إلى Apps Script ثم Deploy ← New version' : 'هذه الميزة غير متاحة حاليًا');
      }
      throw new Error(res.error || 'رفض الخادم العملية');
    }
    roleOnResponse(res, action); // بيانات مرفقة بالرد (worker.js / admin.js)
    return res;
  } finally {
    if(!silent) setApiBusy(false);
  }
}

/* ---------- إصدار الخادم ----------
   كل رد من الخادم يحمل إصداره (v). إن لم يُنشر Code.gs الجديد (Deploy ← New version) تعرض لوحة الإدارة
   ما يجب فعله بالضبط (الواجهة تفترض الإصدار المطلوب: حمولات النسخ القديمة جدًا أُزيلت). */
const REQUIRED_SERVER = '2.14.0';
let _serverVer = null; // null: لم يُعرف بعد
let _serverMissing = ''; // عملية رد الخادم بأنه لا يعرفها (نسخة Code.gs ناقصة رغم رقم الإصدار)
const verNum = v => String(v || '0').split('.').reduce((n, x) => n * 1000 + (Number(x) || 0), 0);
function serverOutdated(){ return !!_serverMissing || (_serverVer !== null && verNum(_serverVer) < verNum(REQUIRED_SERVER)); }
function setServerVersion(v){
  if(v === _serverVer) return; // كل رد يحمل الإصدار نفسه: لا إعادة رسم مع كل طلب
  _serverVer = v;
  renderServerNotice();
}
// معلومات الخادم للإدارة فقط: بطاقة داخل "نظرة عامة" في لوحة الإدارة (لا تظهر للعمال ولا في صفحات الدخول)
function renderServerNotice(){
  const box = $id('serverNotice');
  if(!box) return;
  if(!serverOutdated()){ box.classList.add('hidden'); return; }
  box.innerHTML = (_serverMissing && !(verNum(_serverVer) < verNum(REQUIRED_SERVER))
      ? `<b>${icon('triangle-alert')} الخادم المنشور ناقص: لا يعرف العملية <span dir="ltr">${escapeHtml(_serverMissing)}</span> رغم أن إصداره <span dir="ltr">${escapeHtml(_serverVer)}</span></b>` +
        `<span>انسخ ملف Code.gs <b>كاملًا</b> (Ctrl+A ثم Ctrl+C) والصقه مكان الكود في Apps Script، احفظ، ثم <b>Deploy ← Manage deployments ← ✏️ ← Version: New version ← Deploy</b></span>`
      : `<b>${icon('triangle-alert')} الخادم (Code.gs) يعمل بالإصدار <span dir="ltr">${escapeHtml(_serverVer)}</span>، والتطبيق يحتاج <span dir="ltr">${REQUIRED_SERVER}</span></b>` +
        `<span>انشر آخر تحديث لتعمل كل التحسينات. في Apps Script: <b>Deploy ← Manage deployments ← ✏️ ← Version: New version ← Deploy</b></span>`);
  box.classList.remove('hidden');
}

// يوقظ خادم Apps Script مبكرًا (يقلل تأخير "البداية الباردة" لأول طلب فعلي)
function warmUpServer(){ try{ fetch(WEB_APP_URL, { mode:'no-cors' }).catch(()=>{}); }catch(e){} }

/* ---------- انقطاع الاتصال: لا رسائل خطأ ولا توقف ----------
   التطبيق يكمل من آخر نسخة محفوظة على الجهاز، وشريط صغير يبيّن الحالة. العمليات (الحضور وقرارات الإدارة)
   التي لم تصل تُحفظ في «صندوق الإرسال» على الجهاز وتُعاد تلقائيًا فور عودة الاتصال بنفس رقم الطلب
   (requestId) — الخادم يتذكر الطلب 6 ساعات فلا يُنفَّذ مرتين مهما تكررت المحاولة. */
let _offline = false;
function setOffline(on){
  if(on === _offline) return;
  _offline = on;
  renderNetBar();
  if(!on) setTimeout(flushOutbox, 0); // عاد الاتصال: يُرسل ما تأخر
}
function renderNetBar(){
  const n = outboxLoad().length, show = _offline || n > 0;
  let bar = $id('netBar');
  if(!show){ if(bar) bar.remove(); return; }
  if(!bar){ bar = document.createElement('div'); bar.id = 'netBar'; bar.className = 'net-bar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
  bar.classList.toggle('off', _offline);
  bar.innerHTML = _offline
    ? icon('triangle-alert') + ' لا يوجد اتصال بالخادم — تُعرض آخر بيانات محفوظة' + (n ? ` • ${n} بانتظار الإرسال` : '')
    : `${icon('refresh-cw', 'spin')} جاري إرسال ${n} عملية...`;
}
const OUTBOX_KEY = IS_ADMIN_APP ? 'hudurak_outbox_admin' : 'hudurak_outbox';
const OUTBOX_MAX_AGE = 5 * 3600e3; // أقل من مدة تذكّر الخادم للطلب (6 ساعات)
function outboxLoad(){ try{ return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }catch(e){ return []; } }
function outboxSave(list){
  try{ if(list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); else localStorage.removeItem(OUTBOX_KEY); }catch(e){}
  renderNetBar();
}
const outboxRemove = rid => outboxSave(outboxLoad().filter(x => x.rid !== rid));
// يرسل عملية؛ إن فشل الاتصال تُحفظ للإرسال التلقائي ويُعاد { queued:true } بدل الخطأ.
// الهوية (رمز الإدارة/جلسة العامل) لا تُحفظ مع العملية: تُضاف الحالية لحظة الإرسال
async function sendReliable(action, data, extra){
  const rid = newRequestId();
  try{
    if(_pendingUnlock) throw Object.assign(new Error('pending unlock'), { net: true }); // الجلسة لم تُؤكَّد بعد
    return await apiCall(action, data, { requestId: rid });
  }catch(e){
    if(!e.net) throw e;
    const keep = Object.assign({}, data); ['token', 'session', 'phone', 'deviceId', 'since', 'delta'].forEach(k => delete keep[k]);
    outboxSave(outboxLoad().concat([Object.assign({ rid, action, data: keep, at: Date.now(), day: todayStr() }, extra || {})]));
    return { queued: true };
  }
}
/* فتح بقفل الهاتف نجح على الجهاز ولم يصل تأكيد الخادم بعد (اتصال/ضغط لحظي): المستخدم داخل لوحته من النسخة
   المحفوظة، والتأكيد يُعاد تلقائيًا بنفس الطلب (الخادم يعيد نفس الجلسة لطلب مكرر). حتى يصل: لا تحديث خلفي
   (سيُرفض بلا جلسة فيُقفل التطبيق خطأً)، والعمليات تُحفظ في صندوق الإرسال */
/* فتح بلا إنترنت ولا تحدٍّ محفوظ من الخادم (local): بصمة الهاتف نفسها تتحقق من صاحبه على الجهاز، فتظهر آخر بيانات
   محفوظة (والحضور يُحفظ في صندوق الإرسال). لا جلسة من الخادم بعد — عند عودة الاتصال تُطلب البصمة مرة أخرى
   ليتحقق منها الخادم (p.reconnect في worker.js/admin.js)، ثم تُرسل العمليات المحفوظة وتُحدَّث البيانات */
let _pendingUnlock = null;
async function retryPendingUnlock(){
  const p = _pendingUnlock;
  if(!p || p.busy || navigator.onLine === false) return;
  if(p.local){
    if(Date.now() - (p.tried || 0) < 15000) return;
    p.busy = true; p.tried = Date.now();
    try{ await p.reconnect(); }catch(e){} finally{ p.busy = false; }
    return;
  }
  p.busy = true;
  let res;
  try{ res = await apiCall(p.action, p.data, { silent: true, requestId: p.rid }); }
  catch(e){ p.busy = false; if(e.net) return; _pendingUnlock = null; p.fail(e); return; }
  _pendingUnlock = null;
  await p.done(res);
  flushOutbox();
}
let _flushing = false;
async function flushOutbox(){
  if(_flushing || _pendingUnlock || navigator.onLine === false || !outboxLoad().length) return;
  _flushing = true;
  try{
    for(let it; (it = outboxLoad()[0]); ){
      // الحضور يُسجَّل بيوم وصوله للخادم: عملية من يوم سابق (أو قديمة جدًا) لا تُرسل
      if(Date.now() - it.at > OUTBOX_MAX_AGE || (it.action === 'checkin' && it.day !== todayStr())){ outboxRemove(it.rid); roleOutboxDone(it, null, 'expired'); continue; }
      const auth = roleOutboxAuth();
      if(!auth) break; // بلا جلسة الآن: يُرسل بعد الدخول
      let res;
      try{ res = await apiCall(it.action, Object.assign({}, it.data, auth), { silent: true, requestId: it.rid }); }
      catch(e){
        if(e.net || isLockedError(e) || /غير مصرح|الجلسة/.test(e.message)) break; // لاحقًا (اتصال/قفل/دخول)
        outboxRemove(it.rid); roleOutboxDone(it, null, e.message); continue; // رفض الخادم: لا فائدة من الإعادة
      }
      outboxRemove(it.rid); roleOutboxDone(it, res); // نتيجة وصلت متأخرة: نجاح (res) أو رفض (err)
    }
  }finally{ _flushing = false; }
}

/* =========================================================================
   الهوية المحلية: معرّف جهاز عشوائي، رقم العامل، وجلسة الإدارة
   ========================================================================= */
const DEVICE_KEY = "hudurak_device_id";
const ADMIN_TOKEN_KEY = "hudurak_admin_token";
const PHONE_KEY = "hudurak_last_phone"; // للتذكّر فقط، حتى لا يُعاد كتابة الرقم في كل مرة

let _deviceIdCache = null; // يمنع توليد معرّف عشوائي مختلف في كل نداء عند تعذّر localStorage
// معرّف الجهاز هو «مفتاح» ربط الهاتف بالحساب (يتحقق منه الخادم مع كل طلب): 128 بت عشوائية آمنة للأجهزة الجديدة
// (الأجهزة المسجّلة من قبل تحتفظ بمعرّفها)
const randomId = () => { try{ const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }catch(e){ return uid() + '-' + uid(); } };
function getDeviceId(){
  if(_deviceIdCache) return _deviceIdCache;
  try{
    let id = localStorage.getItem(DEVICE_KEY);
    if(!id){ id = randomId(); localStorage.setItem(DEVICE_KEY, id); }
    _deviceIdCache = id;
  }catch(e){
    _deviceIdCache = 'no-storage-' + uid(); // ثابت طوال هذه الجلسة على الأقل حتى لو تعذّر التخزين
  }
  return _deviceIdCache;
}
/* معلومات الهاتف للإدارة (تُسجَّل في الشيت مع ربط الجهاز): الطراز والنظام والمتصفح. أندرويد/Chrome يخفي الطراز
   ونسخة النظام من نص المتصفح (يظهر "Android 10; K" للجميع) — تُطلب من المتصفح نفسه (User-Agent Client Hints) */
let _devInfo = null;
function deviceInfo(){
  if(_devInfo) return _devInfo;
  const ua = navigator.userAgent, m = (re, i = 1) => { const x = ua.match(re); return x ? x[i] : ''; };
  const base = {
    model: /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : m(/Android [\d.]+; ([^;)]+?)(?: Build|\))/).replace(/^K$/, ''),
    os: /iPhone|iPad/.test(ua) ? 'iOS ' + m(/OS (\d+[_\d]*)/).replace(/_/g, '.') : /Android/.test(ua) ? 'Android ' + m(/Android ([\d.]+)/)
      : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '',
    browser: (/EdgA?\/(\d+)/.test(ua) ? 'Edge ' + m(/EdgA?\/(\d+)/) : /SamsungBrowser\/(\d+)/.test(ua) ? 'Samsung ' + m(/SamsungBrowser\/(\d+)/)
      : /(?:CriOS|Chrome)\/(\d+)/.test(ua) ? 'Chrome ' + m(/(?:CriOS|Chrome)\/(\d+)/) : /(?:FxiOS|Firefox)\/(\d+)/.test(ua) ? 'Firefox ' + m(/(?:FxiOS|Firefox)\/(\d+)/)
      : /Version\/(\d+).*Safari/.test(ua) ? 'Safari ' + m(/Version\/(\d+)/) : '')
  };
  const hints = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
    ? navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion']).then(h => {
        if(h.model) base.model = h.model;
        if(h.platform === 'Android' && h.platformVersion) base.os = 'Android ' + String(h.platformVersion).split('.')[0];
        return base;
      }).catch(() => base)
    : Promise.resolve(base);
  // مهلة قصيرة: لا يتأخر الدخول أبدًا بسببها
  return _devInfo = Promise.race([hints, sleep(700).then(() => base)]);
}
// جهاز الإدارة على هذا الهاتف: معرّف مفتاح بصمته واسم المستخدم و lock (الفتح بقفل الهاتف مفعّل؟) — ليس سرًا
// (المفتاح نفسه في شريحة أمان الهاتف). الفتح بقفل الهاتف اختياري مثل تطبيق العمال:
//  - غير مفعّل: الجلسة محفوظة على الجهاز، فيفتح التطبيق مباشرة على اللوحة
//  - مفعّل: الجلسة في الذاكرة فقط (إغلاق التطبيق = قفل)، ويُفتح ببصمة الإصبع/الوجه أو رمز الهاتف
const ADMIN_DEVICE_KEY = 'hudurak_admin_device';
function getAdminDevice(){ try{ const d = JSON.parse(localStorage.getItem(ADMIN_DEVICE_KEY) || 'null'); return d && typeof d === 'object' ? d : null; }catch(e){ return null; } }
function setAdminDevice(d){ try{ localStorage.setItem(ADMIN_DEVICE_KEY, JSON.stringify(d)); }catch(e){} }
function clearAdminDevice(){ try{ localStorage.removeItem(ADMIN_DEVICE_KEY); localStorage.removeItem('hudurak_admin_next'); }catch(e){} }
const adminLockOn = () => { const d = getAdminDevice(); return !!(d && d.lock); };
let _adminTok = '';
function getAdminToken(){ return _adminTok; }
function setAdminToken(t){
  _adminTok = t || '';
  try{ if(_adminTok && !adminLockOn()) localStorage.setItem(ADMIN_TOKEN_KEY, _adminTok); else localStorage.removeItem(ADMIN_TOKEN_KEY); }catch(e){}
}
function clearAdminToken(){ _adminTok = ''; try{ localStorage.removeItem(ADMIN_TOKEN_KEY); }catch(e){} }
function getRememberedPhone(){ try{ return localStorage.getItem(PHONE_KEY); }catch(e){ return null; } }
function setRememberedPhone(p){ try{ localStorage.setItem(PHONE_KEY, p); }catch(e){} }
function clearRememberedPhone(){ try{ localStorage.removeItem(PHONE_KEY); }catch(e){} }

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// جلسة العامل بعد فتح التطبيق بقفل الهاتف: في الذاكرة فقط (لا sessionStorage دائم — أندرويد يستعيده عند إعادة
// فتح التطبيق فكان يفتح دون قفل). أي فتح جديد للتطبيق = قفل الهاتف من جديد؛ إعادة التحميل وحدها تُبقي الجلسة
// (تسليم لمرة واحدة عبر takeUpdateHandoff)
let _wsCache = '';
function getWorkerSession(){ return _wsCache; }
function setWorkerSession(t){ _wsCache = t || ''; }
let currentPhone = null;  // العامل: الرقم المسجَّل به الدخول في هذه الجلسة
let currentWorker = null; // العامل: بيانات حسابه
function workerPhone(w){ return String((w && w.phone) || ''); }
const phoneKeyOf = p => String(p||'').replace(/\D/g,'').replace(/^0+/,'');
// الفتح بقفل الهاتف (العامل والإدارة): تحدي الفتح الجاهز، وحالة الفتح الجارية
let _lockOpts = null, _lockOptsAt = 0, _unlocking = false, _unlockFails = 0;
/* فتح القفل ببصمة الهاتف — نفس الخطوات للعامل والإدارة، والفروق تأتي من الدور (r) في worker.js / admin.js:
   r.prefetch()          تحدي الفتح (من الخادم أو محلي بلا إنترنت)
   r.allow(o)            معرّفات المفاتيح المسموحة
   r.nextKey             مفتاح «التحدي التالي» المحفوظ
   r.showCached(o)       يعرض اللوحة من النسخة المحفوظة فورًا، ويعيد true إن عرضها
   r.action / r.request(assertion)   إجراء الخادم وبياناته
   r.done(res, cred)     بعد تأكيد الخادم
   r.relock()            إعادة شاشة القفل
   r.precheck / r.onError(msg) / r.prefetchOnFail   اختيارية */
async function passkeyUnlockFlow(userTap, r){
  if(_unlocking) return;
  _unlocking = true;
  const btn = $id('lockBtn'), hint = $id('lockHint');
  btn.disabled = true;
  let shown = false, o = null, signed = false;
  try{
    if(r.precheck) r.precheck();
    o = await r.prefetch();
    if(!o) return;
    _lockOpts = null; // التحدي لمرة واحدة
    // client-device: قفل هذا الهاتف نفسه مباشرة (لا نافذة «استخدم جهازًا آخر» أو رمز QR)، بأي طريقة فتح مفعّلة فيه:
    // البصمة أو الوجه أو الرمز أو النمط أو كلمة السر
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64ToBytes(o.challenge),
      allowCredentials: r.allow(o).map(id => ({ type:'public-key', id: b64ToBytes(id), transports: ['internal'] })),
      userVerification: 'required', hints: ['client-device'], timeout: 120000 } });
    signed = true;
    if(o.fromNext) clearNext(r.nextKey);
    hint.textContent = 'جاري التحقق...';
    // تحقق الهاتف نجح: اللوحة من النسخة المحفوظة على الجهاز فورًا، والخادم يؤكد التوقيع ويحدّث البيانات خلال لحظات
    shown = !!r.showCached(o);
    if(o.local){ // بلا إنترنت: تبقى اللوحة على آخر بيانات محفوظة حتى يعود الاتصال
      if(!shown) throw new Error('لا يوجد اتصال بالإنترنت');
      _unlockFails = 0;
      toast('لا يوجد اتصال — تُعرض آخر بيانات محفوظة');
      return;
    }
    const resp = cred.response;
    const data = r.request({ credId: cred.id, clientDataJSON: bufToB64u(resp.clientDataJSON),
      authenticatorData: bufToB64u(resp.authenticatorData), signature: bufToB64u(resp.signature) });
    const done = res => r.done(res, cred);
    const rid = newRequestId();
    let res;
    try{ res = await apiCall(r.action, data, { requestId: rid }); }
    catch(e){
      // البصمة نجحت والخادم لم يُجب (اتصال/ضغط لحظي): تبقى اللوحة من النسخة المحفوظة، والتأكيد
      // يُعاد تلقائيًا بنفس الطلب حتى يصل — بلا طلب البصمة من جديد وبلا رسالة خطأ
      if(!(e.net && shown)) throw e;
      _pendingUnlock = { action: r.action, data, rid, done, fail: err => {
        r.relock(); $id('lockHint').textContent = err.message; if(r.prefetchOnFail) r.prefetch(); } };
      return;
    }
    await done(res);
  }catch(e){
    const msg = (e && e.message) || '';
    if(shown) r.relock(); // الخادم رفض: تعود شاشة القفل
    if(r.onError && r.onError(msg)) return;
    if(userTap) _unlockFails++;
    hint.textContent = e && e.name ? passkeyErrorText(e, 'الفتح') : msg || 'تعذر الفتح، حاول مجددًا';
    $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
    if(o && !signed){ _lockOpts = o; _lockOptsAt = Date.now(); } // لم يُرسل للخادم: نفس التحدي صالح للضغطة التالية
    else r.prefetch(); // تحدٍّ جديد جاهز للضغطة التالية
  }finally{ _unlocking = false; btn.disabled = false; }
}
// هوية العامل في كل طلب: الرقم + الجهاز المعتمد + جلسة القفل (إن وُجدت)
function workerAuth(extra){ return Object.assign({ phone: currentPhone, deviceId: getDeviceId(), session: getWorkerSession() }, extra || {}); }
const isLockedError = e => /مقفل/.test(e && e.message || '');

const RIYADH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Riyadh', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
function riyadhParts(date){
  return Object.fromEntries(RIYADH_FMT.formatToParts(date || new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function todayStr(){
  const p = riyadhParts();
  return `${p.year}-${p.month}-${p.day}`;
}
function monthStr(){ return todayStr().slice(0,7); }
// تاريخ/وقت بأرقام لاتينية وتوقيت الرياض (الأرقام الهندية مع "،" تنقلب ترتيبها داخل صورة التقرير)
function rptDateTime(v){
  const p = riyadhParts(v ? new Date(v) : new Date());
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
// التاريخ وحده بنفس الصيغة في كل مكان (2026-10-01، أرقام لاتينية وتوقيت الرياض) — بدل toLocaleDateString('ar-EG') بأرقام هندية
function rptDate(v){ return rptDateTime(v).slice(0, 10); }
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[char]));
}

/* ---------- دوال مساعدة مشتركة (بدل التكرار) ---------- */
// يوحّد شكل الرقم: أرقام لاتينية، بدون مسافات أو رموز، و 00 تتحول إلى +
function normalizePhone(raw){
  let v = String(raw || '')
    .replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[\u06F0-\u06F9]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/[\s\-().]/g, '');
  if(v.startsWith('00')) v = '+' + v.slice(2);
  return /^\+?\d{8,15}$/.test(v) ? v : '';
}

// الاسم: مسافات موحدة، واسم ثنائي على الأقل بحروف فقط (نفس تحقق الخادم)
const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim();
const validFullName = n => /^[ء-يٮ-ۓً-ٰٟa-zA-Z ]{5,60}$/.test(n) && n.split(' ').filter(p => p.length >= 2).length >= 2;
const PROFESSIONS = ['مليس', 'دهان', 'عامل'];

const isActive = w => (w.status||'active')==='active'; // الحسابات القديمة تُعامل كنشطة
const isPendingWorker = w => w.status==='pending';
// الأجر المحفوظ لحظة الحضور هو المعتمد؛ إن كان صفرًا/فارغًا نرجع لأجر العامل (مطابق للخادم)
const recordWage = (r, w) => (Number(r.wage) > 0 ? Number(r.wage) : (w ? Number(w.wage)||0 : 0));
const money = v => Math.round((Number(v)||0) * 100) / 100;
const fmt = v => money(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const dayKey = (month, d) => `${month}-${String(d).padStart(2,'0')}`;
const logKey = (workerId, date) => workerId + '|' + date;
const ATT_SYMBOL = {approved:'✓', rejected:'✗', pending:'○', absent:'—'};
const ATT_CLASS = {approved:'pill-approved', rejected:'pill-rejected', pending:'pill-pending'};

function setModal(id, show){ const m = $id(id); if(m) m.classList.toggle('hidden', !show); } // (بعض النوافذ في صفحة واحدة فقط)

/* ---------- حول التطبيق ---------- */
function openAbout(){
  $id('aboutName').textContent = APP_NAME_AR;
  $id('aboutNameEn').textContent = APP_NAME_EN;
  $id('aboutVersion').textContent = 'v' + APP_VERSION;
  $id('aboutCopy').textContent = `© ${APP_BUILD.slice(0, 4)} ${COMPANY_AR} — UniGuard. جميع الحقوق محفوظة.`;
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const notif = !('Notification' in window) ? 'غير مدعومة في هذا المتصفح'
    : Notification.permission === 'granted' ? (_pushActive ? 'مفعّلة (تصل والتطبيق مغلق)' : 'مفعّلة') : Notification.permission === 'denied' ? 'مرفوضة من إعدادات المتصفح' : 'غير مفعّلة';
  const user = getAdminToken() && visibleScreen() === 'screen-admin' ? 'الإدارة' : (currentWorker ? currentWorker.name : 'غير مسجل الدخول');
  const rows = [
    ['اسم التطبيق', APP_NAME_AR, 1], ['الشركة', COMPANY_AR + ' — UniGuard', 1],
    ['إصدار التطبيق', 'v' + APP_VERSION], ['تاريخ الإصدار', APP_BUILD],
    ['المستخدم الحالي', user, 1], ['طريقة التشغيل', standalone ? 'تطبيق مثبّت على الجهاز' : 'من المتصفح', 1],
    ['الإشعارات', notif, 1], ['الاتصال', navigator.onLine === false ? 'غير متصل' : _offline ? 'الخادم لا يُجيب حاليًا (يعاد تلقائيًا)' : 'متصل', 1],
    ['معرّف الجهاز', getDeviceId().slice(-10).toUpperCase()]
  ];
  // الإدارة فقط (لا معلومات خادم للعمال): إصدار الخادم وتاريخه (من الخادم نفسه لحظة الفتح) وآخر اتصال ناجح
  if(ADMIN_MODE) rows.splice(4, 0, ['إصدار الخادم', _serverVer ? 'v' + _serverVer : 'جارٍ الفحص...', 0, 'aboutServer'],
    ['آخر اتصال ناجح بالخادم', _lastOkAt ? rptDateTime(new Date(_lastOkAt).toISOString()) : '—']);
  $id('aboutInfo').innerHTML = rows.map(([k, v, ar, id]) =>
    `<tr><td>${escapeHtml(k)}</td><td class="${ar ? 'ar' : ''}"${id ? ` id="${id}"` : ''}>${escapeHtml(v)}</td></tr>`).join('');
  $id('aboutDiag').classList.toggle('hidden', !ADMIN_MODE);
  if(ADMIN_MODE) renderApiDiag();
  setModal('aboutModal', true);
  if(ADMIN_MODE) fetch(WEB_APP_URL, { cache: 'no-store' }).then(r => r.json()).then(j => {
    const el = $id('aboutServer');
    if(el && j && j.version) el.textContent = 'v' + j.version + (j.build ? ' — ' + j.build : '') + (serverOutdated() ? ' (يلزم ' + REQUIRED_SERVER + ')' : '');
  }).catch(() => {});
}
// آخر طلبات الاتصال (للمطوّر): العملية، المدة، النتيجة، وسبب الفشل إن وُجد
function renderApiDiag(){
  const list = API_LOG.slice(-15).reverse();
  $id('aboutDiagList').innerHTML = list.length ? list.map(e =>
    `<div class="diag-row ${e.status === 'ok' ? 'ok' : 'bad'}"><span dir="ltr">${escapeHtml(riyadhParts(new Date(e.t)).hour + ':' + riyadhParts(new Date(e.t)).minute)}</span>
      <b dir="ltr">${escapeHtml(e.action)}</b><span dir="ltr">${e.ms}ms</span><span>${escapeHtml(e.status)}</span>${e.note ? `<small>${escapeHtml(e.note)}</small>` : ''}</div>`).join('')
    : '<p class="al-hint">لا طلبات بعد</p>';
}
function closeAbout(){ setModal('aboutModal', false); }
// يجلب أحدث نسخة من التطبيق (الصفحة وملف الخدمة). لا إصدار جديد = لا شيء يُغلق.
// إصدار جديد = إعادة تحميل تُبقي المستخدم داخل حسابه وعلى شاشته (بلا قفل الهاتف ولا شاشة الدخول من جديد)
// الإصدار المنشور الآن على الموقع: يُقرأ من sw.js مباشرة من الخادم (لا من نسخة الجهاز)
async function latestPublishedVersion(){
  const res = await fetch('sw.js?check=' + Date.now(), { cache: 'no-store' });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const m = (await res.text()).match(/const VERSION = '([^']+)'/);
  return m ? m[1] : '';
}
// المقارنة بالإصدار المنشور فعلًا (لا بحالة Service Worker وحدها): الإصدار الجديد قد يُثبَّت ويُفعَّل خلال
// أجزاء من الثانية فلا يُرى «قيد التثبيت»، أو يكون نُزّل في الخلفية سابقًا والصفحة المفتوحة ما زالت القديمة
async function checkAppUpdate(){
  const btn = $id('aboutUpdateBtn'), label = btn.innerHTML; // (مع الأيقونة)
  const done = msg => { btn.disabled = false; btn.innerHTML = label; if(msg) toast(msg); };
  btn.disabled = true; btn.textContent = 'جارٍ البحث عن تحديث...';
  let latest = '';
  try{ latest = await latestPublishedVersion(); }catch(e){}
  if(!latest) return done(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذر البحث عن تحديث — حاول بعد قليل');
  if(!isNewerVersion(latest, APP_VERSION)) return done('لديك أحدث إصدار ✓ (v' + APP_VERSION + ')');
  btn.textContent = 'جارٍ تنزيل الإصدار ' + latest + '...';
  if(!await installUpdate(latest)) done('تعذر تنزيل التحديث — تحقق من الاتصال وحاول مرة أخرى');
}
// 2.10.0 أحدث من 2.9.3 (مقارنة رقمية لا نصية). نسخة أقدم من الموقع (ذاكرة مؤقتة لم تُحدَّث بعد) لا تُعد تحديثًا
function isNewerVersion(a, b){
  const x = String(a).split('.').map(n => parseInt(n, 10) || 0), y = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for(let i = 0; i < Math.max(x.length, y.length); i++) if((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
// ينزّل الإصدار الجديد ويتأكد أن صفحته صارت على الجهاز، ثم يعيد التحميل داخل نفس الحساب والشاشة.
// false = لم يكتمل التنزيل (لا إعادة تحميل بلا فائدة تُظهر النسخة القديمة نفسها)
let _updating = false;
async function installUpdate(latest){
  if(_updating) return true;
  _updating = true;
  try{
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if(reg){
      try{ await reg.update(); }catch(e){}
      // الصفحة تُفتح من نسخة الجهاز: ننتظر اكتمال تثبيت الإصدار الجديد وتفعيله قبل إعادة التحميل
      for(let i = 0; i < 100 && (reg.installing || reg.waiting); i++){
        if(reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        await sleep(200);
      }
      if(!await ensureUpdatedPage(latest)){ _updating = false; return false; }
    }
  }catch(e){ _updating = false; return false; }
  removeUpdateBar();
  toast('تم تنزيل الإصدار ' + latest + ' — يُفتح الآن...');
  stashUpdateHandoff(); // يبقى داخل حسابه وعلى شاشته بعد إعادة التحميل
  setTimeout(()=> location.reload(), 400);
  return true;
}
// صفحة الإصدار الجديد في ذاكرة الإصدار الجديد؟ (إن جلب sw.js نسخة قديمة من الصفحة من ذاكرة GitHub المؤقتة
// تُجلب هنا مباشرة من الموقع) — وإلا تُفتح بعد إعادة التحميل الصفحة القديمة ويبقى شريط التحديث ظاهرًا
async function ensureUpdatedPage(latest){
  if(!('caches' in window)) return true;
  const name = 'hudurak-shell-' + latest;
  if(!await caches.has(name)) return false; // ملف الخدمة الجديد لم يُثبَّت بعد
  const cache = await caches.open(name), key = location.href.split(/[?#]/)[0];
  const hit = await cache.match(key);
  if(hit && (await hit.text()).includes('?v=' + latest)) return true;
  const res = await fetch(key + '?v=' + latest + '&u=' + Date.now(), { cache: 'no-store' });
  if(!res.ok) return false;
  const html = await res.clone().text();
  if(!html.includes('?v=' + latest)) return false;
  await cache.put(key, res);
  return true;
}

/* ---------- إشعار «يوجد تحديث جديد» تلقائيًا (العمال والإدارة) ----------
   يُفحص الإصدار المنشور (ملف sw.js صغير على GitHub — لا ضغط على خادم Google): عند الفتح، عند العودة
   للتطبيق، وكل 30 دقيقة، وفور تثبيت المتصفح لإصدار جديد في الخلفية. يظهر شريط أعلى الشاشة بزر «تحديث الآن» */
let _latestVer = '', _updDismissed = '', _updCheckAt = 0;
async function checkUpdateQuiet(minGap){
  if(_updating || !location.protocol.startsWith('http') || navigator.onLine === false) return;
  if(Date.now() - _updCheckAt < minGap) return;
  _updCheckAt = Date.now();
  let latest = '';
  try{ latest = await latestPublishedVersion(); }catch(e){ return; }
  if(!isNewerVersion(latest, APP_VERSION)) return;
  if(latest !== _latestVer){
    _latestVer = latest;
    // تنزيل مسبق في الخلفية: ضغطة «تحديث الآن» تصبح شبه فورية
    if('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(()=>{});
  }
  renderUpdateBar();
}
function removeUpdateBar(){ const bar = $id('updateBar'); if(bar) bar.remove(); }
function renderUpdateBar(){
  if(!_latestVer || _latestVer === _updDismissed || _updating){ removeUpdateBar(); return; }
  let bar = $id('updateBar');
  if(bar) return;
  bar = document.createElement('div'); bar.id = 'updateBar'; bar.className = 'update-bar'; bar.setAttribute('role', 'alert');
  bar.innerHTML = `<span>${icon('refresh-cw')} يوجد تحديث جديد للتطبيق (v${escapeHtml(_latestVer)})</span>
    <button class="btn btn-amber btn-sm" id="updateNow">تحديث الآن</button><button class="btn btn-ghost btn-sm" id="updateLater" aria-label="لاحقًا">×</button>`;
  document.body.appendChild(bar);
  $id('updateLater').onclick = ()=>{ _updDismissed = _latestVer; removeUpdateBar(); }; // يعود عند فتح التطبيق من جديد
  $id('updateNow').onclick = async e => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'جارٍ التحديث...';
    if(!await installUpdate(_latestVer)){
      btn.disabled = false; btn.textContent = 'تحديث الآن';
      toast(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذر تنزيل التحديث — حاول مرة أخرى');
    }
  };
}
if('serviceWorker' in navigator){
  // المتصفح ثبّت إصدارًا جديدًا في الخلفية والصفحة المفتوحة ما زالت القديمة (أول تثبيت على الجهاز لا يُحسب)
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(hadController) checkUpdateQuiet(0); });
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') checkUpdateQuiet(5 * 60000); });
setTimeout(()=> checkUpdateQuiet(0), 8000); // بعد الفتح بقليل (لا يزاحم تحميل البيانات)
// تسليم الجلسة عبر إعادة تحميل الصفحة فقط (زر «تحديث»، أو إعادة تحميل من المتصفح): في sessionStorage لمرة واحدة
// ولـ 30 ثانية، ويُقبل فقط إن كان الفتح «إعادة تحميل» فعلًا — فتح التطبيق من جديد يطلب قفل الهاتف كالمعتاد
const UPDATE_HANDOFF = 'hudurak_update_handoff';
function stashUpdateHandoff(){
  const admin = ADMIN_MODE ? getAdminToken() : '', ws = ADMIN_MODE ? '' : getWorkerSession();
  try{ sessionStorage.setItem(UPDATE_HANDOFF, JSON.stringify({ at: Date.now(), v: APP_VERSION, admin, ws })); }catch(e){}
}
function takeUpdateHandoff(){
  let h = null;
  try{ h = JSON.parse(sessionStorage.getItem(UPDATE_HANDOFF) || 'null'); sessionStorage.removeItem(UPDATE_HANDOFF); }catch(e){}
  let reload = false; // صفحة أسقطها النظام ثم أعاد تحميلها (wasDiscarded) لا تُعامل كإعادة تحميل من المستخدم
  try{ const nav = performance.getEntriesByType('navigation')[0]; reload = !!nav && nav.type === 'reload' && !document.wasDiscarded; }catch(e){}
  return h && reload && Date.now() - Number(h.at) < 30000 ? h : null;
}
// الصفحة تُغلق (إعادة تحميل مثلًا): تُسلَّم الجلسة المفتوحة لتبقى داخل حسابك إن كانت إعادة تحميل
window.addEventListener('pagehide', e => { if(!e.persisted && (getAdminToken() || getWorkerSession())) stashUpdateHandoff(); });

// بحث غير حساس لحالة الأحرف ولا للتشكيل/الهمزات (مطابق لـ normName_ في الخادم): «احمد» تجد «أحمد»
const norm = v => String(v ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
  .replace(/[\u064B-\u0670\u065F\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
const matches = (q, ...fields) => !q || fields.some(f => norm(f).includes(q));
const searchQuery = id => norm($id(id)?.value);

// يرسم صفوف الجدول على دفعات (25 صفًا) مع زر "عرض المزيد" حتى تبقى الصفحة خفيفة مع مئات العمال
const PAGE_SIZE = 25;
const pageLimit = {};
function pageReset(bodyId){ delete pageLimit[bodyId]; }
function renderRows(bodyId, emptyId, items, rowFn, pageSize = PAGE_SIZE){
  const body = $id(bodyId);
  const limit = pageLimit[bodyId] || pageSize;
  body.innerHTML = items.slice(0, limit).map(rowFn).join('');
  $id(emptyId).classList.toggle('hidden', items.length > 0);

  const table = body.closest('table') || body; // يعمل مع الجداول ومع قوائم البطاقات
  const anchor = table.closest('.tbl-scroll') || table;
  let more = $id(bodyId + 'More');
  const rest = items.length - limit;
  if(rest > 0){
    if(!more){
      more = document.createElement('button');
      more.id = bodyId + 'More';
      more.className = 'btn btn-outline btn-sm more-btn';
      anchor.insertAdjacentElement('afterend', more);
    }
    more.textContent = `عرض المزيد (${rest} متبقٍ من ${items.length})`;
    more.classList.remove('hidden');
    more.onclick = ()=>{ pageLimit[bodyId] = limit + pageSize; renderRows(bodyId, emptyId, items, rowFn, pageSize); };
  }else if(more){
    more.classList.add('hidden');
  }
}

let toastTimer = null;
// حقل خاطئ: حدود حمراء واهتزاز قصير ثم التركيز عليه (تزول العلامة عند الكتابة)
function fieldError(id){
  const inp = $id(id), f = inp && inp.closest('.field');
  if(!f) return;
  f.classList.remove('is-err'); void f.offsetWidth; // إعادة تشغيل الاهتزاز إن تكرر الخطأ
  f.classList.add('is-err');
  inp.focus();
  inp.addEventListener('input', () => f.classList.remove('is-err'), { once: true });
}

function toast(msg){
  const t = $id('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer); // حتى لا يُخفي مؤقتٌ قديم الرسالة الجديدة
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

function showScreen(id){
  document.documentElement.classList.remove('booting'); // تقرر أي شاشة تظهر: لم نعد بحاجة لإخفاء شاشة الدخول
  bootMessage('');
  // شاشات هذه الصفحة فقط (app.html: شاشات العامل، admin.html: شاشات الإدارة)
  document.querySelectorAll('body > [id^="screen-"]').forEach(s => s.classList.toggle('hidden', s.id !== id));
  roleShowScreen(id);
  updateScrollLock();
}

// تقليل الحركة (إعداد الهاتف): يُحترم في حركات الصفحتين
const _reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// تسجيل Service Worker لتخزين ملفات نموذج الوجه بشكل دائم على الجهاز
// (يعمل فقط عند استضافة الصفحة عبر https أو localhost — لا يعمل بفتح الملف مباشرة)
let _swRegistered = false;
async function registerModelCacheSW(){
  if(_swRegistered) return;
  _swRegistered = true;
  if('serviceWorker' in navigator && location.protocol.startsWith('http')){
    try{
      // تطبيق الإدارة بنطاق خاص به (admin.html): إشعاراته وهويته منفصلة عن تطبيق العمال على نفس الجهاز
      if(IS_ADMIN_APP) await navigator.serviceWorker.register('sw.js', { scope: 'admin.html' });
      else await navigator.serviceWorker.register('sw.js');
      // تسجيل الإدارة القديم (نطاق app.html?admin من الإصدار السابق) لم يعد مستخدمًا
      (await navigator.serviceWorker.getRegistrations()).filter(r => /[?&]admin/.test(r.scope)).forEach(r => r.unregister());
    }catch(e){
      console.warn('تعذر تسجيل Service Worker (يتطلب استضافة عبر https)', e);
    }
  }
}

// مكتبة خارجية تُحمَّل عند الحاجة فقط (مرة واحدة لكل رابط؛ الفشل يسمح بمحاولة لاحقة).
// integrity (SRI): بصمة الملف المتوقعة — المتصفح يرفض نسخة معدّلة على الخادم الخارجي (CDN مخترق) فلا تُنفَّذ داخل التطبيق
const _scripts = {};
function loadScript(src, ready, id, integrity){
  if(ready()) return Promise.resolve();
  return _scripts[src] || (_scripts[src] = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    const fail = () => { sc.remove(); delete _scripts[src]; reject(new Error('تعذر تحميل ' + src)); };
    if(id) sc.id = id;
    if(integrity){ sc.integrity = integrity; sc.crossOrigin = 'anonymous'; }
    sc.src = src; sc.async = true;
    sc.onload = () => ready() ? resolve() : fail();
    sc.onerror = fail;
    document.head.appendChild(sc);
  }));
}
// تسجيل الـ Service Worker مبكرًا (شرط لظهور زر التثبيت في بعض المتصفحات) دون انتظار نماذج الوجه
registerModelCacheSW();

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
/* =========================================================================
   الفتح بقفل الهاتف (بصمة الإصبع/الوجه أو رمز الهاتف) — Passkeys / WebAuthn
   - عند التفعيل ينشئ الهاتف مفتاحًا سريًا في شريحة الأمان، لا يعمل إلا بعد قفل الهاتف.
   - عند كل فتح: الخادم يرسل تحديًا عشوائيًا، الهاتف يوقّعه بعد البصمة/الرمز، والخادم يتحقق من التوقيع.
   - فتح سريع: كل فتح ناجح يعيد معه «تحدي الفتح التالي» (لمرة واحدة، صالح أيامًا) يُحفظ على الجهاز، فتظهر
     نافذة البصمة فور فتح التطبيق بلا انتظار طلب تحدٍّ من الخادم.
   - التطبيق لا يرى البصمة ولا الرمز إطلاقًا. الجلسة في الذاكرة فقط: إغلاق التطبيق = قفل.
   ========================================================================= */
const PK_LATER = 'hudurak_pk_later';
// «تحدي الفتح التالي» (العامل: PK_NEXT، الإدارة: ADMIN_NEXT) — يُحذف لحظة إرساله للخادم (لمرة واحدة).
// إلغاء نافذة البصمة (أو آيفون يرفض فتحها تلقائيًا بلا ضغطة) لا يستهلكه: يبقى للضغطة التالية
const PK_NEXT = 'hudurak_pk_next', ADMIN_NEXT = 'hudurak_admin_next', NEXT_MAX_AGE = 13 * 864e5;
function peekNext(key, match){
  let n = null;
  try{ n = JSON.parse(localStorage.getItem(key) || 'null'); }catch(e){}
  if(n && n.c && Date.now() - Number(n.at) < NEXT_MAX_AGE && match(n)) return n;
  clearNext(key);
  return null;
}
function saveNext(key, obj){ if(obj.c) try{ localStorage.setItem(key, JSON.stringify(Object.assign({ at: Date.now() }, obj))); }catch(e){} }
const clearNext = key => { try{ localStorage.removeItem(key); }catch(e){} };
const RELOCK_MS = 60000;          // التطبيق في الخلفية أكثر من دقيقة → يُقفل عند العودة
const bufToB64u = buf => { const b = new Uint8Array(buf); let s = ''; for(let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// تحدٍّ عشوائي للفتح بلا إنترنت (لا يُرسل للخادم): البصمة تتحقق على الهاتف فقط
const localChallenge = () => bufToB64u(crypto.getRandomValues(new Uint8Array(32)));
const LOCAL_OPTS_MS = 60000; // صلاحية تحدي الفتح المحلي الجاهز (يُعاد السؤال عن الخادم بعدها)

// رسالة مفهومة لخطأ قفل الهاتف (WebAuthn) بدل نص المتصفح التقني — what: «التفعيل» أو «الفتح»
function passkeyErrorText(e, what){
  const n = e && e.name;
  if(n === 'NotAllowedError' || n === 'AbortError') return 'لم يكتمل ' + what + ' (أُلغي أو انتهى الوقت) — اضغط الزر وأدخل قفل هاتفك: البصمة أو الرمز أو النمط أو كلمة السر';
  if(n === 'InvalidStateError') return 'قفل الهاتف مسجّل على هذا الهاتف بالفعل — أعد فتح التطبيق';
  if(n === 'NotSupportedError') return 'هاتفك أو متصفحك لا يدعم الفتح بقفل الهاتف — حدّث المتصفح (Chrome أو Safari)';
  if(n === 'SecurityError') return 'يعمل فقط من رابط التطبيق الرسمي (https)';
  if(n === 'NotReadableError' || n === 'UnknownError') return 'تعذر الوصول لقفل الهاتف — تأكد أن قفل الشاشة مفعّل في إعدادات هاتفك، ثم حاول';
  return (e && e.message) || ('تعذر ' + what);
}
async function passkeySupported(){
  try{ return !!(window.PublicKeyCredential && window.isSecureContext && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch(e){ return false; }
}
// عودة للتطبيق بعد أكثر من دقيقة في الخلفية: يُقفل من جديد
let _hiddenAt = 0;
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'hidden'){ if(!_unlocking) _hiddenAt = Date.now(); return; }
  if(_hiddenAt && Date.now() - _hiddenAt > RELOCK_MS) roleRelock();
  _hiddenAt = 0;
});

/* =========================================================================
   التحديث الخلفي المستمر + الإشعارات
   - كل 20 ثانية (دقيقة إن كان التطبيق في الخلفية) يُسأل الخادم: هل تغيّر شيء منذ آخر إصدار؟
     إن لم يتغير يرد فورًا دون قراءة الشيت، وإن تغيّر تُجلب البيانات وتُحدَّث الشاشة.
   - أي تغيير يخص المستخدم (قبول حساب/جهاز، اعتماد أو رفض حضور، سلفة، تصفية، طلب جديد للإدارة)
     يظهر كإشعار من النظام إن سمح به، وإلا كرسالة داخل التطبيق.
   ========================================================================= */
const SYNC_MS = 20000, SYNC_HIDDEN_MS = 60000, FULL_REFRESH_MS = 5 * 60000;
const ADMIN_FULL_MS = 30 * 60000; // لوحة الإدارة تستلم «ما تغيّر فقط»؛ نسخة كاملة كل نصف ساعة للتصحيح الذاتي
let _syncBusy = false, _lastSyncAt = 0;

// الشاشة الرئيسية الظاهرة (لوحة/انتظار) — شاشات الدخول والقفل تُعاد فارغة. كل صفحة فيها شاشاتها فقط
function visibleScreen(){
  return ['screen-admin','screen-worker','screen-pending','screen-device-pending']
    .find(id => { const e = $id(id); return e && !e.classList.contains('hidden'); }) || '';
}
/* تخفيف الحمل على خادم Google (كل طلبات كل الهواتف تعمل باسم حساب المالك، ولـ Google حد لعدد التنفيذات
   المتزامنة — تجاوزه = صفحة «يتعذر فتح الملف» أو مهلة): فاصل التحديث عشوائي ±20% فلا تتزامن الهواتف في نفس
   اللحظة، وهاتف العامل أبطأ قليلًا من لوحة الإدارة، والفاصل يتضاعف ثلاث مرات (حتى دقيقة) ما دام الخادم لا يُجيب */
let _nextSyncWait = 0;
async function backgroundSync(force){
  if(_syncBusy || _unlocking || navigator.onLine === false) return; // أثناء الفتح بقفل الهاتف: الجلسة لم تصل بعد
  if(!force && Date.now() - _lastSyncAt < _nextSyncWait - 500) return;
  _syncBusy = true; _lastSyncAt = Date.now();
  const base = (document.visibilityState === 'hidden' ? SYNC_HIDDEN_MS : SYNC_MS) * (ADMIN_MODE ? 1 : 1.5);
  _nextSyncWait = (_offline ? Math.min(base * 3, 60000) : base) * (0.8 + Math.random() * 0.4);
  try{
    if(_pendingUnlock) return; // تأكيد الفتح لم يصل بعد (يُعاد في المؤقت الموحّد)
    // ما لم يصل للخادم بعد يُرسل أولًا؛ وإن بقي شيء فلا تُستبدل الشاشة ببيانات لا تحتويه
    if(outboxLoad().length){ await flushOutbox(); if(outboxLoad().length) return; }
    await roleSync(visibleScreen());
  }catch(e){ /* التحديث الخلفي لا يزعج المستخدم بأخطاء الشبكة؛ يحاول في الدورة التالية */ }
  finally{ _syncBusy = false; }
}

/* ---------- اسحب للتحديث داخل التطبيق ----------
   سحب الشاشة للأسفل (من أعلى الصفحة) يحدّث البيانات من الخادم دون إعادة تحميل التطبيق،
   فلا يُغلق ولا تظهر شاشة القفل أو الدخول من جديد. (سحب المتصفح الأصلي معطّل في app.css) */
(function(){
  const TRIGGER = 80;
  let y0 = null, dy = 0, busy = false, el = null;
  const ind = () => {
    if(el) return el;
    el = document.createElement('div'); el.id = 'ptr'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
    document.body.appendChild(el); return el;
  };
  const canPull = () => ['screen-admin','screen-worker','screen-pending','screen-device-pending'].includes(visibleScreen())
    && !document.querySelector('[id$="Modal"]:not(.hidden)') && !$id('notifBar');
  document.addEventListener('touchstart', e => {
    y0 = !busy && e.touches.length === 1 && window.scrollY <= 0 && canPull() ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if(y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if(dy <= 0 || window.scrollY > 0){ dy = 0; return; }
    const p = ind(), d = Math.min(dy * 0.5, 90);
    p.classList.add('pull'); p.classList.toggle('ready', dy >= TRIGGER);
    p.style.opacity = String(Math.min(1, dy / TRIGGER)); p.style.transform = `translateY(${d - 20}px) rotate(${dy * 2}deg)`;
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if(y0 == null) return;
    y0 = null;
    const p = ind(); p.classList.remove('pull');
    if(dy < TRIGGER){ p.style.opacity = '0'; p.style.transform = ''; return; }
    busy = true; p.classList.add('spin'); p.style.opacity = '1'; p.style.transform = 'translateY(40px)';
    try{
      if(navigator.onLine === false) toast('لا يوجد اتصال بالإنترنت');
      else{
        roleForceRefresh(); // تحديث كامل عند الطلب
        for(let i = 0; i < 60 && _syncBusy; i++) await sleep(100); // تحديث خلفي جارٍ: ننتظره ثم نحدّث
        await backgroundSync(true); toast('تم التحديث ✓');
      }
    }finally{
      busy = false; p.classList.remove('spin', 'ready'); p.style.opacity = '0'; p.style.transform = '';
    }
  });
})();
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') backgroundSync(true); });
window.addEventListener('online', ()=>{ retryPendingUnlock(); backgroundSync(true); });
window.addEventListener('offline', ()=> setOffline(true));

// ---------- إشعارات النظام ----------
function notifyUser(title, body, tag){
  const foreground = document.visibilityState === 'visible' && document.hasFocus();
  roleNotify(tag, title, body); // العامل: يُحفظ في مركز إشعاراته
  toast(body);
  if(foreground) return; // التطبيق أمام المستخدم: تكفي الرسالة داخله
  if(_pushActive) return; // الهاتف مشترك في الإشعارات: الخادم يرسلها بنفسه (لا نكررها)
  try{
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    const icon = ADMIN_MODE ? 'icon-admin-192.png' : 'icon-192.png'; // أيقونة التطبيق نفسه (الإدارة أو العمال)
    const opts = { body, tag: tag || 'hudurak', icon, badge: icon, lang: 'ar', dir: 'rtl', renotify: true, vibrate: [120, 60, 120] };
    if(navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(()=>{});
    else new Notification(title, opts);
  }catch(e){}
}
// إشعار على الهاتف حتى والتطبيق أمام المستخدم (تنبيهات مهمة: حالة الحضور). data يصل لـ sw.js عند الضغط عليه
// (checkin: يفتح تسجيل الحضور). بلا إذن الإشعارات: لا شيء (الرسالة داخل التطبيق تكفي)
function systemNotify(title, body, tag, data){
  try{
    if(!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
    const icon = ADMIN_MODE ? 'icon-admin-192.png' : 'icon-192.png';
    const opts = { body, tag: tag || 'hudurak', icon, badge: icon, lang: 'ar', dir: 'rtl', renotify: true, vibrate: [200, 100, 200], data: data || {} };
    navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(()=>{});
  }catch(e){}
}
// شريط "فعّل الإشعارات" (لوحة الإدارة؛ العامل له نافذة خاصة في worker.js): يظهر مرة واحدة فقط. بعد الضغط على
// "تفعيل" أو "×" لا يعود أبدًا على هذا الجهاز (كان يعود كل 3 ثوانٍ إن رُفض الطلب أو أُغلق دون قرار).
const NOTIF_ASKED = 'hudurak_notif_asked';
function notifAsked(){ try{ return localStorage.getItem(NOTIF_ASKED) === '1'; }catch(e){ return false; } }
function updateNotifBar(){
  let bar = $id('notifBar');
  const show = ADMIN_MODE && 'Notification' in window && Notification.permission === 'default' && !notifAsked()
    && visibleScreen() === 'screen-admin';
  if(!show){ if(bar) bar.remove(); return; }
  if(bar) return;
  bar = document.createElement('div'); bar.id = 'notifBar';
  bar.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 76px);left:50%;transform:translateX(-50%);z-index:150;background:#141a4d;color:#fff;border:2px solid #e7ad4f;border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:14px;max-width:calc(100% - 24px);';
  bar.innerHTML = '<span>' + icon('bell-ring') + ' فعّل الإشعارات لتصلك الموافقات حتى والتطبيق مغلق</span><button class="btn btn-amber btn-sm" id="notifYes">تفعيل</button><button class="btn btn-ghost btn-sm" id="notifNo" style="color:#fff;">×</button>';
  document.body.appendChild(bar);
  const done = ()=>{ try{ localStorage.setItem(NOTIF_ASKED, '1'); }catch(e){} bar.remove(); };
  $id('notifYes').onclick = async ()=>{
    done();
    let p = 'default';
    try{ p = await Notification.requestPermission(); }catch(e){}
    if(p === 'granted'){ toast('تم تفعيل الإشعارات ✓'); pushSubscribe(true); }
    else toast('لم يتم تفعيل الإشعارات — يمكنك تفعيلها لاحقًا من إعدادات المتصفح');
  };
  $id('notifNo').onclick = done;
}

// زر «تفعيل الإشعارات» في «إدارة الحساب» (العامل) و«🔐 الأمان» (الإدارة): الحالة الحالية + تفعيل بضغطة
function renderNotifRows(){
  const supported = 'Notification' in window && 'serviceWorker' in navigator && window.isSecureContext;
  const perm = supported ? Notification.permission : '';
  const text = !supported ? 'غير متاحة هنا — افتح التطبيق المثبّت على الشاشة الرئيسية (آيفون: iOS 16.4 أو أحدث)'
    : perm === 'granted' ? 'مفعّلة ✓ — تصلك الإشعارات حتى والتطبيق مغلق'
    : perm === 'denied' ? 'محظورة من إعدادات الهاتف — افتح إعدادات التطبيق ← الإشعارات ← سماح، ثم أعد فتحه'
    : 'غير مفعّلة — فعّلها لتصلك الموافقات والتحديثات حتى والتطبيق مغلق';
  // الزر ظاهر دائمًا (متى دعمها الهاتف) وتتغير حالته بعد التمكين (مثل زر قفل الهاتف):
  // غير مفعّلة ← «تمكين الإشعارات» (يطلب الإذن، ويسجّل الهاتف، ويرسل إشعارًا تجريبيًا)
  // مفعّلة ← «إرسال إشعار تجريبي» (يعيد تسجيل الهاتف ويرسل إشعارًا تجريبيًا)
  const on = perm === 'granted';
  [['notifStatus','notifBtn'], ['admNotifStatus','admNotifBtn']].forEach(([s, b]) => {
    const st = $id(s), btn = $id(b);
    if(!st) return;
    st.textContent = text; st.classList.toggle('on', on);
    btn.classList.toggle('hidden', !supported);
    if(btn.disabled) return; // أثناء التمكين/الإرسال: يبقى نص «جارٍ...» حتى ينتهي
    btn.textContent = on ? 'إرسال إشعار تجريبي' : 'تمكين الإشعارات';
    btn.classList.toggle('btn-outline', on); btn.classList.toggle('btn-amber', !on);
  });
}
/* «تجربة»: يطلب من الخادم إرسال إشعار تجريبي لهذا الهاتف عبر خدمة الإشعارات (نفس طريق الإشعارات الحقيقية
   والتطبيق مغلق)، ويشرح أين تتوقف السلسلة إن لم يصل */
async function testNotification(btn){
  const enabled = _pushActive; // مفعّلة من قبل: إرسال تجريبي فقط
  if(btn){ btn.disabled = true; btn.textContent = enabled ? 'جارٍ الإرسال...' : 'جارٍ التمكين...'; }
  try{
    if(!await pushSubscribe(true)) throw new Error(_pushErr || 'تعذر اشتراك هذا الهاتف في الإشعارات — تحقق من الاتصال وأعد المحاولة');
    const id = pushIdentity();
    if(!id) throw new Error('افتح حسابك أولًا ثم أعد المحاولة');
    const r = await apiCall('testPush', id);
    const ok = (r.codes || []).some(c => c >= 200 && c < 300);
    if(ok) return alert('✓ أُرسل الإشعار التجريبي.\n\nيجب أن يظهر في شريط إشعارات الهاتف خلال ثوانٍ (جرّب إغلاق التطبيق وإعادة التجربة).\n\nإن لم يظهر: من إعدادات الهاتف ← التطبيقات ← ' + (ADMIN_MODE ? 'UniGuard إدارة' : 'UniGuard') + ' (أو المتصفح) ← الإشعارات: اسمح بها، وأوقف وضع «عدم الإزعاج» وتوفير البطارية للتطبيق.');
    if(r.error && /permission|UrlFetch|authoriz|صلاحية/i.test(r.error))
      throw new Error(ADMIN_MODE ? 'الخادم لا يملك صلاحية إرسال الإشعارات بعد.\n\nافتح محرر Apps Script ← اختر الدالة setupPush من القائمة العلوية ← Run ← وافق على الصلاحيات. ثم أعد التجربة.'
        : 'خادم الإشعارات غير مفعّل بعد — أبلغ الإدارة.');
    if(r.error) throw new Error('تعذر الإرسال من الخادم: ' + r.error);
    if(!r.subs) throw new Error('هذا الهاتف غير مسجّل في الإشعارات لدى الخادم — أغلق التطبيق وافتحه ثم أعد التجربة');
    const c = (r.codes || [])[0];
    throw new Error(c === 403 || c === 401 ? 'رفضت خدمة الإشعارات مفتاح الخادم (' + c + ') — أعد فتح التطبيق ليُجدَّد الاشتراك ثم أعد التجربة'
      : c === 404 || c === 410 ? 'اشتراك هذا الهاتف انتهى — أعد فتح التطبيق ثم أعد التجربة'
      : 'ردّت خدمة الإشعارات بالرمز ' + c + ' — أعد المحاولة بعد قليل');
  }catch(e){
    alert('✗ لم يُرسل الإشعار\n\n' + (e.net ? 'لا يوجد اتصال بالخادم — تحقق من الإنترنت' : e.message));
  }finally{ if(btn) btn.disabled = false; renderNotifRows(); } // نص الزر حسب الحالة الجديدة (لا النص القديم)
}
// btn: زر «تمكين الإشعارات» (إدارة الحساب / الأمان) — بعد الإذن يُرسل إشعار تجريبي ويُشرح أي خلل.
// بلا btn (نافذة «فعّل الإشعارات» والشريط): الإذن والاشتراك فقط
async function enableNotifications(btn){
  try{ localStorage.setItem(NOTIF_ASKED, '1'); }catch(e){} // لا يعود الشريط العلوي بعد ذلك
  const bar = $id('notifBar'); if(bar) bar.remove();
  let p = 'Notification' in window ? Notification.permission : 'unsupported';
  if(p === 'default'){ try{ p = await Notification.requestPermission(); }catch(e){} }
  renderNotifRows();
  if(p === 'granted'){
    if(btn) return testNotification(btn);
    toast('تم تفعيل الإشعارات ✓'); pushSubscribe(true);
  }else if(p === 'denied'){
    const msg = 'الإشعارات محظورة لهذا التطبيق في إعدادات الهاتف.\n\nللسماح بها: الإعدادات ← التطبيقات ← ' + (ADMIN_MODE ? 'UniGuard إدارة' : 'UniGuard') + ' (أو المتصفح) ← الإشعارات ← سماح، ثم أعد فتح التطبيق واضغط «تمكين الإشعارات».';
    if(btn) alert(msg); else toast('رُفض الإذن — يمكنك السماح بالإشعارات من إعدادات الهاتف');
  }else if(p === 'unsupported'){
    if(btn) alert('هذا المتصفح لا يدعم الإشعارات — افتح التطبيق المثبّت على الشاشة الرئيسية (آيفون: iOS 16.4 أو أحدث).');
  }else toast('لم يتم تفعيل الإشعارات');
}

/* ---------- إشعارات تصل والتطبيق مغلق (Web Push) ----------
   الهاتف يشترك لدى خدمة الإشعارات الخاصة به (Google/Apple) بمفتاح الخادم العام، ويُرسل عنوان الاشتراك للخادم.
   عند أي حدث يرسل الخادم تنبيهًا فارغًا؛ فيستيقظ sw.js ويجلب النص ويعرضه — ولو كان التطبيق مغلقًا. */
let _pushActive = false, _pushOwnerDone = '', _pushFailAt = 0, _pushErr = '';
const b64ToBytes = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
function pushIdentity(){
  if(ADMIN_MODE){ const token = getAdminToken(); return token && visibleScreen() === 'screen-admin' ? { token } : null; }
  if(currentPhone) return { phone: currentPhone, deviceId: getDeviceId() };
  return null;
}
// يعيد true إن كان هذا الهاتف مشتركًا ومسجّلًا لدى الخادم (يُستخدم في «تجربة الإشعارات»)
async function pushSubscribe(force){
  try{
    _pushErr = '';
    if(!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)){ _pushErr = 'هذا المتصفح لا يدعم الإشعارات — افتح التطبيق المثبّت على الشاشة الرئيسية (آيفون: iOS 16.4 أو أحدث)'; return false; }
    if(Notification.permission !== 'granted'){ _pushErr = 'الإشعارات غير مسموحة لهذا التطبيق — اسمح بها من إعدادات الهاتف'; return false; }
    const id = pushIdentity(); if(!id) return false;
    const owner = id.token ? 'admin' : 'w:' + id.phone;
    if(!force && _pushOwnerDone === owner) return true;
    if(!force && Date.now() - _pushFailAt < 5 * 60000) return false; // فشل مؤخرًا: لا نكرر كل 4 ثوانٍ
    const reg = await navigator.serviceWorker.ready;
    const { key } = await apiCall('getPushKey', {}, { silent:true });
    let sub = await reg.pushManager.getSubscription();
    // اشتراك قديم بمفتاح مختلف (أُعيد توليد المفاتيح في الخادم): يُستبدل
    if(sub && sub.options && sub.options.applicationServerKey){
      const old = new Uint8Array(sub.options.applicationServerKey), cur = b64ToBytes(key);
      if(old.length !== cur.length || old.some((b, i) => b !== cur[i])){ await sub.unsubscribe(); sub = null; }
    }
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    const saved = await apiCall('savePush', Object.assign({ endpoint: sub.endpoint }, id), { silent:true });
    // هوية المستخدم لـ sw.js (ليجلب نصوص الإشعارات من الخادم والتطبيق مغلق). الإدارة: رمز إشعارات فقط (pt) لا رمز
    // الجلسة — sw.js يحفظ الهوية دائمًا على الجهاز، والجلسة مع قفل الهاتف يجب أن تبقى في الذاكرة فقط
    const ident = id.token && saved && saved.pt ? { pt: saved.pt } : id;
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type:'identity', data: Object.assign({ url: WEB_APP_URL, apiKey: SHEET_API_KEY }, ident) });
    _pushActive = true; _pushOwnerDone = owner;
    return true;
  }catch(e){ _pushFailAt = Date.now(); _pushErr = e && e.net ? '' : (e && e.message) || ''; console.warn('تعذر الاشتراك في الإشعارات', e); return false; }
}
async function pushUnsubscribe(){
  _pushActive = false; _pushOwnerDone = '';
  try{
    if(!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type:'identity', data: null });
    const sub = reg.pushManager && await reg.pushManager.getSubscription();
    if(sub){ apiCall('removePush', { endpoint: sub.endpoint }, { silent:true }).catch(()=>{}); await sub.unsubscribe(); }
  }catch(e){}
}
// عند وصول تنبيه والتطبيق مفتوح: sw.js يطلب تحديث الشاشة فورًا بدل انتظار الدورة التالية
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'sync') backgroundSync(true); });
// مؤقت واحد للمهام الدورية الخفيفة (كانت ثلاثة مؤقتات منفصلة): كل مهمة تقرر بنفسها إن حان وقتها —
// التحديث الخلفي (كل 20 ثانية)، شريط «فعّل الإشعارات»، والاشتراك في الإشعارات متى كان الإذن ممنوحًا
setInterval(()=>{
  retryPendingUnlock();
  backgroundSync(false);
  updateNotifBar();
  updateScrollLock();
  checkUpdateQuiet(30 * 60000); // هل نُشر إصدار جديد؟ (كل 30 دقيقة والتطبيق مفتوح)
  if(['screen-admin','screen-worker','screen-pending'].includes(visibleScreen())) pushSubscribe(false);
}, 4000);

/* ---------- البدء: لا خروج تلقائي أبدًا ----------
   إن تعذر الاتصال عند الفتح (بلا إنترنت/بطء Google) نبقى على شاشة المستخدم ونعيد المحاولة،
   بدل إظهار شاشة تسجيل الدخول وكأنه خرج. الخروج يحدث فقط بزر "تسجيل الخروج". */
// رسائل الانتظار عند البدء تظهر على شاشة التحميل نفسها؛ وأي شاشة تُعرض (showScreen) تُخفيها
function bootMessage(text){
  if(!text){ Splash.hide(); return; }
  if(!Splash.isOn()) Splash.show(text);
  Splash.set(55, text);
}

/* ---------- فتح فوري من نسخة محلية ----------
   آخر بيانات وصلت من الخادم تُحفظ على الجهاز، فيفتح التطبيق مباشرة على شاشة المستخدم بدل شاشة الدخول
   (كانت تظهر ثانيتين إلى أربع حتى يرد Google، فيبدو كأنه "خرج ثم دخل"). الخادم يبقى هو المرجع:
   يُتحقق فورًا في الخلفية، وأي عملية (حضور/اعتماد) تمر عليه كما هي. بصمة الوجه لا تُحفظ إطلاقًا. */
const CACHE_W = 'hudurak_cache_worker', CACHE_A = 'hudurak_cache_admin';
/* مكان الحفظ: IndexedDB على الهاتف (مساحتها أكبر بكثير من localStorage — تلك صغيرة ومشتركة بين التطبيقين، وسجل
   الإدارة كان يملؤها فتُحذف النسخة ويفتح التطبيق بلا إنترنت بلا بيانات). نسخة منها في الذاكرة تُحمَّل عند البدء
   (loadLocalCaches) فتبقى القراءة فورية ومتزامنة كما كانت. نفس أسماء المفاتيح؛ النسخة القديمة في localStorage
   تُنقل مرة واحدة. بلا IndexedDB (متصفح قديم): localStorage كما كان */
const LOCAL_DB = 'hudurak-data', LOCAL_STORE = 'kv';
const _local = {}; // المفتاح ← نص JSON (نسخ لا مراجع: تعديل كائن مقروء لا يغيّر المحفوظ، كما في localStorage)
let _localDb = null;
function openLocalDb(){
  return new Promise(resolve => {
    try{
      const rq = indexedDB.open(LOCAL_DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(LOCAL_STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = rq.onblocked = () => resolve(null);
    }catch(e){ resolve(null); }
  });
}
function idbReq(write, fn){
  return new Promise(resolve => {
    try{
      const tx = _localDb.transaction(LOCAL_STORE, write ? 'readwrite' : 'readonly'), rq = fn(tx.objectStore(LOCAL_STORE));
      tx.oncomplete = () => resolve(write ? true : rq.result);
      tx.onerror = tx.onabort = () => resolve(write ? false : undefined);
    }catch(e){ resolve(write ? false : undefined); }
  });
}
async function loadLocalCaches(){
  const opening = 'indexedDB' in window ? openLocalDb() : Promise.resolve(null);
  _localDb = await Promise.race([opening, sleep(3000).then(() => null)]);
  if(!_localDb) opening.then(db => { if(db) _localDb = db; }); // تأخر فتحها: تُستخدم للحفظ حين تجهز
  for(const key of [ADMIN_MODE ? CACHE_A : CACHE_W]){ // كل تطبيق ينقل ويقرأ نسخته فقط
    let v = _localDb ? await idbReq(false, s => s.get(key)) : undefined, old = null;
    try{ old = localStorage.getItem(key); }catch(e){}
    if(v == null && old != null){
      v = old;
      if(_localDb && await idbReq(true, s => s.put(old, key))) try{ localStorage.removeItem(key); }catch(e){} // نُقلت: تتحرر المساحة
    }
    if(typeof v === 'string') _local[key] = v;
  }
}
function saveLocalCache(key, obj){
  let s; try{ s = JSON.stringify(obj); }catch(e){ return; }
  _local[key] = s;
  if(_localDb){ idbReq(true, st => st.put(s, key)); return; }
  // المساحة ممتلئة: تُحذف النسخة القديمة (لا تبقى نسخة لا تطابق ما في الذاكرة)
  try{ localStorage.setItem(key, s); }catch(e){ try{ localStorage.removeItem(key); }catch(e2){} }
}
function readLocalCache(key){ try{ return JSON.parse(_local[key] || 'null'); }catch(e){ return null; } }
function clearLocalCaches(only){
  (only ? [only] : [CACHE_W, CACHE_A]).forEach(k => {
    delete _local[k];
    if(_localDb) idbReq(true, s => s.delete(k));
    try{ localStorage.removeItem(k); }catch(e){}
  });
}

/* ---------- ملفات التطبيق على الجهاز للعمل بلا إنترنت ----------
   في أول فتح تُحمَّل الخطوط (ونماذج الوجه في تطبيق العمال) قبل أن يتحكم ملف الخدمة بالصفحة فلا تُحفظ، فيأتي أول
   فتح بلا إنترنت بخط بديل أو يتعذر الحضور. بعد أن يتحكم: ما ينقص يُجلب عبره فيُحفظ على الجهاز (الموجود لا يُعاد) */
function whenControlled(fn){
  if(!('serviceWorker' in navigator) || !('caches' in window) || !location.protocol.startsWith('http')) return;
  if(navigator.serviceWorker.controller) fn();
  else navigator.serviceWorker.addEventListener('controllerchange', () => fn(), { once: true });
}
async function cacheForOffline(urls){
  for(const u of urls){ try{ if(!await caches.match(u)) await fetch(u); }catch(e){} }
}
async function ensureOfflineFonts(){
  const link = document.querySelector('link[href^="https://fonts.googleapis.com/css2"]');
  if(!link) return;
  try{
    const css = await (await fetch(link.href)).text(), urls = [];
    // الحروف العربية واللاتينية فقط (لا حاجة لباقي اللغات)
    css.replace(/\/\*\s*(?:arabic|latin)\s*\*\/[^}]*?url\((https:[^)]+)\)/g, (m, u) => { urls.push(u); return m; });
    await cacheForOffline(urls);
  }catch(e){}
}

// الخادم مستيقظ؟ (نداء خفيف؛ لا يمنع الفتح إن تأخر Google — مهلة قصيرة)
function pingServer(ms){
  return Promise.race([ fetch(WEB_APP_URL, { mode:'no-cors' }).then(()=>true, ()=>false), sleep(ms).then(()=>false) ]);
}

async function init(){
  $id('spVer').textContent = 'v' + APP_VERSION;
  warmUpServer();
  await loadLocalCaches(); // آخر بيانات محفوظة على الجهاز: قبل تحديد أي شاشة تظهر
  whenControlled(() => setTimeout(ensureOfflineFonts, 10000)); // لا يزاحم تحميل البيانات
  renderNetBar(); // عمليات محفوظة لم تُرسل من فتح سابق
  // تخزين دائم: يطلب من المتصفح ألا يمسح بيانات التطبيق (معرّف الجهاز المربوط، النسخة المحلية، الجلسة)
  // عند امتلاء مساحة الهاتف — وإلا قد «يخرج» المستخدم فجأة ويُطلب اعتماد جهازه من جديد
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(()=>{}); }catch(e){}
  const handoff = takeUpdateHandoff(); // بعد «تحديث» من داخل التطبيق: يبقى داخل حسابه
  const updated = () => { if(handoff && handoff.v !== APP_VERSION) toast('تم التحديث إلى الإصدار ' + APP_VERSION + ' ✓'); };
  await roleInit(handoff, updated);
}
// يبدأ بعد تحميل كل سكربتات الصفحة (بوابة التثبيت معرّفة في السكربت التالي)
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true }); else init();
