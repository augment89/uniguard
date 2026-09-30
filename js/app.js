const $id = id => document.getElementById(id);
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
  let pct = 0, gone = false;
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
    el.classList.remove('sp-hide', 'sp-out');
    $id('spErr').classList.add('hidden');
    set(10, text);
    updateScrollLock();
  }
  function hide(){
    if(gone) return;
    set(100); gone = true;
    const el = $id('splash');
    el.classList.add('sp-out');
    updateScrollLock();
    setTimeout(()=>{ if(gone) el.classList.add('sp-hide'); }, 380);
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

const CHECKIN_INPUT_SIZE = 320;   // دقة التحليل عند الحضور (أسرع على الهاتف)
// دقات كشف الوجه (للتسجيل والحضور): ثقة الكشف تتغير كثيرًا حسب الدقة عندما يملأ الوجه الصورة
// (سيلفي قريب) فنجرب الأصغر والأسرع أولًا. دقة الكشف تحدد إطار الوجه فقط؛ البصمة تُحسب من صورة
// الوجه بدقتها الأصلية، فالترتيب السريع لا يضعفها
const FACE_SIZES = [224, 320, 416];
const AUTO_MIN_SCORE = 0.5;       // ثقة كشف الوجه المطلوبة للالتقاط التلقائي
const AUTO_STABLE_FRAMES = 2;     // الوجه يجب أن يظهر في لقطتين متتاليتين (يتجنب لقطة مهزوزة أثناء الحركة)

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
let _adminFresh = false;     // بيانات الإدارة وصلت مرفقة مع آخر عملية — لا حاجة لجلبها مجددًا
let _workerPrefetch = null;  // بيانات لوحة العامل وصلت مرفقة مع آخر رد

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
      // الخادم لا يعرف هذه العملية = نسخة قديمة منشورة (بطاقة الإدارة تشرح)، ولا تظهر للعامل رسالة تقنية
      throw new Error(/إجراء غير معروف/.test(res.error || '') ? 'هذه الميزة غير متاحة حاليًا' : res.error || 'رفض الخادم العملية');
    }
    // بيانات مرفقة تُغني عن طلب ثانٍ. أثناء عمليات إدارية فورية متداخلة نؤجل تطبيقها
    // (رد عملية سابقة قد يصل بعد التعديل الفوري لعملية لاحقة فيُظهر حالة قديمة لحظيًا)
    if(res.admin){ if(_adminOps){ _lastAdmin = res.admin; } else { _adminFresh = applyAdminData(res.admin); } }
    if(res.session && (action === 'getWorkerData' || action === 'checkin')) setWorkerSession(res.session); // تجديد صامت للجلسة
    if(res.worker && Array.isArray(res.log)) _workerPrefetch = { worker: res.worker, log: res.log, advances: res.advances || [], version: res.version,
      hash: res.hash, wv: res.wv, passkey: res.passkey, settlement: res.settlement || null, at: Date.now() };
    return res;
  } finally {
    if(!silent) setApiBusy(false);
  }
}

/* ---------- إصدار الخادم ----------
   كل رد من الخادم يحمل إصداره (v). إن لم يُنشر Code.gs الجديد (Deploy ← New version) تعرض لوحة الإدارة
   ما يجب فعله بالضبط (الواجهة تفترض الإصدار المطلوب: حمولات النسخ القديمة جدًا أُزيلت). */
const REQUIRED_SERVER = '2.9.4';
let _serverVer = null; // null: لم يُعرف بعد
const verNum = v => String(v || '0').split('.').reduce((n, x) => n * 1000 + (Number(x) || 0), 0);
function serverOutdated(){ return _serverVer !== null && verNum(_serverVer) < verNum(REQUIRED_SERVER); }
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
  box.innerHTML = `<b>⚠ الخادم (Code.gs) يعمل بالإصدار <span dir="ltr">${escapeHtml(_serverVer)}</span>، والتطبيق يحتاج <span dir="ltr">${REQUIRED_SERVER}</span></b>` +
    `<span>انشر آخر تحديث لتعمل كل التحسينات. في Apps Script: <b>Deploy ← Manage deployments ← ✏️ ← Version: New version ← Deploy</b></span>`;
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
  bar.textContent = _offline
    ? '⚠ لا يوجد اتصال بالخادم — تُعرض آخر بيانات محفوظة' + (n ? ` • ${n} بانتظار الإرسال` : '')
    : `⏳ جاري إرسال ${n} عملية...`;
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
let _pendingUnlock = null;
async function retryPendingUnlock(){
  const p = _pendingUnlock;
  if(!p || p.busy || navigator.onLine === false) return;
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
      if(Date.now() - it.at > OUTBOX_MAX_AGE || (it.action === 'checkin' && it.day !== todayStr())){ outboxRemove(it.rid); outboxDone(it, null, 'expired'); continue; }
      const auth = ADMIN_MODE ? { token: getAdminToken(), since: _adminVer, delta: 1 } : currentPhone ? workerAuth() : null;
      if(!auth || (ADMIN_MODE && !auth.token)) break; // بلا جلسة الآن: يُرسل بعد الدخول
      let res;
      try{ res = await apiCall(it.action, Object.assign({}, it.data, auth), { silent: true, requestId: it.rid }); }
      catch(e){
        if(e.net || isLockedError(e) || /غير مصرح|الجلسة/.test(e.message)) break; // لاحقًا (اتصال/قفل/دخول)
        outboxRemove(it.rid); outboxDone(it, null, e.message); continue; // رفض الخادم: لا فائدة من الإعادة
      }
      outboxRemove(it.rid); outboxDone(it, res);
    }
  }finally{ _flushing = false; }
}
// نتيجة عملية وصلت متأخرة: نجاح (res) أو رفض (err)
function outboxDone(it, res, err){
  if(it.action === 'checkin'){
    if(res){
      rememberFace(it.data.descriptors); // أول حضور قبله الخادم: مرجع التحقق المحلي
      if(!it.optimistic) notifyUser('تم تسجيل حضورك ✓', 'وصل حضورك للخادم بعد عودة الاتصال، بانتظار موافقة الإدارة', 'info');
      if(visibleScreen() === 'screen-worker') renderWorkerStats();
    }else{
      notifyUser('لم يُسجَّل حضورك', err === 'expired' ? 'انقطع الاتصال حتى انتهى اليوم فلم يصل الحضور للخادم' : err, 'info');
      _workerPrefetch = null; if(visibleScreen() === 'screen-worker') renderWorkerStats();
    }
    return;
  }
  if(err){ toast(err === 'expired' ? 'لم تصل عملية للخادم لانقطاع الاتصال طويلًا — أعد تنفيذها' : err); _adminVer = ''; }
  if(visibleScreen() === 'screen-admin'){ if(res && res.admin) redrawAdminSafely(); else backgroundSync(true); }
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
// هوية العامل في كل طلب: الرقم + الجهاز المعتمد + جلسة القفل (إن وُجدت)
function workerAuth(extra){ return Object.assign({ phone: currentPhone, deviceId: getDeviceId(), session: getWorkerSession() }, extra || {}); }
const isLockedError = e => /مقفل/.test(e && e.message || '');

/* =========================================================================
   بيانات لوحة الإدارة في الذاكرة (تُملأ من الخادم أو من النسخة المحلية، وتُستخدم للعرض فقط)
   historyFrom: السجلات تصل لنافذة الأشهر الأخيرة (+ كل ما لم يُصفَّ)؛ الأقدم في الأرشيف
   ========================================================================= */
let STATE = { workers:[], log:[], advances:[], archives:[], pendingDevices:[], historyFrom:'' };
function loadWorkers(){ return STATE.workers; }
function loadLog(){ return STATE.log; }
function loadAdvances(){ return STATE.advances; }
function loadArchives(){ return STATE.archives; }
// تاريخ/وقت بتوقيت الرياض: منسّق واحد يُنشأ مرة (إنشاؤه مكلف، وكان يُنشأ في كل نداء)
const RIYADH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Riyadh', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
function riyadhParts(date){
  return Object.fromEntries(RIYADH_FMT.formatToParts(date || new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function todayStr(){
  const p = riyadhParts();
  return `${p.year}-${p.month}-${p.day}`;
}
function monthStr(){ return todayStr().slice(0,7); }
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[char]));
}

/* ---------- دوال مساعدة مشتركة (بدل التكرار) ---------- */
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

function setModal(id, show){ $id(id).classList.toggle('hidden', !show); }

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
  const btn = $id('aboutUpdateBtn'), label = btn.textContent;
  const done = msg => { btn.disabled = false; btn.textContent = label; if(msg) toast(msg); };
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
  bar.innerHTML = `<span>🔄 يوجد تحديث جديد للتطبيق (v${escapeHtml(_latestVer)})</span>
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

// بحث بسيط غير حساس لحالة الأحرف
const norm = v => String(v ?? '').toLowerCase().trim();
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
  ['screen-landing','screen-register','screen-pending','screen-device-pending','screen-lock','screen-worker','screen-admin-login','screen-admin'].forEach(s=>{
    $id(s).classList.toggle('hidden', s!==id);
  });
  if(id !== 'screen-register'){ stopStream(regStream); regStream = null; _regLoopId++; } // لا نترك الكاميرا مفتوحة
  // صفحة دخول العمال في متصفح الهاتف دون تثبيت: تظهر نافذة التثبيت فوقها (مثلًا بعد تسجيل الخروج)
  if(id === 'screen-landing' && window.InstallGate && InstallGate.required()) InstallGate.show();
  if(id === 'screen-admin-login'){ showAdminLoginError(''); renderAdminLoginForm(); prepareAdminLogin(); } // يعرف: إنشاء الحساب أم دخول
  if(id !== 'screen-admin') setModal('securityModal', false);
  updateScrollLock();
}

/* =========================================================================
   تحميل نماذج التعرف على الوجه (face-api.js)
   ========================================================================= */
let modelsReady = false;

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

// يكتمل حين يصبح التعرف على الوجه جاهزًا فعلًا (النماذج + تجهيز المعالج الرسومي)، أو يفشل (false)
let _faceReadyDone;
const faceReady = new Promise(r => { _faceReadyDone = r; });

// مكتبة خارجية تُحمَّل عند الحاجة فقط (مرة واحدة لكل رابط؛ الفشل يسمح بمحاولة لاحقة)
const _scripts = {};
function loadScript(src, ready, id){
  if(ready()) return Promise.resolve();
  return _scripts[src] || (_scripts[src] = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    const fail = () => { sc.remove(); delete _scripts[src]; reject(new Error('تعذر تحميل ' + src)); };
    if(id) sc.id = id;
    sc.src = src; sc.async = true;
    sc.onload = () => ready() ? resolve() : fail();
    sc.onerror = fail;
    document.head.appendChild(sc);
  }));
}
// مكتبة face-api (~650KB) تُحمَّل عند الحاجة فقط، لا مع الصفحة: فتح التطبيق (وخاصة تطبيق الإدارة) لا ينتظرها
const FACE_API_SRC = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
function loadFaceApiScript(){ loadScript(FACE_API_SRC, () => typeof faceapi !== 'undefined', 'faceApiLib').catch(()=>{}); } // loadFaceModels يعيد المحاولة

let faceLoadAttempts = 0;
async function loadFaceModels(){
  const statusEl = $id('modelsStatus');
  loadFaceApiScript();
  if(typeof faceapi === 'undefined'){
    if(++faceLoadAttempts <= 20){ Splash.set(10 + faceLoadAttempts, 'جاري تحميل مكتبة التعرف على الوجه...'); setTimeout(loadFaceModels, 1000); }
    else{
      if(statusEl) statusEl.querySelector('p').textContent = 'تعذر تحميل مكتبة التعرف على الوجه، تحقق من الاتصال وأعد تحميل الصفحة';
      _faceReadyDone(false);
    }
    return;
  }
  await registerModelCacheSW();
  Splash.set(30, 'جاري تحميل نظام التعرف على الوجه...');
  try{
    // الثلاثة بالتوازي بدل واحد تلو الآخر؛ كل نموذج يكتمل يقدّم الشريط خطوة
    let pctLoaded = 30;
    const step = p => p.then(r => { Splash.set(pctLoaded += 15); return r; });
    await Promise.all([
      step(faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL)),
      step(faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL)),
      step(faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL))
    ]);
    modelsReady = true;
    statusEl?.classList.add('done');
    Splash.set(78, 'جاري تجهيز الكاميرا والتحقق من الوجه...');
    await sleep(50); // يسمح برسم الشاشة قبل العمل الثقيل
    await warmUpFaceNets();
    Splash.set(92);
    _faceReadyDone(true);
  }catch(e){
    _modelsRequested = false; // يُسمح بإعادة المحاولة عند فتح الكاميرا لاحقًا
    console.error('فشل تحميل نماذج التعرف على الوجه', e);
    if(statusEl) statusEl.querySelector('p').textContent = 'تعذر تجهيز نظام التعرف على الوجه، تحقق من الاتصال وأعد تحميل الصفحة';
    _faceReadyDone(false);
  }
}
// أول تحليل على الهاتف يستغرق 2–5 ثوانٍ إضافية (تجهيز برامج المعالج الرسومي WebGL لكل شبكة).
// نُجريه مرة في الخلفية على صورة فارغة فور تحميل النماذج، فيكون أول تحقق حقيقي سريعًا.
// (نداءات متعددة تشترك في نفس التجهيز، فينتظر الجميع اكتماله الفعلي)
let _faceNetsWarm = false, _warmPromise = null;
function warmUpFaceNets(){
  if(!modelsReady) return Promise.resolve();
  if(_warmPromise) return _warmPromise;
  _faceNetsWarm = true;
  return _warmPromise = (async()=>{
    try{
      const c = document.createElement('canvas'); c.width = c.height = 160;
      const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 160, 160);
      let p = 78; // شاشة التحميل تتقدم مع كل مرحلة (لا تبدو متوقفة على هاتف بطيء)
      for(const inputSize of FACE_SIZES){ await faceapi.detectSingleFace(c, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.4 })); Splash.set(p += 3); }
      await faceapi.detectFaceLandmarks(c); Splash.set(p += 3);
      await faceapi.computeFaceDescriptor(c);
    }catch(e){ console.warn('تعذر تجهيز شبكات الوجه مسبقًا', e); }
  })();
}

// نماذج الوجه (~6.5MB) لا تلزم لوحة الإدارة: تُحمَّل للعمال فقط، أو عند فتح الكاميرا
let _modelsRequested = false;
function ensureFaceModels(){
  if(_modelsRequested || modelsReady) return;
  _modelsRequested = true;
  loadFaceModels();
}
// تسجيل الـ Service Worker مبكرًا (شرط لظهور زر التثبيت في بعض المتصفحات) دون انتظار نماذج الوجه
registerModelCacheSW();
window.addEventListener('load', ()=>{ if(!ADMIN_MODE) ensureFaceModels(); }, { once:true });

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// inputSize: 512 للتسجيل (بصمة مرجعية أدق)، 320 للحضور (أسرع بنحو الضعف على الهاتف ويكفي لوجه قريب)
async function detectFaceDescriptor(videoEl, statusEl, inputSize = 512){
  if(typeof faceapi === 'undefined'){
    statusEl.textContent = 'جاري تجهيز نظام التعرف على الوجه، انتظر لحظة...';
    return null;
  }
  if(!modelsReady){
    statusEl.textContent = 'نظام التعرف على الوجه لا يزال يتم تحميله، انتظر لحظة...';
    return null;
  }
  if(!videoEl.videoWidth || videoEl.readyState < 2){
    statusEl.textContent = 'الكاميرا لم تجهز بعد، انتظر لحظة ثم حاول مجددًا';
    return null;
  }
  let result;
  try{
    result = await faceapi
      .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.4 }))
      .withFaceLandmarks().withFaceDescriptor();
  }catch(error){
    console.error('تعذر تحليل صورة الوجه', error);
    statusEl.textContent = 'تعذر تحليل الصورة، تحقق من الإضاءة وحاول مجددًا';
    return null;
  }
  if(!result){
    statusEl.textContent = 'لم يتم العثور على وجه، اقترب من الكاميرا وتأكد من الإضاءة';
    return null;
  }
  return Array.from(result.descriptor);
}

/* =========================================================================
   تسجيل الدخول — رقم الهاتف + بصمة الجهاز
   ========================================================================= */
let pendingProfile = null; // {phone, name}

function workerPhone(w){ return String((w && w.phone) || ''); }

// يوحّد شكل الرقم: أرقام لاتينية، بدون مسافات أو رموز، و 00 تتحول إلى +
function normalizePhone(raw){
  let v = String(raw || '')
    .replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[\u06F0-\u06F9]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/[\s\-().]/g, '');
  if(v.startsWith('00')) v = '+' + v.slice(2);
  return /^\+?\d{8,15}$/.test(v) ? v : '';
}

let currentPhone = null; // الرقم المسجَّل به الدخول في هذه الجلسة

// الاسم: مسافات موحدة، واسم ثنائي على الأقل بحروف فقط (نفس تحقق الخادم)
const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim();
const validFullName = n => /^[ء-يٮ-ۓً-ٰٟa-zA-Z ]{5,60}$/.test(n) && n.split(' ').filter(p => p.length >= 2).length >= 2;
const PROFESSIONS = ['مليس', 'دهان', 'عامل'];

let _loggingIn = false;
async function continueWithPhone(){
  if(_loggingIn) return;
  const phone = normalizePhone($id('loginPhone').value);
  const name = cleanName($id('loginName').value);
  if(!phone){ toast('أدخل رقم هاتف صحيحًا'); return; }
  if(name && !validFullName(name)){ toast('اكتب اسمك الثنائي على الأقل بالحروف فقط'); return; }
  _loggingIn = true;
  try{ await routeAfterLogin(phone, name); } finally { _loggingIn = false; }
}

async function routeAfterLogin(phone, name){
  const deviceId = getDeviceId();
  let res;
  try{
    res = await apiCall('checkPhone', { phone, deviceId, name, userAgent: navigator.userAgent, device: await deviceInfo(), session: getWorkerSession() });
  }catch(error){ toast(error.message); return; }

  if(!res.exists){
    if(!validFullName(name)){ toast('رقم جديد: اكتب اسمك الكامل (الثنائي على الأقل) ثم اضغط المتابعة'); $id('loginName').focus(); return; }
    // جهاز مرتبط بعامل آخر: الحساب الجديد طلب للإدارة، وقبوله ينقل الجهاز إليه
    if(res.deviceBound && !confirm(`هذا الجهاز مرتبط بحساب «${res.boundName}».\n\nإنشاء حساب جديد عليه يحتاج موافقة الإدارة، وعند الموافقة يُنقل الجهاز إلى الحساب الجديد ولن يعمل عليه حساب «${res.boundName}».\n\nهل تريد المتابعة؟`)) return;
    pendingProfile = { phone, name };
    capturedDescriptors = null;
    $id('regStep1').classList.remove('hidden');
    $id('regStep2').classList.add('hidden');
    $id('stepDot2').classList.remove('active');
    $id('regName').value = name;
    $id('regProfession').value = '';
    showScreen('screen-register');
    startRegisterCamera();
    return;
  }
  currentPhone = phone;
  setRememberedPhone(phone);
  if(!res.deviceOk){
    _lastDeviceStatus = res.deviceStatus;
    setDevicePendingText(res.deviceStatus, res.switchFrom);
    showScreen('screen-device-pending');
    return;
  }
  handleWorkerResponse(res);
}

// رد يحمل بيانات العامل: إما مقفل (شاشة القفل) أو مفتوح (لوحته)
function handleWorkerResponse(res){
  _hasPasskey = !!res.passkey;
  if(res.locked){ showLockScreen(res.worker); return; }
  enterWorkerArea(res.worker); // سجلاته وصلت مع الرد نفسه (_workerPrefetch في apiCall)
}

// switchFrom: الجهاز مرتبط الآن بحساب عامل آخر (طلب فتح حساب آخر عليه) — يبقى محفوظًا لتحديثات الحالة التالية
let _switchFrom = '';
function setDevicePendingText(status, switchFrom){
  if(switchFrom !== undefined) _switchFrom = switchFrom || '';
  if(status === 'pending' && _switchFrom){
    $id('devicePendingTitle').textContent = 'طلب فتح حساب آخر بانتظار الموافقة';
    $id('devicePendingText').textContent = `هذا الجهاز مرتبط بحساب «${_switchFrom}». أُرسل طلب للإدارة لفتح هذا الحساب عليه؛ عند الموافقة يُنقل الجهاز إلى هذا الحساب وتدخل تلقائيًا.`;
    return;
  }
  const t = { rejected:['رُفض الدخول من هذا الجهاز', 'رفضت الإدارة الدخول لحسابك من هذا الجهاز. تواصل مع الإدارة إن كان هذا خطأ.'],
    replaced:['اعتُمد جهاز آخر لحسابك', 'اعتمدت الإدارة جهازًا آخر لهذا الحساب. لإرسال طلب جديد لهذا الجهاز اضغط "تحديث الحالة".'] }[status]
    || ['جهاز جديد بانتظار الموافقة', 'دخلت من جهاز مختلف عن جهازك المعتاد. تم إرسال طلب إلى الإدارة للموافقة على هذا الجهاز، وستدخل تلقائيًا فور الموافقة.'];
  $id('devicePendingTitle').textContent = t[0];
  $id('devicePendingText').textContent = t[1];
}

let _lastDeviceStatus = '';
// silent: يستدعيها التحديث الخلفي كل 20 ثانية (بلا رسائل إلا عند تغيّر الحالة)
async function refreshDeviceStatus(silent){
  if(!currentPhone){ showScreen('screen-landing'); return; }
  // جهاز استُبدل: الضغط اليدوي يعيد إرسال الطلب للإدارة (نفس مسار الدخول)
  if(!silent && _lastDeviceStatus === 'replaced'){ await routeAfterLogin(currentPhone, ''); return; }
  let res;
  try{ res = await apiCall('refreshDeviceStatus', workerAuth(), { silent: !!silent }); }
  catch(error){ if(!silent) toast(error.message); return; }
  const changed = res.deviceStatus !== _lastDeviceStatus;
  _lastDeviceStatus = res.deviceStatus;
  if(res.deviceStatus === 'approved' && res.worker){
    if(changed && !res.locked) notifyUser('تم اعتماد جهازك ✓', 'وافقت الإدارة على هذا الجهاز، يمكنك الآن استخدام حسابك', 'device');
    handleWorkerResponse(res);
  }else if(res.deviceStatus === 'deleted'){
    // الحساب لم يعد موجودًا فعلًا: لا معنى للبقاء على هذه الشاشة
    toast('لم يعد هذا الحساب موجودًا'); logout();
  }else{
    setDevicePendingText(res.deviceStatus);
    if(changed && res.deviceStatus === 'rejected') notifyUser('رُفض طلب الجهاز', 'رفضت الإدارة الدخول لحسابك من هذا الجهاز', 'device');
    else if(!silent) toast(res.deviceStatus === 'replaced' ? 'اعتُمد جهاز آخر لحسابك' : 'لا يزال الطلب بانتظار موافقة الإدارة');
  }
}

// يوجّه العامل إلى شاشة الانتظار إذا كان حسابه لم يُعتمد بعد، أو إلى لوحته إن كان نشطًا
function enterWorkerArea(worker){
  const status = worker.status || 'active';
  if(status === 'pending'){
    currentWorker = worker;
    workerNews(worker, [], []); // يُسجَّل أنه "بانتظار الموافقة" ليصله إشعار القبول لاحقًا ولو كان التطبيق مغلقًا
    saveLocalCache(CACHE_W, { phone: currentPhone, worker, log: [], advances: [], passkey: _hasPasskey });
    $id('pendingWorkerName').textContent = worker.name + ' — ' + worker.profession;
    showScreen('screen-pending');
  }else{
    openWorkerDashboard(worker);
  }
  offerPasskey();
}

let _pendingVer = '';
async function refreshPendingStatus(silent){
  if(!currentPhone) return;
  let res;
  try{ res = await apiCall('getWorkerData', workerAuth({ since: silent ? _pendingVer : '' }), { silent: !!silent }); }
  catch(error){
    if(isLockedError(error)){ lockApp(); return; }
    if(/الجلسة غير صالحة/.test(error.message)){ refreshDeviceStatus(silent); return; } // حُذف الحساب أو تغيّر الجهاز
    if(!silent) toast(error.message); return;
  }
  if(res.unchanged) return;
  _pendingVer = res.version || '';
  if(res.worker.status === 'pending'){ if(!silent) toast('لا يزال حسابك بانتظار الموافقة'); return; }
  enterWorkerArea(res.worker); // إشعار "تم قبول حسابك" يصدر من workerNews عند فتح اللوحة
}

/* =========================================================================
   التسجيل لأول مرة — بصمة الوجه + البيانات
   ========================================================================= */
let regStream = null;
let capturedDescriptors = null; // لقطات الوجه عند التسجيل (تُحفظ كلها كبصمات مرجعية في الخادم)

// تشغيل الكاميرا — مشترك بين التسجيل وتسجيل الحضور
async function startCamera(videoEl, statusEl, readyMsg){
  ensureFaceModels();
  stopStream(videoEl.srcObject); // يمنع تسريب بث سابق
  try{
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
      statusEl.textContent = 'الكاميرا لا تعمل عند فتح الملف مباشرة من الجهاز. ارفع الصفحة على رابط HTTPS (مثل GitHub Pages أو Netlify) وافتحها منه';
      return null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user' } });
    videoEl.srcObject = stream;
    statusEl.textContent = readyMsg;
    return stream;
  }catch(e){
    console.warn('camera error', e);
    statusEl.textContent = e.name === 'NotAllowedError'
      ? 'تم رفض إذن الكاميرا، فعّله من إعدادات الموقع في المتصفح ثم أعد المحاولة'
      : e.name === 'NotFoundError' ? 'لم يتم العثور على كاميرا في هذا الجهاز'
      : 'تعذر تشغيل الكاميرا، أغلق أي تطبيق آخر يستخدمها وحاول مجددًا';
    return null;
  }
}

// كشف وجه واحد بتجربة عدة دقات (ثقة الكشف تتغير كثيرًا بالدقة حين يملأ الوجه الصورة)
async function detectAtSizes(video, sizes, minScore){
  for(const inputSize of sizes){
    const r = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minScore }))
      .withFaceLandmarks().withFaceDescriptor();
    if(r){ r.inputSize = inputSize; return r; }
  }
  return null;
}
// الدقة التي نجحت أولًا تُجرَّب أولًا في اللقطات التالية: نفس الدقة = نفس إطار الوجه = بصمات متقاربة
// (دقتان مختلفتان لنفس الصورة تعطيان بصمتين بينهما ~0.45، فتبدو اللقطات غير متسقة ويُعاد الالتقاط)
const sizesFrom = (first, sizes) => first ? [first].concat(sizes.filter(s => s !== first)) : sizes;
// جودة اللقطة قبل الاعتماد عليها: وجه صغير (بعيد) أو على طرف الصورة يعطي بصمة أضعف
// (حدود مرنة: كانت أشد فيصعب التسجيل بهواتف كاميرتها واسعة أو في إضاءة متوسطة)
const FACE_MIN_WIDTH = 0.15; // عرض الوجه من عرض الصورة
function faceQuality(r, video){
  const b = r.detection.box, W = video.videoWidth || 1, H = video.videoHeight || 1;
  if(b.width / W < FACE_MIN_WIDTH) return 'قرّب وجهك من الكاميرا';
  const cx = (b.x + b.width / 2) / W, cy = (b.y + b.height / 2) / H;
  if(cx < 0.15 || cx > 0.85 || cy < 0.1 || cy > 0.9) return 'ضع وجهك في منتصف الدائرة';
  return '';
}
const faceDist = (a, b) => { let s = 0; for(let i = 0; i < a.length; i++){ const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
const REG_SAMPLES = 3, REG_MIN_SCORE = 0.4;

/* ---------- التحقق المحلي من الوجه عند الحضور ----------
   هاتف العامل يحفظ لقطات وجهه هو فقط (من تسجيله، أو من أول حضور قبله الخادم) — لا تصل من الخادم أبدًا.
   عند الحضور تُقارن اللقطة بها على الهاتف فورًا: غير مطابق = رد فوري بلا انتظار الخادم، ومطابق = قبول فوري
   على الشاشة والخادم يتحقق من جديد (هو الحكم النهائي) في الخلفية. بنفس حدود الخادم تمامًا. */
const FACE_MATCH_AVG = 0.55, FACE_MATCH_MAX = 0.6, LOCAL_FACE_TRIES = 3;
const faceKey = () => currentPhone ? 'hudurak_face_' + phoneKeyOf(currentPhone) : '';
function localFaceRefs(){
  try{ const k = faceKey(), v = k && JSON.parse(localStorage.getItem(k) || 'null'); return Array.isArray(v) && v.length ? v : null; }
  catch(e){ return null; }
}
// replace: تحديث المرجع (الخادم قبل وجهًا رفضه المرجع المحلي — تغيّر المظهر أو الإضاءة)
function rememberFace(descs, replace){
  const k = faceKey();
  if(!k || !Array.isArray(descs) || !descs.length || (!replace && localFaceRefs())) return;
  try{ localStorage.setItem(k, JSON.stringify(descs.slice(0, 5).map(d => d.map(x => Math.round(x * 1e4) / 1e4)))); }catch(e){}
}
const forgetFace = () => { try{ const k = faceKey(); if(k) localStorage.removeItem(k); }catch(e){} };
// true مطابق، false غير مطابق، null لا توجد نسخة محلية
function localFaceCheck(descs){
  const refs = localFaceRefs();
  if(!refs) return null;
  const d = descs.map(p => Math.min.apply(null, refs.map(r => faceDist(p, r))));
  return d.reduce((s, x) => s + x, 0) / d.length <= FACE_MATCH_AVG && Math.max.apply(null, d) <= FACE_MATCH_MAX;
}
let _regLoopId = 0;

async function startRegisterCamera(){
  regStream = await startCamera(
    $id('regVideo'),
    $id('regCamStatus'),
    'ضع وجهك داخل الدائرة — سيتم الالتقاط تلقائيًا');
  if(regStream) autoRegisterLoop();
}

// التقاط تلقائي للبصمة المرجعية: فور ظهور الوجه بوضوح تُجمع 3 عينات وتُحسب البصمة، دون ضغط أي زر
async function autoRegisterLoop(){
  const my = ++_regLoopId;
  const video = $id('regVideo');
  const status = $id('regCamStatus');
  while(my === _regLoopId && regStream && !capturedDescriptors){
    if(typeof faceapi === 'undefined' || !modelsReady){
      status.textContent = 'جاري تجهيز نظام التعرف على الوجه، انتظر لحظة...';
    }else if(video.readyState >= 2 && video.videoWidth){
      let r = null;
      try{ r = await detectAtSizes(video, FACE_SIZES, REG_MIN_SCORE); }catch(e){}
      if(my !== _regLoopId || !regStream) return;
      const bad = r && faceQuality(r, video);
      if(r && !bad){ await collectRegistrationSamples(r, my); return; }
      status.textContent = bad || 'ضع وجهك داخل الدائرة — سيتم الالتقاط تلقائيًا';
    }
    await sleep(250);
  }
}

async function collectRegistrationSamples(first, loopId){
  const status = $id('regCamStatus');
  const video = $id('regVideo');
  const btn = $id('regCaptureBtn');
  btn.disabled = true;
  let samples = first ? [Array.from(first.descriptor)] : [];
  let size = first && first.inputSize, misses = 0, odd = 0, tries = 0;
  const restart = msg => { btn.disabled = false; status.textContent = msg; if(loopId !== undefined) setTimeout(autoRegisterLoop, 800); };
  /* أسهل من السابق: لقطة ضائعة (تحرّك الوجه لحظة) أو لا تشبه ما قبلها (اهتزاز) لا تُعيد الالتقاط من الصفر —
     تُتجاهل ويكمل؛ لقطتان متتاليتان لا تشبهان الأولى = الأولى هي السيئة فتُستبدل. اللقطات المقبولة كلها
     لنفس الوجه (حد الخادم نفسه 0.6)، فلا يُرفض التسجيل لاحقًا في الخادم */
  while(samples.length < REG_SAMPLES){
    if(loopId !== undefined && loopId !== _regLoopId) { btn.disabled = false; return; }
    if(++tries > 40){ restart('تعذر الالتقاط — ثبّت الهاتف ووجهك في إضاءة جيدة، سيُعاد تلقائيًا'); return; }
    if(misses < 4) status.textContent = `جاري الالتقاط (${samples.length+1}/${REG_SAMPLES})... ثبّت وجهك`; // وإلا يبقى الإرشاد ظاهرًا
    await sleep(250);
    let r = null;
    try{ r = await detectAtSizes(video, sizesFrom(size, FACE_SIZES), REG_MIN_SCORE); }catch(e){}
    const bad = !r ? 'ضع وجهك داخل الدائرة' : faceQuality(r, video);
    if(bad){ if(++misses >= 4) status.textContent = bad; continue; }
    misses = 0;
    const d = Array.from(r.descriptor);
    if(samples.some(s => faceDist(s, d) > FACE_MATCH_MAX)){
      if(++odd >= 2){ samples = [d]; odd = 0; } // الأولى كانت المهزوزة
      continue;
    }
    odd = 0; samples.push(d); size = size || r.inputSize;
  }

  capturedDescriptors = samples; // الخادم يحفظها كلها + متوسطها كبصمات مرجعية
  _regLoopId++;
  status.textContent = 'تم بنجاح ✓';
  btn.disabled = false;
  stopStream(regStream);
  $id('regStep1').classList.add('hidden');
  $id('regStep2').classList.remove('hidden');
  $id('stepDot2').classList.add('active');
}

// الزر يبقى بديلًا يدويًا
async function captureRegistrationFace(){
  if(!regStream){ await startRegisterCamera(); return; }
  if(!modelsReady){ $id('regCamStatus').textContent = 'نظام التعرف على الوجه لا يزال يتم تحميله، انتظر لحظة...'; return; }
  _regLoopId++; // يوقف الحلقة التلقائية
  await collectRegistrationSamples(null);
}

function stopStream(stream){
  if(stream){ stream.getTracks().forEach(t=>t.stop()); }
}

let _registering = false;
async function finishRegistration(){
  const name = cleanName($id('regName').value);
  const profession = $id('regProfession').value;
  if(!validFullName(name)){ toast('اكتب اسمك الثنائي على الأقل بالحروف فقط'); return; }
  if(!PROFESSIONS.includes(profession)){ toast('اختر المهنة من القائمة'); return; }
  if(!capturedDescriptors){ toast('يرجى تسجيل بصمة الوجه أولاً'); return; }
  if(!pendingProfile?.phone){ toast('انتهت جلسة التسجيل، ابدأ تسجيل الدخول من جديد'); showScreen('screen-landing'); return; }

  if(_registering) return; // منع الإرسال المزدوج
  _registering = true;
  const submitBtn = $id('regSubmitBtn');
  if(submitBtn) submitBtn.disabled = true;
  let res;
  try{
    res = await apiCall('register', {
      phone: pendingProfile.phone, name, profession,
      descriptors: capturedDescriptors, // كل اللقطات: الخادم يحفظها ومتوسطها كبصمات مرجعية
      deviceId: getDeviceId(), userAgent: navigator.userAgent, device: await deviceInfo()
    });
  }catch(error){
    toast(error.message);
    // وجه مسجل/جهاز مسجل: لا فائدة من إعادة المحاولة بنفس البيانات — عودة لشاشة الدخول
    if(/مسجل/.test(error.message)){ capturedDescriptors = null; pendingProfile = null; showScreen('screen-landing'); }
    return;
  }
  finally{ _registering = false; if(submitBtn) submitBtn.disabled = false; }

  currentPhone = pendingProfile.phone;
  setRememberedPhone(currentPhone);
  rememberFace(capturedDescriptors, true); // لقطات التسجيل = مرجع التحقق المحلي السريع عند الحضور
  toast('تم إرسال طلب التسجيل، بانتظار موافقة الإدارة');
  capturedDescriptors = null; pendingProfile = null;
  _hasPasskey = false;
  enterWorkerArea(res.worker);
}

/* =========================================================================
   لوحة العامل
   ========================================================================= */
let currentWorker = null;

function openWorkerDashboard(worker){
  currentWorker = worker;
  showScreen('screen-worker');
  ensureFaceModels(); if(modelsReady) warmUpFaceNets(); // جاهزية التحقق قبل أن يضغط العامل زر الحضور
  $id('workerNameChip').textContent = worker.name; // الاسم فقط (المهنة في «إدارة الحساب»)
  $id('pfProfession').textContent = worker.profession;
  $id('pfWage').textContent = worker.wage;
  $id('pfPhone').textContent = workerPhone(worker);
  updateExitButton();
  updateInboxBadge();
  renderWorkerStats();
}

async function renderWorkerStats(){
  let data;
  if(_workerPrefetch && Date.now() - _workerPrefetch.at < 15000){ data = _workerPrefetch; }
  else{
    try{ data = await apiCall('getWorkerData', workerAuth()); }
    catch(error){
      if(isLockedError(error)){ lockApp(); return; }
      // بلا اتصال: آخر نسخة محفوظة على الهاتف (الشريط السفلي يبيّن الحالة) بدل رسالة خطأ
      const c = error.net && readLocalCache(CACHE_W);
      if(!c || c.phone !== currentPhone || !c.worker){ if(!error.net) toast(error.message); return; }
      data = { worker: c.worker, log: c.log || [], advances: c.advances || [], at: Date.now() };
    }
  }
  _workerPrefetch = null;
  if(data.passkey !== undefined){ _hasPasskey = !!data.passkey; updateExitButton(); }
  currentWorker = data.worker;
  // الفترة الحالية فقط (منذ آخر تصفية): بعد التصفية تبدأ الصفحة من جديد بلا بيانات سابقة
  const since = Number(data.worker.lastSettledAt) || 0;
  const allLog = data.log || [];
  const log = allLog.filter(r => r.timestamp > since);
  const advances = (data.advances || []).filter(a => a.timestamp > since);
  if(data.version){ _workerVer = data.version; _workerFullAt = Date.now(); }
  _workerHash = data.hash || ''; _workerWv = data.wv || '';
  workerNews(data.worker, allLog, advances);
  saveLocalCache(CACHE_W, { phone: currentPhone, worker: data.worker, log: allLog, advances, passkey: _hasPasskey });

  const month = monthStr();
  const approvedThisMonth = log.filter(r=>r.status==='approved' && r.date.startsWith(month));
  $id('stApprovedDays').textContent = approvedThisMonth.length;
  $id('stMonthEarn').textContent = fmt(approvedThisMonth.reduce((sum,r)=> sum + recordWage(r, currentWorker), 0));
  $id('pfWage').textContent = fmt(currentWorker.wage);
  renderWorkerMoney(currentWorker, log, advances);

  const todays = allLog.find(r=>r.date===todayStr()); // حضور اليوم ولو سبق تصفيةً تمت اليوم (لا يُسجَّل مرتين)
  const statusMap = {pending:'بانتظار الموافقة', approved:'تم اعتماد الحضور', rejected:'تم رفض الحضور', queued:'يُرسل تلقائيًا عند عودة الاتصال'};
  $id('stTodayStatus').textContent = todays ? statusMap[todays.status] : 'لم يسجل بعد';

  const checkinBtn = $id('checkinBtn');
  const title = $id('checkinTitle');
  const sub = $id('checkinSub');
  if(todays){
    checkinBtn.style.opacity = .5;
    checkinBtn.onclick = ()=>toast('تم تسجيل حضورك اليوم بالفعل');
    title.textContent = 'تم تسجيل الحضور اليوم';
    sub.textContent = statusMap[todays.status];
  }else{
    checkinBtn.style.opacity = 1;
    checkinBtn.onclick = openFaceModal;
    title.textContent = 'تسجيل الحضور اليوم';
    sub.textContent = 'اضغط الزر وسيتم التحقق من وجهك تلقائيًا';
  }

  const sorted = [...log].sort((a,b)=> b.timestamp - a.timestamp);
  renderRows('workerLogBody','workerLogEmpty', sorted, r=>
    `<tr><td data-label="التاريخ">${escapeHtml(r.date)}</td><td data-label="الوقت">${escapeHtml(r.time)}</td><td data-label="الحالة"><span class="pill pill-${escapeHtml(r.status)}">${statusMap[r.status]}</span></td></tr>`);
  // (النسخة المحلية عند الفتح لا تحمل التصفية: لا نُخفي نافذة ظاهرة بسببها — الرد الحقيقي من الخادم هو الحكم)
  if(data.settlement !== undefined) showSettlement(data.settlement);
}

/* ---------- تصفية الحساب: نافذة بالتفاصيل تبقى حتى يضغط العامل "تم" ----------
   حالتها في الخادم (لا في الهاتف)، فتظهر في كل فتح وعلى أي جهاز معتمد حتى يؤكد اطّلاعه.
   بعد "تم" يبدأ التطبيق فترة جديدة: شاشة تحميل قصيرة ثم لوحة بأرقام الفترة الجديدة. */
let _settleShown = '';
function showSettlement(s){
  const modal = $id('settleModal');
  if(!s){ if(_settleShown){ setModal('settleModal', false); _settleShown = ''; } return; }
  if(_settleShown === s.id && !modal.classList.contains('hidden')) return;
  _settleShown = s.id;
  // تُحفظ في مركز الإشعارات مرة واحدة (تبقى مرجعًا بعد "تم")
  inboxAdd('settle', s.monthLabel ? 'تمت تصفية حسابك — ' + s.monthLabel : 'تمت تصفية حسابك',
    `المدفوع لك ${fmt(s.paid)} — أيام العمل ${s.days}، المستحق ${fmt(s.earned)}، السلف ${fmt(s.advances)}` + (s.carried ? `، رصيد مرحّل ${fmt(s.carried)}` : ''),
    'settle:' + s.id);
  $id('settleTitle').textContent = s.monthLabel ? 'تمت تصفية حسابك — ' + s.monthLabel : 'تمت تصفية حسابك';
  $id('settlePeriod').textContent = (s.monthLabel ? 'تصفية شهر ' + s.monthLabel : 'تصفية حساب') + ' — بتاريخ ' + s.date;
  const paid = document.querySelector('#settleModal .settle-paid');
  paid.classList.toggle('zero', !s.paid);
  $id('settlePaid').textContent = fmt(s.paid);
  const rows = [['أيام العمل المعتمدة', s.days], ['اليومية', fmt(s.wage)], ['إجمالي المستحق', fmt(s.earned)],
    ['السلف المخصومة', s.advances ? '− ' + fmt(s.advances) : '0', 'minus']];
  if(s.carried) rows.push(['رصيد مرحّل على الفترة القادمة', '− ' + fmt(s.carried), 'minus']);
  $id('settleRows').innerHTML = rows.map(([k, v, cls]) =>
    `<tr class="${cls || ''}"><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  $id('settleNote').textContent = s.carried
    ? `السلف أكبر من المستحق، لذلك لم يُدفع مبلغ، ورُحّل ${fmt(s.carried)} كسلفة تُخصم من مستحقك القادم.`
    : 'بالضغط على «تم» تبدأ فترة عمل جديدة ويبدأ حسابك من الصفر.';
  const btn = $id('settleOk');
  btn.disabled = false; btn.textContent = 'تم ✓';
  setModal('passkeyModal', false);
  if(!$id('faceModal').classList.contains('hidden')) closeFaceModal();
  setModal('settleModal', true);
}
async function ackSettlement(){
  const btn = $id('settleOk');
  if(btn.disabled) return;
  btn.disabled = true; btn.textContent = 'جارٍ التأكيد...';
  try{ await apiCall('ackSettlement', workerAuth()); }
  catch(error){
    btn.disabled = false; btn.textContent = 'تم ✓';
    if(isLockedError(error)){ setModal('settleModal', false); _settleShown = ''; lockApp(); return; }
    toast(error.message); return;
  }
  setModal('settleModal', false); _settleShown = '';
  // بداية جديدة: البيانات الجديدة وصلت مع الرد نفسه (_workerPrefetch)، فالتحميل قصير
  Splash.show('جاري بدء فترة جديدة...');
  window.scrollTo(0, 0);
  pageReset('workerLogBody'); pageReset('workerAdvBody');
  await renderWorkerStats();
  Splash.set(100, 'فترة جديدة ✓');
  await sleep(600);
  Splash.hide();
  toast('بدأت فترة عمل جديدة — بالتوفيق');
}

// بطاقة إجمالي السلف + الرصيد الصافي + جدول السلف (نفس معادلة الخادم في التصفية)
function renderWorkerMoney(worker, log, advances){
  const since = Number(worker.lastSettledAt) || 0;
  const open = advances.filter(a => a.timestamp > since);
  const advTotal = money(open.reduce((s,a)=> s + a.amount, 0));
  const earned = money(log.filter(r => r.status==='approved' && r.timestamp > since).reduce((s,r)=> s + recordWage(r, worker), 0));
  const net = money(earned - advTotal);
  $id('stAdvancesTotal').textContent = fmt(advTotal);
  const last = [...open].sort((a,b)=> b.timestamp - a.timestamp)[0];
  $id('stAdvancesSub').textContent = open.length
    ? `${open.length} سلفة — آخرها ${last.date}` : 'لا توجد سلف غير مصفّاة';
  const netEl = $id('stNetBalance');
  netEl.textContent = fmt(net);
  netEl.style.color = net < 0 ? 'var(--red)' : 'var(--green)';
  $id('stNetSub').textContent = `المستحق ${fmt(earned)} − السلف ${fmt(advTotal)}` + (net < 0 ? ' (يُخصم من المستحق القادم)' : '');
  const sorted = [...advances].sort((a,b)=> b.timestamp - a.timestamp);
  renderRows('workerAdvBody','workerAdvEmpty', sorted, a=>
    `<tr><td data-label="التاريخ">${escapeHtml(a.date)}</td><td data-label="المبلغ" style="font-weight:800;">${fmt(a.amount)}</td><td data-label="ملاحظة">${escapeHtml(a.note||'-')}</td><td data-label="الحالة"><span class="pill ${a.timestamp > since ? 'pill-pending' : 'pill-approved'}">${a.timestamp > since ? 'غير مصفّاة' : 'مصفّاة'}</span></td></tr>`);
}

// إلغاء حساب العامل لنفسه: حذف ناعم (soft delete) كي لا تضيع سجلات السلف والتصفيات المالية
async function workerDeleteOwnAccount(){
  if(!confirm('هل أنت متأكد من إلغاء حسابك؟ لن تتمكن من تسجيل الحضور بعد ذلك، وتبقى سجلات الحضور والسلف والتصفيات لدى الإدارة.')) return;
  try{ await apiCall('workerDeleteOwnAccount', workerAuth()); }
  catch(error){ toast(error.message); return; }
  try{ localStorage.removeItem(inboxKey()); }catch(e){} // إشعاراته المحفوظة تُحذف مع الحساب
  forgetFace(); outboxSave([]);
  currentWorker = null;
  currentPhone = null;
  setWorkerSession(''); _hasPasskey = false;
  clearRememberedPhone();
  clearLocalCaches(CACHE_W); clearNext(PK_NEXT);
  pushUnsubscribe();
  toast('تم إلغاء الحساب');
  showScreen('screen-landing');
}

/* =========================================================================
   نافذة تسجيل الحضور بالوجه (Check-in)
   ========================================================================= */
let checkStream = null;
let _autoLoopId = 0;       // يتغير عند إغلاق النافذة أو بدء محاولة يدوية فيوقف حلقة الالتقاط السابقة
let _checkinBusy = false;  // طلب حضور قيد الإرسال: لا التقاط آخر حتى يعود الرد

async function openFaceModal(){
  setModal('faceModal', true);
  const status = $id('checkCamStatus');
  if(!currentWorker?.hasFace){
    status.textContent = 'لا توجد بصمة وجه محفوظة لهذا الحساب';
    return;
  }
  // (لا طلب «تدفئة» للخادم هنا: الحضور يُقبل على الهاتف بالتحقق المحلي، وكل طلب إضافي حمل على خادم Google)
  _localFaceFails = 0;
  status.textContent = 'جاري تشغيل الكاميرا...';
  checkStream = await startCamera(
    $id('checkVideo'), status,
    'ضع وجهك داخل الدائرة — سيتم التحقق تلقائيًا');
  if(checkStream) autoCheckinLoop();
}

function closeFaceModal(){
  _autoLoopId++;
  stopStream(checkStream);
  checkStream = null;
  $id('checkVideo').srcObject = null;
  setModal('faceModal', false);
}

// التقاط تلقائي: يحلل الكاميرا باستمرار ويرسل البصمة بمجرد ظهور وجه واضح، دون انتظار الضغط على زر
async function autoCheckinLoop(){
  const my = ++_autoLoopId;
  const video = $id('checkVideo');
  const status = $id('checkCamStatus');
  let size = 0;
  const detect = ()=> detectAtSizes(video, sizesFrom(size, FACE_SIZES), AUTO_MIN_SCORE);
  let frames = []; // لقطات متتالية واضحة لنفس الوجه — تُرسل كلها ويتحقق الخادم من كل واحدة
  while(my === _autoLoopId && checkStream){
    if(typeof faceapi === 'undefined' || !modelsReady){
      status.textContent = 'جاري تجهيز نظام التعرف على الوجه، انتظر لحظة...';
    }else if(video.readyState >= 2 && video.videoWidth && !_checkinBusy){
      let r = null;
      try{ r = await detect(); }catch(e){}
      if(my !== _autoLoopId || !checkStream) return;
      const bad = r && faceQuality(r, video);
      if(r && !bad && r.detection.score >= AUTO_MIN_SCORE){
        const d = Array.from(r.descriptor); size = r.inputSize;
        // لقطة لا تشبه السابقة (تغيّر الشخص أو اهتزاز شديد): نبدأ العد من جديد
        frames = frames.length && faceDist(frames[frames.length - 1], d) > 0.55 ? [d] : frames.concat([d]);
      }else frames = [];
      if(frames.length >= AUTO_STABLE_FRAMES){ await submitCheckin(frames.slice(-AUTO_STABLE_FRAMES), true); return; }
      status.textContent = bad || (frames.length ? 'ثبّت وجهك لحظة...' : 'ضع وجهك داخل الدائرة — سيتم التحقق تلقائيًا');
      if(frames.length) continue; // اللقطة التالية فورًا لتأكيد الثبات
    }
    await sleep(200);
  }
}

// زر "تحقق من الوجه" يبقى متاحًا كبديل يدوي (وبعد رفض الخادم لا نعيد المحاولة تلقائيًا حتى لا تتكرر الطلبات)
async function captureCheckin(){
  const status = $id('checkCamStatus');
  if(!currentWorker?.hasFace){ status.textContent = 'لا توجد بصمة وجه محفوظة لهذا الحساب'; return; }
  if(!checkStream){ await openFaceModal(); return; }
  if(_checkinBusy) return;
  _autoLoopId++; // يوقف الحلقة التلقائية أثناء المحاولة اليدوية
  const btn = $id('checkCaptureBtn');
  btn.disabled = true;
  status.textContent = 'جاري التحقق من الوجه...';
  const video = $id('checkVideo');
  const d1 = await detectFaceDescriptor(video, status, CHECKIN_INPUT_SIZE);
  const d2 = d1 && await detectFaceDescriptor(video, status, CHECKIN_INPUT_SIZE); // لقطة ثانية للتأكيد
  btn.disabled = false;
  if(!d1) return;
  await submitCheckin(d2 ? [d1, d2] : [d1], false);
}

let _localFaceFails = 0;
async function submitCheckin(descs, auto){
  const status = $id('checkCamStatus');
  const btn = $id('checkCaptureBtn');
  // 1) التحقق المحلي أولًا: غير مطابق = رد فوري ومحاولة جديدة بلا انتظار الخادم. بعد عدة مرات يُرسل
  //    للخادم رغم ذلك (هو الحكم: قد يكون مرجع الهاتف قديمًا — تغيّر المظهر أو الإضاءة)
  const local = localFaceCheck(descs);
  if(local === false && ++_localFaceFails < LOCAL_FACE_TRIES){
    status.textContent = 'الوجه غير مطابق — ثبّت وجهك أمام الكاميرا في إضاءة جيدة';
    if(auto) setTimeout(() => { if(checkStream && !_checkinBusy) autoCheckinLoop(); }, 800);
    return;
  }
  _checkinBusy = true; btn.disabled = true;
  // 2) مطابق محليًا: قبول فوري على الشاشة، والخادم يؤكد في الخلفية
  if(local){ closeFaceModal(); showLocalCheckin('pending'); toast('تم تسجيل حضورك ✓ بانتظار موافقة الإدارة'); }
  else status.textContent = 'تم التقاط الوجه ✓ جاري التحقق وتسجيل الحضور...';
  let res;
  try{
    res = await sendReliable('checkin', workerAuth({ descriptors: descs }), { optimistic: !!local });
  }catch(error){
    if(isLockedError(error)){ closeFaceModal(); lockApp(); return; }
    if(local){ notifyUser('لم يُسجَّل حضورك', error.message, 'info'); _workerPrefetch = null; renderWorkerStats(); return; }
    status.textContent = error.message + (auto ? ' — اضغط "تحقق من الوجه" للمحاولة مجددًا' : '');
    return;
  }finally{ _checkinBusy = false; btn.disabled = false; }
  _localFaceFails = 0;
  if(res.queued){ // لا اتصال: يُرسل تلقائيًا فور عودته (نفس اليوم)
    if(!local){ closeFaceModal(); showLocalCheckin('queued'); toast('لا يوجد اتصال — سيُرسل حضورك تلقائيًا فور عودة الاتصال'); }
    return;
  }
  rememberFace(descs, local === false); // مرجع التحقق المحلي (أو تحديثه إن رفضه المرجع القديم وقبله الخادم)
  if(!local){ toast(res.alreadyCheckedIn ? 'تم تسجيل حضورك اليوم بالفعل' : 'تم تسجيل حضورك، بانتظار موافقة الإدارة'); closeFaceModal(); }
  renderWorkerStats();
}
// حضور اليوم على الشاشة قبل رد الخادم: pending (تحقق الهاتف محليًا) أو queued (بانتظار عودة الاتصال)
function showLocalCheckin(status){
  const c = readLocalCache(CACHE_W) || {}, p = riyadhParts();
  const rec = { id: 'local-' + uid(), workerId: currentWorker.id, wage: currentWorker.wage, date: todayStr(), time: p.hour + ':' + p.minute,
    timestamp: Date.now(), status, local: true };
  _workerPrefetch = { worker: currentWorker, log: (c.log || []).filter(r => !r.local).concat([rec]), advances: c.advances || [], at: Date.now() };
  renderWorkerStats();
}

/* =========================================================================
   تسجيل الخروج
   ========================================================================= */
// الخروج يحدث هنا فقط (بضغطة المستخدم): يُنهي جلسة الإدارة في الخادم ويمسح الرقم المحفوظ،
// وإلا يعيد التطبيق إدخال المستخدم تلقائيًا عند الفتح التالي
// تطبيق الإدارة وتطبيق العمال على نفس الجهاز يشتركان في التخزين: كل منهما يمسح بياناته فقط عند الخروج
function logout(){
  const token = ADMIN_MODE && getAdminToken();
  if(token) apiCall('adminLogout', { token }, { silent:true }).catch(()=>{});
  // حضور لم يُرسل يخص العامل الذي خرج (قد يدخل غيره من الهاتف). عمليات الإدارة تبقى: تُرسل بعد الدخول التالي
  if(!ADMIN_MODE){ forgetFace(); outboxSave([]); }
  currentWorker = null;
  currentPhone = null; _pendingUnlock = null;
  setWorkerSession(''); _hasPasskey = false; _lockOpts = null; _pkOpts = null; _pkOffered = false;
  setModal('settleModal', false); _settleShown = '';
  if(ADMIN_MODE){ clearAdminToken(); clearAdminDevice(); clearLocalCaches(CACHE_A); }
  else{ clearRememberedPhone(); clearLocalCaches(CACHE_W); clearNext(PK_NEXT); }
  pushUnsubscribe();
  _adminVer = ''; _adminFullAt = 0; _adminSeen = null; _workerVer = ''; _workerFullAt = 0; _workerHash = ''; _workerWv = ''; _pendingVer = ''; _lastDeviceStatus = '';
  if(ADMIN_MODE){ showScreen('screen-admin-login'); return; } // صفحة الإدارة تبقى صفحة إدارة
  showScreen('screen-landing');
  ensureFaceModels(); // شاشة الدخول قد يستخدمها عامل بعد خروج الإدارة
}

/* =========================================================================
   الفتح بقفل الهاتف (بصمة الإصبع/الوجه أو رمز الهاتف) — Passkeys / WebAuthn
   - عند التفعيل ينشئ الهاتف مفتاحًا سريًا في شريحة الأمان، لا يعمل إلا بعد قفل الهاتف.
   - عند كل فتح: الخادم يرسل تحديًا عشوائيًا، الهاتف يوقّعه بعد البصمة/الرمز، والخادم يتحقق من التوقيع.
   - فتح سريع: كل فتح ناجح يعيد معه «تحدي الفتح التالي» (لمرة واحدة، صالح أيامًا) يُحفظ على الجهاز، فتظهر
     نافذة البصمة فور فتح التطبيق بلا انتظار طلب تحدٍّ من الخادم.
   - التطبيق لا يرى البصمة ولا الرمز إطلاقًا. الجلسة في الذاكرة فقط: إغلاق التطبيق = قفل.
   ========================================================================= */
let _hasPasskey = false;          // هذا الجهاز مفعّل عليه القفل
let _lockOpts = null, _lockOptsAt = 0, _unlocking = false, _unlockFails = 0;
let _pkOpts = null, _pkOffered = false;
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

async function passkeySupported(){
  try{ return !!(window.PublicKeyCredential && window.isSecureContext && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch(e){ return false; }
}
function updateExitButton(){
  const b = $id('workerExitBtn');
  if(b) b.textContent = _hasPasskey ? '🔒 قفل' : 'تسجيل الخروج';
  updatePasskeyStatus();
}
// حالة القفل في "إدارة الحساب": مفعّل، أو سبب عدم توفره بوضوح، أو زر تفعيل
async function updatePasskeyStatus(){
  renderNotifRows();
  const st = $id('pkStatus'), btn = $id('pkEnableBtn');
  if(!st) return;
  const row = st.closest('.pk-row');
  const set = (text, showBtn, on) => { row.classList.remove('hidden'); st.textContent = text; st.classList.toggle('on', !!on); btn.classList.toggle('hidden', !showBtn); };
  if(_hasPasskey) return set('مفعّل ✓ — يُطلب قفل هاتفك عند كل فتح للتطبيق', false, true);
  if(!window.isSecureContext) return set('يعمل فقط من رابط التطبيق الرسمي (https)', false);
  if(!await passkeySupported()) return set('غير متاح: فعّل قفل الشاشة (رمز أو بصمة) في إعدادات هاتفك، ثم أعد فتح التطبيق', false);
  set('غير مفعّل — فعّله ليفتح التطبيق ببصمتك أو رمز هاتفك فقط', true);
}
// من زر "تفعيل": يعرض نافذة التفعيل فورًا (بغض النظر عن اختيار "لاحقًا" سابقًا)
function openPasskeySetup(){
  try{ localStorage.removeItem(PK_LATER); }catch(e){}
  _pkOffered = false;
  offerPasskey(true);
}
// الجهاز مسجل: زر الخروج يقفل التطبيق فقط (لا تعود صفحة الدخول/إنشاء الحساب)
function workerExit(){ if(_hasPasskey) lockApp(); else logout(); }

function lockApp(auto){
  setWorkerSession(''); _pendingUnlock = null;
  _workerPrefetch = null;
  if(!$id('faceModal').classList.contains('hidden')) closeFaceModal();
  setModal('passkeyModal', false);
  setModal('settleModal', false); _settleShown = ''; // تعود بعد الفتح (حالتها في الخادم)
  showLockScreen(currentWorker || (readLocalCache(CACHE_W) || {}).worker, auto);
}
function showLockScreen(worker, auto){
  _hasPasskey = true;
  const first = worker && worker.name ? String(worker.name).split(' ')[0] : '';
  $id('lockName').textContent = first ? 'مرحبًا ' + first : 'مرحبًا';
  $id('lockHint').textContent = 'افتح التطبيق ببصمة الإصبع أو الوجه أو رمز قفل الهاتف';
  $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
  if(visibleScreen() !== 'screen-lock') showScreen('screen-lock');
  // التحدي يُجلب مسبقًا: الضغط على الزر يفتح نافذة البصمة فورًا (وآيفون يشترط ذلك)
  prefetchUnlock().then(o => { if(o && auto && !_unlocking) unlockApp(false); });
}
async function prefetchUnlock(){
  if(_lockOpts && Date.now() - _lockOptsAt < 8 * 60000) return _lockOpts;
  const n = peekNext(PK_NEXT, x => x.phone === currentPhone && x.credId);
  if(n){ _lockOpts = { challenge: n.c, credId: n.credId, hasPasskey: true, fromNext: true }; _lockOptsAt = Date.now(); return _lockOpts; }
  try{
    const o = await apiCall('passkeyOptions', workerAuth(), { silent:true });
    if(!o.hasPasskey){ _hasPasskey = false; resumeWorkerSession(currentPhone, true); return null; } // أعادت الإدارة ضبط القفل
    _lockOpts = o; _lockOptsAt = Date.now();
    return o;
  }catch(error){
    // الجهاز لم يعد معتمدًا أو الحساب حُذف: المسار العادي يحدد الشاشة الصحيحة
    if(/الجلسة غير صالحة/.test(error.message)) resumeWorkerSession(currentPhone, true);
    else $id('lockHint').textContent = navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : error.message;
    return null;
  }
}
async function unlockApp(userTap){
  if(ADMIN_MODE) return adminUnlockApp(userTap);
  if(_unlocking) return;
  _unlocking = true;
  const btn = $id('lockBtn'), hint = $id('lockHint');
  btn.disabled = true;
  let shown = false, o = null, signed = false;
  try{
    o = await prefetchUnlock();
    if(!o) return;
    _lockOpts = null; // التحدي لمرة واحدة
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: b64ToBytes(o.challenge), allowCredentials: [{ type:'public-key', id: b64ToBytes(o.credId) }],
      userVerification: 'required', timeout: 60000 } });
    signed = true;
    if(o.fromNext) clearNext(PK_NEXT);
    hint.textContent = 'جاري التحقق...';
    // تحقق الهاتف نجح: لوحته من النسخة المحفوظة على جهازه فورًا، والخادم يؤكد التوقيع ويحدّث البيانات خلال لحظات
    const c = readLocalCache(CACHE_W);
    if(c && c.phone === currentPhone && c.worker && (c.worker.status || 'active') === 'active'){
      _workerPrefetch = { worker: c.worker, log: c.log || [], advances: c.advances || [], at: Date.now() };
      openWorkerDashboard(c.worker); shown = true;
    }
    const r = cred.response;
    const data = workerAuth({ credId: cred.id, clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature) });
    const done = res => {
      setWorkerSession(res.session);
      saveNext(PK_NEXT, { phone: currentPhone, credId: cred.id, c: res.next });
      _unlockFails = 0;
      handleWorkerResponse(res);
    };
    const rid = newRequestId();
    try{ done(await apiCall('passkeyUnlock', data, { requestId: rid })); }
    catch(e){
      // بصمة الهاتف نجحت والخادم لم يُجب (اتصال/ضغط لحظي): يبقى داخل لوحته من النسخة المحفوظة، والتأكيد
      // يُعاد تلقائيًا بنفس الطلب حتى يصل — بلا طلب البصمة من جديد وبلا رسالة خطأ
      if(!(e.net && shown)) throw e;
      _pendingUnlock = { action: 'passkeyUnlock', data, rid, done, fail: err => { showLockScreen(currentWorker); $id('lockHint').textContent = err.message; } };
    }
  }catch(e){
    if(shown) showLockScreen(currentWorker); // الخادم رفض: تعود شاشة القفل
    if(userTap) _unlockFails++;
    hint.textContent = e && e.name === 'NotAllowedError' ? 'لم يكتمل التحقق — اضغط الزر للمحاولة مجددًا' : (e && e.message) || 'تعذر الفتح، حاول مجددًا';
    $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
    if(o && !signed){ _lockOpts = o; _lockOptsAt = Date.now(); } // لم يُرسل للخادم: نفس التحدي صالح للضغطة التالية
    else prefetchUnlock(); // تحدٍّ جديد جاهز للضغطة التالية
  }finally{ _unlocking = false; btn.disabled = false; }
}

// عرض التفعيل بعد الدخول (مرة في اليوم إن اختار "لاحقًا")، فقط إن كان الهاتف يدعم القفل
async function offerPasskey(manual){
  if(_hasPasskey || _pkOffered || !currentPhone) return;
  let later = 0; try{ later = Number(localStorage.getItem(PK_LATER) || 0); }catch(e){}
  if(Date.now() - later < 24 * 3600e3 || !await passkeySupported()) return;
  _pkOffered = true;
  try{ _pkOpts = await apiCall('passkeyOptions', workerAuth(), { silent:true }); }
  catch(e){ _pkOffered = false; if(manual) toast(e.message); updatePasskeyStatus(); return; }
  if(_pkOpts.hasPasskey){ _hasPasskey = true; updateExitButton(); return; }
  if(!['screen-worker','screen-pending'].includes(visibleScreen())){ _pkOffered = false; return; }
  setModal('passkeyModal', true);
}
function passkeyLater(){
  try{ localStorage.setItem(ADMIN_MODE ? ADMIN_PK_LATER : PK_LATER, String(Date.now())); }catch(e){}
  setModal('passkeyModal', false);
}
async function enablePasskey(){
  if(ADMIN_MODE) return adminEnableLock();
  const btn = $id('passkeyYes');
  btn.disabled = true;
  try{
    const o = _pkOpts || await apiCall('passkeyOptions', workerAuth());
    _pkOpts = null;
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: b64ToBytes(o.challenge), rp: { name: APP_NAME_AR },
      user: { id: b64ToBytes(o.userId), name: o.userName, displayName: o.displayName },
      pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
      authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'preferred' },
      attestation: 'none', timeout: 60000 } });
    const r = cred.response;
    if(!r.getPublicKey || !r.getAuthenticatorData || !r.getPublicKey()) throw new Error('المتصفح قديم ولا يدعم القفل — حدّث المتصفح ثم حاول');
    const res = await apiCall('passkeyRegister', workerAuth({ credId: cred.id, clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.getAuthenticatorData()), publicKey: bufToB64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm() }));
    setWorkerSession(res.session);
    saveNext(PK_NEXT, { phone: currentPhone, credId: res.credId || cred.id, c: res.next });
    _hasPasskey = true; updateExitButton();
    const c = readLocalCache(CACHE_W); if(c){ c.passkey = true; saveLocalCache(CACHE_W, c); }
    setModal('passkeyModal', false);
    toast('تم التفعيل ✓ سيُفتح التطبيق من الآن بقفل هاتفك');
  }catch(e){
    toast(e && e.name === 'NotAllowedError' ? 'لم يكتمل التفعيل — اضغط «تفعيل الآن» للمحاولة مجددًا' : (e && e.message) || 'تعذر التفعيل');
    apiCall('passkeyOptions', workerAuth(), { silent:true }).then(o => { _pkOpts = o; }).catch(()=>{});
  }finally{ btn.disabled = false; }
}
// عودة للتطبيق بعد أكثر من دقيقة في الخلفية: يُقفل من جديد
let _hiddenAt = 0;
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'hidden'){ if(!_unlocking) _hiddenAt = Date.now(); return; }
  if(_hiddenAt && Date.now() - _hiddenAt > RELOCK_MS){
    if(ADMIN_MODE){ if(adminLockOn() && visibleScreen() === 'screen-admin') lockAdmin(true); }
    else if(_hasPasskey && ['screen-worker','screen-pending'].includes(visibleScreen())) lockApp(true);
  }
  _hiddenAt = 0;
});

/* =========================================================================
   لوحة الإدارة
   ========================================================================= */
/* ---------- دخول الإدارة: صفحة مخفية (admin.html) + حساب أساسي دائم ----------
   create: أول مرة — كلمة المرور الحالية (ADMIN_PASSWORD) ثم اسم مستخدم وكلمة مرور جديدة
   login : اسم المستخدم وكلمة المرور (وبعد resetAdminAccess: المؤقتة + كلمة مرور جديدة)
   بصمة الجهاز لا تُطلب عند الدخول: هي «الفتح بقفل الهاتف» الاختياري، ويُفعَّل من داخل اللوحة (🔐 الأمان). */
const ADMIN_MODE = IS_ADMIN_APP;
let _alMode = null, _alOpts = null;
function showAdminLoginError(msg){ const e = $id('adminLoginError'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
function deviceLabel(){
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'جهاز';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return os + (br ? ' — ' + br : '');
}
async function prepareAdminLogin(){
  try{
    const o = await apiCall('adminOptions', { deviceId: getDeviceId() }, { silent:true });
    _alOpts = o; _alMode = o.mode === 'create' ? 'create' : 'login';
  }catch(e){
    _alMode = _alMode || 'login'; showAdminLoginError(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : e.message);
  }
  renderAdminLoginForm();
}
function renderAdminLoginForm(){
  const m = _alMode || 'login', mustChange = m === 'login' && !!(_alOpts && _alOpts.mustChange);
  const show = (id, on) => $id(id).classList.toggle('hidden', !on);
  show('alUserRow', m === 'login');
  show('alNewRows', m === 'create' || mustChange);
  show('alNewUserRow', m === 'create');
  show('alBackLink', !ADMIN_MODE);
  $id('alPassLabel').textContent = m === 'create' ? 'كلمة مرور الإدارة الحالية' : mustChange ? 'كلمة المرور المؤقتة' : 'كلمة المرور';
  $id('adminPass').autocomplete = m === 'create' || mustChange ? 'off' : 'current-password';
  const T = {
    create: ['إنشاء حساب الإدارة', 'أول دخول: أدخل كلمة مرور الإدارة الحالية، ثم اختر اسم مستخدم دائمًا وكلمة مرور جديدة.'],
    login: mustChange ? ['دخول الإدارة', 'أُعيد ضبط الدخول: ادخل بكلمة المرور المؤقتة، ثم اختر كلمة مرور جديدة.'] : ['دخول الإدارة', 'اسم المستخدم وكلمة المرور']
  }[m];
  $id('alTitle').textContent = T[0];
  $id('alSub').textContent = T[1];
  $id('adminLoginBtn').textContent = m === 'create' ? 'إنشاء الحساب والدخول' : 'دخول';
}
const webauthnOk = () => !!(window.PublicKeyCredential && window.isSecureContext && navigator.credentials);
const WEBAUTHN_MSG = 'بصمة الجهاز تعمل فقط من رابط التطبيق الرسمي (https) في متصفح حديث (Chrome أو Safari أو Edge)';

async function adminLogin(){
  const btn = $id('adminLoginBtn');
  if(btn.disabled) return;
  btn.disabled = true; showAdminLoginError('');
  try{
    const data = { user: $id('adminUser').value.trim(), password: $id('adminPass').value, deviceId: getDeviceId(), ua: deviceLabel(),
      since: (readLocalCache(CACHE_A) || {}).version || '', delta: 1 };
    if(_alMode !== 'create' && !data.user) throw new Error('أدخل اسم المستخدم');
    if(!data.password) throw new Error('أدخل كلمة المرور');
    if(!$id('alNewRows').classList.contains('hidden')){
      if($id('adminNewPass').value !== $id('adminNewPass2').value) throw new Error('كلمتا المرور الجديدتان غير متطابقتين');
      data.newPassword = $id('adminNewPass').value;
      if(_alMode === 'create') data.newUser = $id('adminNewUser').value.trim();
    }
    finishAdminLogin(await apiCall('adminLogin', data));
  }catch(e){
    showAdminLoginError((e && e.message) || 'تعذر الدخول');
    if(/انتهت|غير موجود|أُنشئ/.test((e && e.message) || '')) prepareAdminLogin();
  }finally{ btn.disabled = false; }
}
async function finishAdminLogin(res, quiet){
  // دخول ببصمة جهاز: يُحفظ الجهاز (والفتح بقفل الهاتف يبقى كما اختاره المدير: غير مفعّل حتى يفعّله)
  const dev = getAdminDevice();
  if(res.keyId || dev) setAdminDevice({ id: res.keyId || (dev && dev.id) || '', user: res.user || (dev && dev.user) || '', lock: !!(dev && dev.lock) });
  if(res.next && res.keyId) saveNext(ADMIN_NEXT, { id: res.keyId, c: res.next }); // الفتح القادم بلا انتظار الخادم
  setAdminToken(res.token); // بعد حفظ الاختيار: محفوظة على الجهاز أو في الذاكرة فقط
  updateAdminExit();
  if(!quiet) setTimeout(offerAdminLock, 1200);
  ['adminPass','adminNewPass','adminNewPass2'].forEach(id => $id(id).value = '');
  _alMode = null; _alOpts = null;
  if(res.admin) _adminFresh = applyAdminData(res.admin);
  showScreen('screen-admin');
  await renderAdmin();
  if(res.user && !quiet) toast('مرحبًا ' + res.user + ' ✓');
}

/* ---------- فتح تطبيق الإدارة بقفل الهاتف — اختياري (نفس شاشة قفل تطبيق العمال، بشعار الإدارة) ----------
   يُفعَّل بزر «تفعيل» (نافذة بعد الدخول، أو من «🔐 الأمان»). بعد التفعيل: كل فتح للتطبيق (أو عودة بعد دقيقة
   في الخلفية) = شاشة القفل، ونافذة البصمة تظهر تلقائيًا. الخادم يتحقق من توقيع مفتاح الجهاز ثم يعطي جلسة جديدة. */
function updateAdminExit(){ const b = $id('adminExitBtn'); if(b) b.textContent = adminLockOn() ? '🔒 قفل' : 'تسجيل الخروج'; }
function adminExit(){ if(adminLockOn()) lockAdmin(); else logout(); }
const ADMIN_PK_LATER = PK_LATER + '_admin';
// نافذة «احمِ لوحة الإدارة بقفل الهاتف» بعد الدخول (مرة في اليوم إن اختار «لاحقًا») — مثل تطبيق العمال
async function offerAdminLock(){
  if(adminLockOn() || !getAdminToken() || visibleScreen() !== 'screen-admin') return;
  let later = 0; try{ later = Number(localStorage.getItem(ADMIN_PK_LATER) || 0); }catch(e){}
  if(Date.now() - later < 24 * 3600e3 || !webauthnOk()) return;
  $id('passkeyModal').querySelector('h2').textContent = 'احمِ لوحة الإدارة بقفل الهاتف';
  $id('passkeyModal').querySelector('.sub').textContent = 'بعد التفعيل تُفتح لوحة الإدارة ببصمة الإصبع أو الوجه أو رمز قفل هاتفك فقط، وتُقفل عند إغلاق التطبيق، فلا يستطيع من يحمل هاتفك فتحها. التطبيق لا يرى بصمتك ولا رمزك.';
  setModal('passkeyModal', true);
}
// حالة الفتح بقفل الهاتف في «🔐 الأمان»
function renderAdminLockRow(){
  renderNotifRows();
  const st = $id('admPkStatus'), btn = $id('admPkBtn'), on = adminLockOn();
  if(!st) return;
  st.classList.toggle('on', on);
  st.textContent = on ? 'مفعّل ✓ — تُفتح اللوحة ببصمتك أو رمز هاتفك عند كل فتح'
    : !webauthnOk() ? 'غير متاح في هذا المتصفح — افتح تطبيق الإدارة المثبّت'
    : 'غير مفعّل — فعّله لتُقفل اللوحة عند إغلاق التطبيق وتُفتح ببصمتك فقط';
  btn.textContent = on ? 'إيقاف' : 'تفعيل';
  btn.className = 'btn btn-sm ' + (on ? 'btn-outline' : 'btn-amber');
  btn.classList.toggle('hidden', !on && !webauthnOk());
}
function adminToggleLock(){
  if(!adminLockOn()) return adminEnableLock();
  if(!confirm('إيقاف الفتح بقفل الهاتف؟ ستُفتح لوحة الإدارة على هذا الجهاز مباشرة بلا بصمة.')) return;
  const d = getAdminDevice(); d.lock = false; setAdminDevice(d);
  setAdminToken(getAdminToken()); // الجلسة تُحفظ على الجهاز من جديد
  updateAdminExit(); renderAdminLockRow();
  toast('أُوقف الفتح بقفل الهاتف');
}
// التفعيل: تُسجَّل بصمة هذا الجهاز الآن (مفتاح في شريحة أمان الهاتف يحفظ الخادم نصفه العام)، أو — إن كان
// مسجّلًا من قبل — تُجرَّب البصمة للتأكد أنها تعمل. بعدها الجلسة في الذاكرة فقط
async function adminEnableLock(){
  const btns = [$id('passkeyYes'), $id('admPkBtn')];
  btns.forEach(b => b.disabled = true);
  try{
    if(!webauthnOk()) throw new Error(WEBAUTHN_MSG);
    const d = getAdminDevice() || {};
    const o = await apiCall('adminOptions', { deviceId: getDeviceId() });
    const allow = o.allow || [];
    const tryExisting = async ids => { // مفتاح مسجّل على هذا الجهاز: تجربة البصمة → جلسة جديدة
      const cred = await navigator.credentials.get({ publicKey: { challenge: b64ToBytes(o.challenge),
        allowCredentials: ids.map(id => ({ type:'public-key', id: b64ToBytes(id) })), userVerification: 'required', timeout: 60000 } });
      const r = cred.response;
      return apiCall('adminUnlock', { ua: deviceLabel(), since: _adminVer || '', delta: 1, assertion: { credId: cred.id,
        clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature) } });
    };
    let res;
    if(d.id && allow.includes(d.id)) res = await tryExisting([d.id]);
    else{
      const user = d.user || 'admin';
      let cred = null;
      try{
        cred = await navigator.credentials.create({ publicKey: {
          challenge: b64ToBytes(o.challenge), rp: { name: APP_NAME_AR + ' — الإدارة' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: user, displayName: 'الإدارة — ' + user },
          pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
          authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'preferred' },
          excludeCredentials: allow.map(id => ({ type:'public-key', id: b64ToBytes(id) })), attestation: 'none', timeout: 60000 } });
      }catch(e){ if(!(e && e.name === 'InvalidStateError')) throw e; } // الجهاز مسجّل من قبل (ضاع أثره المحلي فقط)
      if(cred){
        const r = cred.response;
        if(!r.getPublicKey || !r.getAuthenticatorData || !r.getPublicKey()) throw new Error('المتصفح قديم ولا يدعم بصمة الجهاز — حدّثه ثم حاول');
        res = await apiCall('adminAddKey', { token: getAdminToken(), credId: cred.id, clientDataJSON: bufToB64u(r.clientDataJSON),
          authenticatorData: bufToB64u(r.getAuthenticatorData()), publicKey: bufToB64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
          name: deviceLabel(), ua: deviceLabel() });
      }else res = await tryExisting(allow);
    }
    setAdminDevice({ id: res.keyId, user: res.user || d.user || '', lock: true });
    saveNext(ADMIN_NEXT, { id: res.keyId, c: res.next });
    setAdminToken(res.token || getAdminToken()); // في الذاكرة فقط من الآن
    try{ localStorage.removeItem(ADMIN_PK_LATER); }catch(e){}
    setModal('passkeyModal', false);
    updateAdminExit(); renderAdminLockRow();
    toast('تم التفعيل ✓ ستُفتح لوحة الإدارة من الآن بقفل هاتفك');
  }catch(e){
    toast(e && e.name === 'NotAllowedError' ? 'لم يكتمل التفعيل — اضغط «تفعيل» للمحاولة مجددًا' : (e && e.message) || 'تعذر التفعيل');
  }finally{ btns.forEach(b => b.disabled = false); }
}
function lockAdmin(auto){
  clearAdminToken(); _pendingUnlock = null;
  document.querySelectorAll('[id$="Modal"]:not(.hidden)').forEach(m => m.classList.add('hidden'));
  showAdminLock(auto);
}
function showAdminLock(auto){
  const d = getAdminDevice() || {};
  document.querySelector('#screen-lock .lock-app').textContent = 'لوحة الإدارة — الحماية العالمية';
  $id('lockName').textContent = d.user ? 'مرحبًا ' + d.user : 'مرحبًا';
  $id('lockHint').textContent = 'افتح لوحة الإدارة ببصمة الإصبع أو الوجه أو رمز قفل الهاتف';
  $id('lockHelp').textContent = 'إذا غيّرت قفل هاتفك أو حُذف هذا الجهاز من أجهزة الإدارة، ادخل باسم المستخدم وكلمة المرور.';
  $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
  $id('lockPwLink').classList.remove('hidden');
  showScreen('screen-lock');
  // التحدي يُجلب مسبقًا: الضغط على الزر يفتح نافذة البصمة فورًا (وآيفون يشترط ذلك)
  prefetchAdminUnlock().then(o => { if(o && auto && !_unlocking) unlockApp(false); });
}
async function prefetchAdminUnlock(){
  if(_lockOpts && Date.now() - _lockOptsAt < 4 * 60000) return _lockOpts; // تحدي الإدارة صالح 5 دقائق
  const d0 = getAdminDevice() || {}, n = d0.id && peekNext(ADMIN_NEXT, x => x.id === d0.id);
  if(n){ _lockOpts = { mode: 'login', challenge: n.c, allow: [n.id], fromNext: true }; _lockOptsAt = Date.now(); return _lockOpts; }
  try{
    const o = await apiCall('adminOptions', { deviceId: getDeviceId() }, { silent:true });
    if($id('screen-lock').classList.contains('hidden')) return null; // انتقل لشاشة أخرى أثناء الانتظار
    const d = getAdminDevice() || {};
    // حُذف هذا الجهاز من أجهزة الإدارة أو أُعيد ضبط الدخول: الدخول الكامل من جديد
    if(o.mode !== 'login' || (d.id && !(o.allow || []).includes(d.id))){ clearAdminDevice(); updateAdminExit(); showScreen('screen-admin-login'); return null; }
    _lockOpts = o; _lockOptsAt = Date.now();
    return o;
  }catch(e){
    $id('lockHint').textContent = navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : e.message;
    return null;
  }
}
async function adminUnlockApp(userTap){
  if(_unlocking) return;
  _unlocking = true;
  const btn = $id('lockBtn'), hint = $id('lockHint');
  btn.disabled = true;
  let shown = false, o = null, signed = false;
  try{
    if(!webauthnOk()) throw new Error(WEBAUTHN_MSG);
    o = await prefetchAdminUnlock();
    if(!o) return;
    _lockOpts = null; // التحدي لمرة واحدة
    const d = getAdminDevice() || {};
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64ToBytes(o.challenge),
      allowCredentials: (d.id ? [d.id] : o.allow || []).map(id => ({ type:'public-key', id: b64ToBytes(id) })),
      userVerification: 'required', timeout: 60000 } });
    signed = true;
    if(o.fromNext) clearNext(ADMIN_NEXT);
    hint.textContent = 'جاري التحقق...';
    // تحقق الهاتف نجح: اللوحة من النسخة المحفوظة على الجهاز فورًا، والخادم يؤكد التوقيع ويرسل ما تغيّر فقط
    const c = readLocalCache(CACHE_A);
    if(c && c.workers){ applyAdminData(c); showScreen('screen-admin'); drawAdmin(); shown = true; }
    const r = cred.response;
    const data = { ua: deviceLabel(), since: (readLocalCache(CACHE_A) || {}).version || '', delta: 1, assertion: { credId: cred.id,
      clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature) } };
    const done = res => { _unlockFails = 0; return finishAdminLogin(res, true); };
    const rid = newRequestId();
    let res;
    try{ res = await apiCall('adminUnlock', data, { requestId: rid }); }
    catch(e){
      // البصمة نجحت والخادم لم يُجب: تبقى اللوحة من النسخة المحفوظة، والتأكيد يُعاد تلقائيًا بنفس الطلب
      if(!(e.net && shown)) throw e;
      _pendingUnlock = { action: 'adminUnlock', data, rid, done, fail: err => { showScreen('screen-lock'); $id('lockHint').textContent = err.message; prefetchAdminUnlock(); } };
      return;
    }
    await done(res);
  }catch(e){
    const msg = (e && e.message) || '';
    if(shown) showScreen('screen-lock'); // الخادم رفض: تعود شاشة القفل
    if(/غير مسجّل للإدارة/.test(msg)){ clearAdminDevice(); updateAdminExit(); showScreen('screen-admin-login'); showAdminLoginError(msg); return; }
    if(userTap) _unlockFails++;
    hint.textContent = e && e.name === 'NotAllowedError' ? 'لم يكتمل التحقق — اضغط الزر للمحاولة مجددًا' : msg || 'تعذر الفتح، حاول مجددًا';
    $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
    if(o && !signed){ _lockOpts = o; _lockOptsAt = Date.now(); } // لم يُرسل للخادم: نفس التحدي صالح للضغطة التالية
    else prefetchAdminUnlock(); // تحدٍّ جديد جاهز للضغطة التالية
  }finally{ _unlocking = false; btn.disabled = false; }
}
// من شاشة القفل: نسيان الفتح السريع على هذا الجهاز والدخول الكامل (اسم المستخدم + كلمة المرور + بصمة الجهاز)
function adminLockUsePassword(){ clearAdminDevice(); _lockOpts = null; updateAdminExit(); showScreen('screen-admin-login'); }
// الجلسة انتهت أو أُلغيت من الخادم: شاشة القفل إن كان الجهاز مسجّلًا، وإلا نموذج الدخول
function adminSessionLost(){ clearAdminToken(); if(adminLockOn()) showAdminLock(false); else showScreen('screen-admin-login'); }

/* ---------- أمان الحساب (من لوحة الإدارة) ---------- */
const adminUrl = () => new URL('admin.html', location.href).href.split('#')[0];
async function openAdminSecurity(){
  setModal('securityModal', true);
  renderAdminLockRow();
  $id('secAdminUrl').textContent = adminUrl();
  $id('secPwForm').classList.add('hidden');
  $id('secKeys').innerHTML = '<p class="al-hint">جاري التحميل...</p>';
  try{ renderAdminSecurity(await apiCall('adminSecurity', { token: getAdminToken() })); }
  catch(e){ $id('secKeys').innerHTML = `<p class="al-hint">${escapeHtml(e.message)}</p>`; }
}
function closeAdminSecurity(){ setModal('securityModal', false); }
function renderAdminSecurity(s){
  const d = ts => ts ? rptDateTime(new Date(ts).toISOString()) : '-';
  $id('secAccount').innerHTML = `الحساب الأساسي: <b>${escapeHtml(s.user)}</b>${s.createdAt ? `<br>أُنشئ: <b>${d(s.createdAt)}</b>` : ''}`;
  $id('secKeys').innerHTML = (s.keys || []).map(k => `<div class="sec-key"><span class="k-ic">${/iPhone|Android|iPad/.test(k.name) ? '📱' : '💻'}</span>
    <div class="k-info"><b>${escapeHtml(k.name)}${k.current ? '<span class="k-cur">هذا الجهاز</span>' : ''}</b>أُضيف ${d(k.at)} · آخر دخول ${d(k.used)}</div>
    <button class="btn btn-ghost btn-sm" data-id="${escapeHtml(k.id)}" data-name="${escapeHtml(k.name)}" onclick="adminRemoveKey(this.dataset.id, this.dataset.name)">حذف</button></div>`).join('')
    || '<p class="al-hint">لا توجد — فعّل «الفتح بقفل الهاتف» بالأعلى لإضافة هذا الجهاز</p>';
  $id('secSessions').textContent = `الجلسات المفتوحة الآن: ${s.sessions || 1} — إن رأيت عددًا أكبر مما تتوقع، أنهِ الجلسات الأخرى وغيّر كلمة المرور.`;
}
async function adminRemoveKey(id, name){
  const mine = (getAdminDevice() || {}).id === id;
  if(!confirm(mine ? 'حذف هذا الجهاز؟ يتوقف الفتح بقفل الهاتف عليه، وتنتهي جلسته فتدخل باسم المستخدم وكلمة المرور من جديد.'
                   : 'حذف الجهاز «' + name + '»؟ ستنتهي جلساته فورًا.')) return;
  try{
    const s = await apiCall('adminRemoveKey', { token: getAdminToken(), keyId: id });
    if(mine){ clearAdminDevice(); clearAdminToken(); setModal('securityModal', false); updateAdminExit(); showScreen('screen-admin-login'); toast('حُذف هذا الجهاز'); return; }
    renderAdminSecurity(s); toast('تم حذف الجهاز');
  }catch(e){ toast(e.message); }
}
async function adminChangePassword(){
  const o = $id('secOldPass').value, n = $id('secNewPass').value, n2 = $id('secNewPass2').value;
  if(n !== n2) return toast('كلمتا المرور الجديدتان غير متطابقتين');
  const btn = $id('secPwBtn'); btn.disabled = true;
  try{
    const r = await apiCall('adminChangePassword', { token: getAdminToken(), oldPassword: o, newPassword: n });
    ['secOldPass','secNewPass','secNewPass2'].forEach(id => $id(id).value = '');
    $id('secPwForm').classList.add('hidden');
    toast('تم تغيير كلمة المرور ✓' + (r.ended ? ' وأُنهيت ' + r.ended + ' جلسة أخرى' : ''));
    openAdminSecurity();
  }catch(e){ toast(e.message); }
  finally{ btn.disabled = false; }
}
async function adminLogoutOthers(){
  if(!confirm('إنهاء كل جلسات الإدارة على الأجهزة الأخرى؟ (تبقى مسجّلًا هنا)')) return;
  try{ const r = await apiCall('adminLogoutOthers', { token: getAdminToken() }); toast(r.ended ? 'أُنهيت ' + r.ended + ' جلسة' : 'لا توجد جلسات أخرى'); openAdminSecurity(); }
  catch(e){ toast(e.message); }
}
function copyAdminUrl(btn){
  const done = () => { btn.textContent = 'تم ✓'; setTimeout(() => btn.textContent = 'نسخ', 1500); };
  try{ navigator.clipboard.writeText(adminUrl()).then(done, () => toast(adminUrl())); }catch(e){ toast(adminUrl()); }
}

function switchAdminTab(tab){
  document.querySelectorAll('.admin-tab').forEach(b=>{
    const active = b.dataset.tab===tab;
    b.classList.toggle('active', active);
    if(active && typeof b.scrollIntoView === 'function'){
      b.scrollIntoView({inline:'center', block:'nearest', behavior:'smooth'});
    }
  });
  ['overview','workers','summary','log','devices'].forEach(t=>{
    $id('tab-'+t).classList.toggle('hidden', t!==tab);
  });
  if(tab==='summary') renderAdminSummary();
}

// يجلب كل بيانات الإدارة من الشيت دفعة واحدة، ثم يعيد رسم كل الأقسام منها
async function refreshAdminData(){
  let res;
  try{ res = await apiCall('getAdminData', { token: getAdminToken() }); }
  catch(error){
    if(!error.net) toast(error.message); // انقطاع الاتصال: تبقى النسخة المحفوظة (الشريط السفلي يبيّن الحالة)
    if(/غير مصرح|الجلسة/.test(error.message)){ adminSessionLost(); }
    throw error;
  }
  applyAdminData(res);
}
// «ما تغيّر فقط» من الخادم يُدمج مع النسخة المحفوظة (التي طُلب التغيير منها): استبدال/إضافة الصفوف المتغيرة
// وحذف المحذوفة. null = النسخة المحفوظة ليست الإصدار المطلوب ← يلزم تحميل كامل
function mergeAdminDelta(base, d){
  if(!base || base.version !== d.since) return null;
  const rm = d.removed || {};
  const upsert = (list, rows, gone) => {
    const m = new Map((list || []).map(x => [String(x.id), x]));
    (rows || []).forEach(x => m.set(String(x.id), x));
    (gone || []).forEach(id => m.delete(String(id)));
    return [...m.values()];
  };
  return Object.assign({}, base, {
    version: d.version, historyFrom: d.historyFrom || base.historyFrom,
    workers: upsert(base.workers, d.workers, rm.workers), log: upsert(base.log, d.log, rm.log), advances: upsert(base.advances, d.advances, rm.advances),
    archives: d.archives || base.archives, pendingDevices: d.pendingDevices || base.pendingDevices
  });
}
// يعيد false إن لم تُطبَّق البيانات (تغييرات على نسخة غير المحفوظة) — المستدعي يطلب نسخة كاملة
function applyAdminData(d){
  // «لم يتغير شيء منذ نسختك»: تُستخدم النسخة المحفوظة على الجهاز كما هي (بلا تحميل البيانات من جديد)
  if(d && d.unchanged){ const c = readLocalCache(CACHE_A); if(!c || c.version !== d.version) return false; d = c; }
  let full = !!(d && !d.unchanged);
  if(d && d.delta){
    full = false;
    const c = readLocalCache(CACHE_A);
    const m = c && c.version === d.version ? c : mergeAdminDelta(c, d); // (رد طُبّق من قبل: لا يُدمج مرتين)
    if(!m){ _adminVer = ''; _adminFullAt = 0; return false; }
    d = m;
  }
  if(getAdminToken()) saveLocalCache(CACHE_A, d); // رد وصل بعد القفل/الخروج لا يُحفظ على الجهاز
  STATE.workers = d.workers || []; STATE.log = d.log || []; STATE.advances = d.advances || [];
  STATE.archives = d.archives || []; STATE.pendingDevices = d.pendingDevices || []; STATE.historyFrom = d.historyFrom || '';
  // اسم العامل لا يصل مكررًا مع كل سجل (رد أصغر): يُؤخذ من قائمة العمال — بعد الحفظ فلا تكبر النسخة المحلية
  const names = new Map(STATE.workers.map(w => [String(w.id), w.name]));
  STATE.log.forEach(r => { r.workerName = names.get(String(r.workerId)) || ''; });
  if(d.version){ _adminVer = d.version; if(full) _adminFullAt = Date.now(); } // نسخة كاملة دورية رغم التغييرات
  adminNews(d);
  return true;
}

async function renderAdmin(){
  // إن وصلت البيانات مرفقة مع آخر عملية (اعتماد/رفض/سلفة...) نرسم فورًا دون طلب إضافي
  if(_adminFresh){ _adminFresh = false; }
  else{ try{ await refreshAdminData(); }catch(e){ if(!e.net) return; } } // بلا اتصال: تُرسم النسخة المحفوظة
  drawAdmin();
}

/* عمليات الإدارة الفورية: التعديل يظهر على الشاشة لحظة الضغط، والخادم يُحدَّث في الخلفية.
   عند رفض الخادم للعملية تُعرض رسالته وتُعاد البيانات الحقيقية من الشيت. انقطاع الاتصال ليس رفضًا:
   التعديل يبقى على الشاشة والعملية تُرسل تلقائيًا عند عودة الاتصال (صندوق الإرسال). */
let _adminOps = 0, _adminOverlap = false, _lastAdmin = null;
async function adminAction(action, data, mutate, okMsg){
  if(mutate){ mutate(STATE); drawAdmin(); }
  if(++_adminOps > 1) _adminOverlap = true;
  let ok = true, queued = false;
  try{
    // since: إصدار نسخة اللوحة الحالية — يُرفق مع الرد ما تغيّر منذه فقط
    queued = !!(await sendReliable(action, Object.assign({ token: getAdminToken(), since: _adminVer, delta: 1 }, data))).queued;
    if(queued) toast((okMsg ? okMsg + ' — ' : '') + 'تُرسل للخادم تلقائيًا عند عودة الاتصال');
    else if(okMsg) toast(okMsg);
  }catch(error){ ok = false; toast(error.message); }
  if(--_adminOps === 0){
    const latest = _lastAdmin; _lastAdmin = null; _adminFresh = false;
    if(queued && ok){ _adminOverlap = false; drawAdmin(); return ok; } // لا اتصال: يبقى التعديل الفوري كما هو
    if(!ok || _adminOverlap || !latest || !applyAdminData(latest)){ _adminOverlap = false; try{ await refreshAdminData(); }catch(e){ return ok; } }
    drawAdmin();
  }
  return ok;
}
const phoneKeyOf = p => String(p||'').replace(/\D/g,'').replace(/^0+/,'');

function drawAdmin(){
  const workers = loadWorkers();
  const log = loadLog();
  const today = todayStr();
  const month = monthStr();
  const byId = new Map(workers.map(w=>[w.id,w]));
  const approvedCost = pred => log
    .filter(r=>r.status==='approved' && pred(r))
    .reduce((sum,r)=> sum + recordWage(r, byId.get(r.workerId)), 0);

  $id('admTotalWorkers').textContent = workers.filter(isActive).length;
  $id('admPending').textContent = log.filter(r=>r.status==='pending').length;
  $id('admDailyCost').textContent = fmt(approvedCost(r=>r.date===today));
  $id('admMonthCost').textContent = fmt(approvedCost(r=>r.date.startsWith(month)));

  renderPendingWorkers(workers);
  renderPending(workers, log);
  renderWorkersTable(workers);
  populateLogFilter(workers);
  renderAdminLog();
  renderAdminSummary();
  renderDevices();
}

function renderPendingWorkers(workers = loadWorkers()){
  const list = workers.filter(isPendingWorker);
  $id('pendingWorkersCount').textContent = list.length;
  $id('pendingWorkersCount').classList.toggle('hidden', list.length === 0);
  renderRows('pendingWorkersBody','pendingWorkersEmpty', list, w=>{
    const chars = [...String(w.name||'?').trim()];
    const color = (chars[0]?.charCodeAt(0) || 0) % 4;
    const date = w.createdAt ? new Date(w.createdAt).toLocaleDateString('ar-EG') : '';
    return `<div class="req-card">
      <div class="req-head">
        <div class="req-avatar c${color}">${escapeHtml(chars[0] || '?')}</div>
        <div class="req-info">
          <b class="req-name">${escapeHtml(w.name)}</b>
          <span class="req-meta"><span class="req-prof">${escapeHtml(w.profession)}</span>${date ? `<span>${escapeHtml(date)}</span>` : ''}</span>
        </div>
      </div>
      <div class="req-email">${escapeHtml(workerPhone(w))}</div>
      ${w.deviceFrom ? `<div class="req-warn">📱 سجّل من جهاز مرتبط بحساب «${escapeHtml(w.deviceFrom)}» — القبول ينقل الجهاز إلى هذا الحساب ويُلغي ربطه بـ «${escapeHtml(w.deviceFrom)}»</div>` : ''}
      ${w.reviewNote ? `<div class="req-warn bad">⚠ ${escapeHtml(w.reviewNote)}</div>` : ''}
      <div class="req-actions">
        <input type="number" inputmode="decimal" min="0" id="wage-${w.id}" placeholder="قيمة اليومية" aria-label="قيمة اليومية"
               onkeydown="if(event.key==='Enter')approveWorker('${w.id}')">
        <button class="btn btn-green btn-sm" onclick="approveWorker('${w.id}')">قبول</button>
        <button class="btn btn-danger btn-sm" onclick="rejectWorker('${w.id}')">رفض</button>
      </div>
    </div>`;
  });
}

async function approveWorker(id){
  const wage = parseFloat($id('wage-'+id)?.value);
  if(!wage || wage<=0){ toast('أدخل قيمة يومية صحيحة قبل القبول'); return; }
  const cur = loadWorkers().find(w=>w.id===id);
  if(cur && cur.reviewNote && !confirm(`تنبيه: ${cur.reviewNote}\n\nهل تريد قبول «${cur.name}» رغم ذلك؟`)) return;
  adminAction('approveWorker', { workerId:id, wage }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w){ w.status = 'active'; w.wage = wage; delete w.reviewNote; delete w.deviceFrom; }
  }, 'تم قبول العامل بنجاح');
}

async function rejectWorker(id){
  const worker = loadWorkers().find(w=>w.id===id);
  if(!worker) return;
  if(!confirm(`هل تريد رفض طلب "${worker.name}"؟ سيتم حذف بياناته المسجلة.`)) return;
  adminAction('rejectWorker', { workerId:id }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w) w.status = 'deleted';
  }, 'تم رفض الطلب');
}

function renderPending(workers = loadWorkers(), allLog = loadLog()){
  const byId = new Map(workers.map(w=>[w.id,w]));
  const q = searchQuery('pendingSearch');
  const pending = allLog.filter(r=>r.status==='pending' && matches(q, r.workerName)).sort((a,b)=>b.timestamp-a.timestamp);
  renderRows('pendingBody','pendingEmpty', pending, r=>{
    const w = byId.get(r.workerId) || {};
    return `<tr>
      <td data-label="العامل">${escapeHtml(r.workerName)}</td>
      <td data-label="المهنة">${escapeHtml(w.profession||'-')}</td>
      <td data-label="التاريخ">${escapeHtml(r.date)}</td>
      <td data-label="الوقت">${escapeHtml(r.time)}</td>
      <td data-label="" class="td-actions">
        <button class="btn btn-green btn-sm" onclick="decideAttendance('${r.id}','approved')">اعتماد</button>
        <button class="btn btn-danger btn-sm" onclick="decideAttendance('${r.id}','rejected')">رفض</button>
      </td>
    </tr>`;
  });
}

// اعتماد دفعة واحدة لكل الطلبات المعلّقة (المطابقة للبحث إن وُجد) — مهم عند كثرة العمال
async function approveAllPending(){
  const q = searchQuery('pendingSearch');
  const log = loadLog();
  const list = log.filter(r=>r.status==='pending' && matches(q, r.workerName));
  if(!list.length){ toast('لا توجد طلبات لاعتمادها'); return; }
  if(!confirm(`اعتماد ${list.length} طلب حضور${q ? ' (المطابقة للبحث فقط)' : ''}؟`)) return;
  const ids = new Set(list.map(r=>r.id));
  adminAction('approveAllPending', { ids: [...ids] }, s=>{
    s.log.forEach(r=>{ if(ids.has(r.id) && r.status==='pending') r.status = 'approved'; });
  }, `تم اعتماد ${list.length} طلب`);
}

function decideAttendance(id, decision){
  adminAction('decideAttendance', { logId:id, decision }, s=>{
    const r = s.log.find(x=>x.id===id); if(r) r.status = decision;
  }, decision==='approved' ? 'تم اعتماد الحضور' : 'تم رفض الحضور');
}

const WORKER_STATUS_PILL = {
  active:  ['pill-approved','نشط'],
  pending: ['pill-pending','بانتظار الموافقة'],
  deleted: ['pill-rejected','ألغى حسابه']
};

function renderWorkersTable(workers = loadWorkers()){
  const q = searchQuery('workerSearch');
  renderRows('workersBody','workersEmpty', workers.filter(w=>matches(q, w.name, w.profession, workerPhone(w))), w=>{
    const [cls,label] = WORKER_STATUS_PILL[w.status||'active'] || WORKER_STATUS_PILL.active;
    return `<tr>
      <td data-label="الاسم">${escapeHtml(w.name)}${w.passkey ? ' <span title="يفتح التطبيق بقفل الهاتف">🔒</span>' : ''}</td><td data-label="المهنة">${escapeHtml(w.profession)}</td><td data-label="اليومية">${isActive(w) ? escapeHtml(w.wage) : '-'}</td><td data-label="رقم الهاتف">${escapeHtml(workerPhone(w))}</td>
      <td data-label="الحالة"><span class="pill ${cls}">${label}</span></td>
      <td data-label="تاريخ التسجيل">${new Date(w.createdAt).toLocaleDateString('ar-EG')}</td>
      <td data-label="" class="td-actions">${w.status==='deleted' ? '' : (w.passkey ? `<button class="btn btn-outline btn-sm" title="العامل غيّر قفل هاتفه أو لا يستطيع الفتح" onclick="resetDeviceLock('${w.id}')">🔓 إعادة ضبط القفل</button>` : '') + `<button class="btn btn-danger btn-sm" onclick="adminDeleteWorker('${w.id}')">حذف</button>`}</td>
    </tr>`;
  });
}

async function adminDeleteWorker(id){
  const worker = loadWorkers().find(w=>w.id===id);
  if(!worker) return;
  if(!confirm(`هل تريد حذف حساب "${worker.name}"؟ لن يتمكن من الدخول أو تسجيل الحضور، وتُرفض طلبات حضوره المعلّقة. تبقى سجلات حضوره وسلفه وتصفياته محفوظة، ويبقى رصيده ظاهرًا في الحسابات حتى تصفيته.`)) return;
  adminAction('adminDeleteWorker', { workerId:id }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w){ w.status = 'deleted'; w.hasFace = false; }
    s.log.forEach(r=>{ if(r.workerId===id && r.status==='pending') r.status = 'rejected'; });
  }, 'تم حذف حساب العامل');
}

// العامل غيّر قفل هاتفه أو حذف مفتاح التطبيق فلم يعد يستطيع الفتح: يُمسح القفل ويفعّله من جديد
function resetDeviceLock(id){
  const worker = loadWorkers().find(w=>w.id===id);
  if(!worker || !confirm(`إعادة ضبط قفل التطبيق لـ "${worker.name}"؟\nسيفتح التطبيق على جهازه المعتمد دون قفل، ثم يُطلب منه تفعيل القفل من جديد.`)) return;
  adminAction('resetDeviceLock', { workerId:id }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w) w.passkey = false;
  }, 'تمت إعادة ضبط القفل');
}

function populateLogFilter(workers){
  const sel = $id('logFilter');
  const current = sel.value;
  sel.replaceChildren(new Option('كل العمال',''));
  workers.forEach(w=> sel.add(new Option(w.name,w.id)));
  sel.value = current;
}

function renderAdminLog(){
  const filter = $id('logFilter').value;
  let log = loadLog().sort((a,b)=>b.timestamp-a.timestamp);
  if(filter) log = log.filter(r=>r.workerId===filter);
  const q = searchQuery('logSearch');
  if(q) log = log.filter(r=>matches(q, r.workerName, r.date));
  const statusMap = {pending:'بانتظار الموافقة', approved:'معتمد', rejected:'مرفوض'};
  renderRows('fullLogBody','fullLogEmpty', log, r=>`<tr>
      <td data-label="العامل">${escapeHtml(r.workerName)}</td><td data-label="التاريخ">${escapeHtml(r.date)}</td><td data-label="الوقت">${escapeHtml(r.time)}</td>
      <td data-label="الحالة"><span class="pill pill-${escapeHtml(r.status)}">${statusMap[r.status]}</span></td>
    </tr>`);
}

/* =========================================================================
   طلبات الأجهزة الجديدة
   ========================================================================= */
function renderDevices(){
  const list = STATE.pendingDevices || [];
  $id('devicesTabCount').textContent = list.length;
  $id('devicesTabCount').classList.toggle('hidden', list.length===0);
  // مطابقة الرقم بالأرقام فقط وبدون الأصفار البادئة (الشيت القديم حذف الصفر: 0555… → 555…)
  const byPhone = new Map(loadWorkers().filter(w=>w.status!=='deleted').map(w=>[phoneKeyOf(workerPhone(w)), w]));
  renderRows('devicesBody','devicesEmpty', list, d=>{
    const w = byPhone.get(phoneKeyOf(d.phone)) || (d.workerName ? { name: d.workerName } : null);
    const date = d.createdAt ? new Date(d.createdAt).toLocaleString('ar-EG') : '';
    return `<div class="req-card">
      <div class="req-head">
        <div class="req-avatar c2">📱</div>
        <div class="req-info">
          <b class="req-name">${escapeHtml(w ? w.name : d.phone)}</b>
          <span class="req-meta"><span>${escapeHtml(d.phone)}</span>${date?`<span>${escapeHtml(date)}</span>`:''}</span>
        </div>
      </div>
      <div class="req-email" style="direction:rtl;text-align:right;white-space:normal;">${d.model || d.os || d.browser
        ? `<b>${escapeHtml([d.model || 'طراز غير معروف', d.os, d.browser].filter(Boolean).join(' — '))}</b>` : escapeHtml(d.userAgent || 'جهاز غير معروف')}</div>
      ${d.fromName ? `<div class="req-warn">🔄 طلب فتح حساب آخر: هذا الجهاز مرتبط الآن بحساب «${escapeHtml(d.fromName)}» — الاعتماد ينقله إلى «${escapeHtml(w ? w.name : d.phone)}» ويُلغي ربطه بـ «${escapeHtml(d.fromName)}»</div>` : ''}
      <div class="req-actions">
        <button class="btn btn-green btn-sm" onclick="approveDevice('${d.id}')">${d.fromName ? 'اعتماد ونقل الجهاز' : 'اعتماد الجهاز'}</button>
        <button class="btn btn-danger btn-sm" onclick="rejectDevice('${d.id}')">رفض</button>
      </div>
    </div>`;
  });
}

// (مطابق للخادم: اعتماد جهاز يغلق كل الطلبات المعلّقة لنفس الرقم، والرفض يغلق نسخ نفس الجهاز)
function approveDevice(deviceLogId){
  const dev = (STATE.pendingDevices||[]).find(d=>d.id===deviceLogId);
  adminAction('approveDevice', { deviceLogId }, dev && (s=>{
    s.pendingDevices = s.pendingDevices.filter(d=>phoneKeyOf(d.phone)!==phoneKeyOf(dev.phone));
  }), 'تم اعتماد الجهاز');
}
function rejectDevice(deviceLogId){
  if(!confirm('هل تريد رفض الدخول من هذا الجهاز؟')) return;
  const dev = (STATE.pendingDevices||[]).find(d=>d.id===deviceLogId);
  adminAction('rejectDevice', { deviceLogId }, dev && (s=>{
    s.pendingDevices = s.pendingDevices.filter(d=>!(phoneKeyOf(d.phone)===phoneKeyOf(dev.phone) && d.deviceId===dev.deviceId));
  }), 'تم رفض الجهاز');
}

/* =========================================================================
   ملخص الإدارة: التكلفة حسب المهنة + حسابات العمال (سلف وتصفية)
   ملاحظة: الحساب هنا للعرض والتأكيد فقط — الخادم يعيد احتساب الأرقام
   بشكل مستقل ومُلزِم عند التنفيذ الفعلي (اعتماد/تصفية)، فلا خطر من فارق
   بسيط بين لحظة الجلب ولحظة الضغط على الزر.
   ========================================================================= */

function computeAccount(worker, log, advances, untilTs = Infinity){
  const since = worker.lastSettledAt || 0;
  const earned = log
    .filter(r=>r.workerId===worker.id && r.status==='approved' && r.timestamp>since && r.timestamp<=untilTs)
    .reduce((sum,r)=> sum + recordWage(r, worker), 0);
  const advanced = advances
    .filter(a=>a.workerId===worker.id && a.timestamp>since && a.timestamp<=untilTs)
    .reduce((sum,a)=> sum + a.amount, 0);
  return { earned: money(earned), advanced: money(advanced), net: money(earned - advanced) };
}

function countPending(worker, log, untilTs = Infinity){
  const since = worker.lastSettledAt || 0;
  return log.filter(r=>r.workerId===worker.id && r.status==='pending' && r.timestamp>since && r.timestamp<=untilTs).length;
}

function monthLabel(m){
  const [y,mm] = m.split('-').map(Number);
  const names = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return names[mm-1] + ' ' + y;
}

function daysInMonth(monthValue){
  const [y,m] = monthValue.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// الأشهر المتاحة = نافذة السجلات التي يرسلها الخادم (historyFrom)؛ الأشهر الأقدم كاملة في الأرشيف الشهري
function populateMatrixMonths(){
  const sel = $id('matrixMonthSelect');
  const previous = sel.value;
  const p = riyadhParts(), from = (STATE.historyFrom || '').slice(0, 7);
  const months = [];
  for(let y = Number(p.year), m = Number(p.month); months.length < 12; ){
    const v = `${y}-${String(m).padStart(2,'0')}`;
    if(from && v < from) break;
    months.push(v);
    if(--m === 0){ m = 12; y--; }
  }
  sel.innerHTML = months.map(m=>`<option value="${m}">${monthLabel(m)}</option>`).join('');
  sel.value = months.includes(previous) ? previous : monthStr();
}

// فهرس سريع (عامل+تاريخ → سجل) بدل log.find داخل حلقتين متداخلتين
function indexLog(log){
  const idx = new Map();
  log.forEach(r=>{ const k = logKey(r.workerId, r.date); if(!idx.has(k)) idx.set(k, r); });
  return idx;
}

// صف شهري لعامل واحد — يُستخدم في الجدول الحي
function monthRow(w, month, numDays, idx){
  const days = {};
  let approvedCount = 0, earned = 0;
  for(let d=1; d<=numDays; d++){
    const rec = idx.get(logKey(w.id, dayKey(month,d)));
    days[d] = rec ? rec.status : 'absent';
    if(rec && rec.status==='approved'){ approvedCount++; earned += recordWage(rec, w); }
  }
  return { days, approvedCount, earned };
}

function selectedMonth(){ return $id('matrixMonthSelect').value || monthStr(); }

// العمال الظاهرون في شهر: النشطون + كل من له حضور في هذا الشهر (حتى لو ألغى حسابه لاحقًا)
function monthWorkers(monthLog){
  const withRecords = new Set(monthLog.map(r=>r.workerId));
  return loadWorkers().filter(w => isActive(w) || withRecords.has(w.id));
}

function renderMonthlyMatrix(){
  const month = selectedMonth();
  const q = searchQuery('matrixSearch');
  const monthLog = loadLog().filter(r=>r.date.startsWith(month));
  const workers = monthWorkers(monthLog).filter(w=>matches(q, w.name, w.profession));
  const idx = indexLog(monthLog);
  const numDays = daysInMonth(month);
  const table = $id('matrixTable');
  const empty = $id('matrixEmpty');

  if(workers.length===0){ table.innerHTML=''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  let head = `<thead><tr><th style="position:sticky;right:0;background:var(--panel);text-align:right;">العامل</th>`;
  for(let d=1; d<=numDays; d++) head += `<th style="text-align:center;">${d}</th>`;
  head += `<th>أيام معتمدة</th><th>مستحق الشهر</th></tr></thead>`;

  let totalDays = 0, totalEarned = 0;
  const body = workers.map(w=>{
    const { days, approvedCount, earned } = monthRow(w, month, numDays, idx);
    totalDays += approvedCount; totalEarned += earned;
    const tag = isActive(w) ? '' : ' <small style="color:var(--red);font-weight:600;">(ملغى)</small>';
    let row = `<tr><td style="position:sticky;right:0;background:var(--panel);font-weight:700;">${escapeHtml(w.name)}${tag}</td>`;
    for(let d=1; d<=numDays; d++){
      const st = days[d];
      row += st==='absent'
        ? `<td style="text-align:center;color:var(--ink-soft);">—</td>`
        : `<td style="text-align:center;"><span class="pill ${ATT_CLASS[st]}">${ATT_SYMBOL[st]}</span></td>`;
    }
    return row + `<td>${approvedCount}</td><td>${fmt(earned)}</td></tr>`;
  }).join('');
  const foot = `<tfoot><tr><td style="position:sticky;right:0;">الإجمالي</td><td colspan="${numDays}"></td><td>${totalDays}</td><td>${fmt(totalEarned)}</td></tr></tfoot>`;
  table.innerHTML = head + '<tbody>' + body + '</tbody>' + foot;
}

// التكلفة التشغيلية لشهر = مجموع أجور أيام الحضور المعتمدة بتاريخ هذا الشهر (مطابق للخادم)
function computeProfessions(month){
  const byId = new Map(loadWorkers().map(w=>[w.id,w]));
  const map = {};
  loadLog().filter(r=>r.status==='approved' && r.date.startsWith(month)).forEach(r=>{
    const w = byId.get(r.workerId);
    const prof = (w && w.profession) || 'غير محدد';
    const p = map[prof] ||= { profession:prof, ids:new Set(), days:0, cost:0 };
    p.ids.add(r.workerId); p.days++; p.cost += recordWage(r, w);
  });
  return Object.values(map).map(p=>({ profession:p.profession, workers:p.ids.size, days:p.days, cost:money(p.cost) }))
    .sort((a,b)=> b.cost - a.cost);
}

function renderProfessionSummary(month){
  $id('professionTitle').textContent = 'التكلفة التشغيلية حسب المهنة — ' + monthLabel(month);
  const list = computeProfessions(month);
  renderRows('professionBody','professionEmpty', list, p=>
    `<tr><td data-label="المهنة">${escapeHtml(p.profession)}</td><td data-label="عدد العمال">${p.workers}</td><td data-label="أيام معتمدة">${p.days}</td><td data-label="التكلفة">${fmt(p.cost)}</td></tr>`, 1000);
  const tDays = list.reduce((s,p)=>s+p.days,0), tCost = money(list.reduce((s,p)=>s+p.cost,0));
  $id('professionFoot').innerHTML = list.length
    ? `<tr><td data-label="">التكلفة التشغيلية الإجمالية</td><td data-label="عدد العمال">${list.reduce((s,p)=>s+p.workers,0)}</td><td data-label="أيام معتمدة">${tDays}</td><td data-label="التكلفة">${fmt(tCost)}</td></tr>` : '';
}

function renderMonthAdvances(month){
  $id('monthAdvTitle').textContent = 'كشف السلف — ' + monthLabel(month);
  const byId = new Map(loadWorkers().map(w=>[w.id,w]));
  const list = loadAdvances().filter(a=>a.date.startsWith(month)).sort((a,b)=>a.timestamp-b.timestamp);
  renderRows('monthAdvBody','monthAdvEmpty', list, a=>{ const w = byId.get(a.workerId) || {};
    return `<tr><td data-label="التاريخ">${escapeHtml(a.date)}</td><td data-label="العامل">${escapeHtml(w.name||'-')}</td><td data-label="المهنة">${escapeHtml(w.profession||'-')}</td><td data-label="المبلغ" style="font-weight:800;">${fmt(a.amount)}</td><td data-label="ملاحظة">${escapeHtml(a.note||'-')}</td></tr>`; }, 1000);
  $id('monthAdvFoot').innerHTML = list.length
    ? `<tr><td data-label="">الإجمالي</td><td></td><td></td><td data-label="المبلغ">${fmt(list.reduce((s,a)=>s+a.amount,0))}</td><td></td></tr>` : '';
}

/* ---------------------------- التصفية الشهرية + تقرير PDF ---------------------------- */
let _closingMonth = false;
function setSummaryBusy(busy){
  _closingMonth = busy;
  ['closeMonthBtn','previewPdfBtn'].forEach(id=>{ const b = $id(id); if(b) b.disabled = busy; });
}

async function fetchMonthPreview(month){
  const res = await apiCall('previewMonthReport', { token: getAdminToken(), month });
  return res.report;
}

async function previewReportPdf(){
  if(_closingMonth) return;
  const month = selectedMonth();
  setSummaryBusy(true);
  try{
    const report = await fetchMonthPreview(month);
    await generateReportPdf(report);
  }catch(error){ toast(error.message); }
  finally{ setSummaryBusy(false); }
}

async function closeMonthForAll(){
  if(_closingMonth) return;
  const month = selectedMonth();
  setSummaryBusy(true);
  try{
    // الأرقام في رسالة التأكيد تأتي من الخادم نفسه (نفس دالة التصفية) وليست تقديرًا من المتصفح
    let pv;
    try{ pv = await fetchMonthPreview(month); }catch(error){ toast(error.message); return; }
    if(loadArchives().some(a=>a.month===month)){ toast('تم إقفال هذا الشهر سابقًا — نزّل تقريره من الأرشيف'); return; }
    if(pv.pendingTotal){ toast(`يوجد ${pv.pendingTotal} طلب حضور معلّق — اعتمده أو ارفضه قبل التصفية`); return; }
    if(!pv.workers.length){ toast('لا يوجد عمال لتصفيتهم'); return; }
    const t = pv.totals;
    const partial = month === monthStr() ? '\n⚠ هذا الشهر لم ينتهِ بعد — ستُصفّى الأيام حتى هذه اللحظة فقط.\n' : '';
    if(!confirm(`تصفية حسابات ${t.workers} عامل عن ${pv.monthLabel}\n\n`+
      `التكلفة التشغيلية: ${fmt(t.totalCost)}\nإجمالي المستحق: ${fmt(t.totalEarned)}\nإجمالي السلف: ${fmt(t.totalAdvances)}\n`+
      `الصافي المطلوب دفعه: ${fmt(t.totalNet)}\n`+(t.totalCarried ? `رصيد سالب يُرحّل للشهر التالي: ${fmt(t.totalCarried)}\n` : '')+
      `${partial}\nسيُحفظ التقرير كملف Google Sheets مستقل باسم الشهر ويُنشأ ملف PDF. لا يمكن التراجع. هل تريد المتابعة؟`)) return;

    let res;
    try{ res = await apiCall('closeMonthForAll', { token: getAdminToken(), month }); }
    catch(error){ toast(error.message); return; }
    if(res.archiveId && res.report) _archiveCache.set(res.archiveId, res.report);
    toast('تمت التصفية وحُفظ التقرير — جاري إنشاء PDF...');
    renderAdmin();
    // عند إعادة محاولة بعد انقطاع قد يعود الرد بدون التقرير (مختصرًا) — نجلبه من الأرشيف
    try{ await generateReportPdf(res.report || (res.archiveId ? await fetchArchive(res.archiveId) : null)); }
    catch(error){ toast('حُفظت التصفية، لكن تعذر إنشاء PDF: ' + error.message + ' — نزّله من الأرشيف'); }
  } finally { setSummaryBusy(false); }
}

function renderArchiveList(){
  const archives = [...loadArchives()].sort((a,b)=> String(b.month).localeCompare(String(a.month)));
  renderRows('archiveBody','archiveEmpty', archives, a=>`<tr>
      <td data-label="الشهر">${escapeHtml(a.monthLabel)}</td>
      <td data-label="تاريخ التصفية">${a.closedAt ? new Date(a.closedAt).toLocaleDateString('ar-EG') : '-'}</td>
      <td data-label="عدد العمال">${escapeHtml(a.totalWorkers)}</td>
      <td data-label="التكلفة التشغيلية">${a.totalCost ? fmt(a.totalCost) : '-'}</td>
      <td data-label="الصافي المدفوع">${fmt(a.totalNet)}</td>
      <td data-label="" class="td-actions">
        <button class="btn btn-outline btn-sm" onclick="viewArchive('${a.id}')">عرض</button>
        <button class="btn btn-green btn-sm" onclick="downloadArchivePdf('${a.id}')">PDF</button>
      </td>
    </tr>`);
}

const _archiveCache = new Map();
async function fetchArchive(id){
  if(_archiveCache.has(id)) return _archiveCache.get(id);
  const res = await apiCall('getArchive', { token: getAdminToken(), id });
  _archiveCache.set(id, res.report);
  return res.report;
}

async function downloadArchivePdf(id){
  try{ await generateReportPdf(await fetchArchive(id)); }
  catch(error){ toast(error.message); }
}

async function viewArchive(id){
  let r;
  try{ r = await fetchArchive(id); }catch(error){ toast(error.message); return; }
  const t = r.totals;
  $id('archiveViewTitle').textContent = 'التقرير الشهري — ' + r.monthLabel;
  const td = 'style="padding:6px;border-bottom:1px solid var(--line);"';
  let html = `<div class="summary-actions" style="margin:0 0 12px;"><button class="btn btn-green btn-sm" onclick="downloadArchivePdf('${id}')">📄 تنزيل التقرير PDF</button>
    ${/^https:\/\/docs\.google\.com\//.test(r.reportSheet || '')
      ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(r.reportSheet)}" target="_blank" rel="noopener">📊 فتح ملف التقرير في Google Sheets</a>`
      : r.reportSheet ? `<span style="font-size:12.5px;color:var(--ink-soft);">محفوظ في ورقة «${escapeHtml(r.reportSheet)}» داخل ملف العمل</span>` : ''}</div>
    <p style="font-size:14px;line-height:2;">التكلفة التشغيلية: <b>${fmt(t.totalCost)}</b> · المستحق: <b>${fmt(t.totalEarned)}</b> · السلف: <b>${fmt(t.totalAdvances)}</b> · الصافي المدفوع: <b>${fmt(t.totalNet)}</b>${t.totalCarried ? ` · مرحّل: <b>${fmt(t.totalCarried)}</b>` : ''}</p>`;
  html += `<h3 style="margin:14px 0 6px;">التكلفة حسب المهنة</h3><table style="width:100%;border-collapse:collapse;font-size:13px;"><tbody>`;
  r.professions.forEach(p=>{ html += `<tr><td ${td}>${escapeHtml(p.profession)}</td><td ${td}>${p.workers} عامل</td><td ${td}>${p.days} يوم</td><td ${td}><b>${fmt(p.cost)}</b></td></tr>`; });
  html += `<tr><td ${td}><b>الإجمالي</b></td><td ${td}></td><td ${td}>${t.approvedDays} يوم</td><td ${td}><b>${fmt(t.totalCost)}</b></td></tr></tbody></table>`;
  html += `<h3 style="margin:14px 0 6px;">ملخص الحسابات</h3><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr><th ${td}>العامل</th><th ${td}>أيام</th><th ${td}>المستحق</th><th ${td}>السلف</th><th ${td}>المدفوع</th><th ${td}>مرحّل</th></tr></thead><tbody>`;
  r.workers.forEach(w=>{ html += `<tr><td ${td}>${escapeHtml(w.name)}</td><td ${td}>${w.approvedDays}</td><td ${td}>${fmt(w.earned)}</td><td ${td}>${fmt(w.advances)}</td><td ${td}><b>${fmt(w.paid)}</b></td><td ${td}>${w.carried ? fmt(w.carried) : '-'}</td></tr>`; });
  html += `</tbody></table></div>`;
  $id('archiveViewContent').innerHTML = html;
  setModal('archiveViewModal', true);
}

function closeArchiveView(){ setModal('archiveViewModal', false); }

/* ---------------------------- مولّد التقرير PDF ---------------------------- */
// كل صفحة A4 أفقية تُرسم كصورة مستقلة (html2canvas) ثم تُجمع في PDF (jsPDF) — يحافظ على الخط العربي
// ويتجنب حد حجم الـ canvas في آيفون مع التقارير الطويلة.
const APP_NAME ='تطبيق ' + APP_NAME_AR + ' (' + APP_SHORT + ')';
const PDF_LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];
const RPT_W = 1123, RPT_H = 794; // A4 أفقي بدقة 96dpi
const RPT_CAP = 21;              // سعة الصفحة بوحدات "صف جدول" (عنوان قسم = 2، رأس جدول = 1)
const REPORT_CSS = `
.rpt-page{width:${RPT_W}px;height:${RPT_H}px;box-sizing:border-box;padding:0 0 46px;background:#fff;color:#182338;font-family:'Tajawal',Tahoma,Arial,sans-serif;direction:rtl;position:relative;overflow:hidden;}
.rpt-page *{letter-spacing:0!important;box-sizing:border-box;}
.rpt-band{background:#14213b;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:14px 34px;border-bottom:4px solid #e7a33e;}
.rpt-brand{display:flex;align-items:center;gap:14px;}
.rpt-brand img{height:54px;width:auto;}
.rpt-co{font-size:24px;font-weight:800;line-height:1.2;}
.rpt-app{font-size:12px;color:#c9d0de;margin-top:2px;}
.rpt-doc{text-align:left;}
.rpt-doc .t{font-size:19px;font-weight:800;}
.rpt-doc .m{font-size:14px;color:#e7a33e;font-weight:700;margin-top:3px;}
.rpt-meta{display:flex;justify-content:space-between;gap:10px;background:#f4f6fa;border-bottom:1px solid #e3e7ef;padding:7px 34px;font-size:12px;color:#5b6479;}
.rpt-meta b{color:#14213b;font-weight:700;}
.rpt-status{font-weight:800;padding:1px 10px;border-radius:999px;}
.rpt-status.fin{background:#e3f3ea;color:#1f7a56;} .rpt-status.drf{background:#fdecea;color:#bd4438;}
.rpt-body{padding:12px 34px 0;}
.rpt-sec{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800;color:#14213b;margin:4px 0 8px;}
.rpt-sec:before{content:'';width:5px;height:17px;border-radius:3px;background:#e7a33e;display:inline-block;}
.rpt-gap{height:14px;}
.rpt-tw{border:1px solid #d5dbe6;border-radius:10px;overflow:hidden;background:#fff;}
.rpt-tbl{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;}
.rpt-tbl th{background:#14213b;color:#fff;padding:8px 4px;font-weight:700;text-align:center;white-space:nowrap;border-left:1px solid #2b3b5f;border-bottom:3px solid #e7a33e;}
.rpt-tbl td{border-top:1px solid #e6e9f0;border-left:1px solid #e6e9f0;padding:4px 6px;text-align:center;height:26px;white-space:nowrap;overflow:hidden;color:#2a3450;}
.rpt-tbl th:last-child,.rpt-tbl td:last-child{border-left:0;}
.rpt-tbl td.nm{font-weight:700;color:#14213b;}
.rpt-tbl td.note{text-align:right;color:#5b6479;}
.rpt-tbl tr.rpt-zero td{height:0;padding:0;border:0;line-height:0;}
.rpt-empty{padding:9px 12px;text-align:center;font-size:12.5px;font-weight:700;color:#8f9bb5;background:#fafbfd;}
.rpt-tbl tbody tr:nth-child(even) td{background:#f6f8fc;}
.rpt-tbl tr.tot td{background:#fbeeda!important;font-weight:800;color:#14213b;border-top:2px solid #e7a33e;}
/* كشف الدوام: خط فاصل واضح بين كل عامل، فاصل بين الاسم والأيام وبين الأيام والمجاميع */
.rpt-mx{font-size:11px;}
.rpt-mx th{padding:4px 0 3px;font-size:10.5px;line-height:1.15;}
.rpt-mx th .wd{display:block;font-size:8.5px;font-weight:500;color:#aeb8cf;margin-top:1px;}
.rpt-mx th.we{background:#2e4270;} .rpt-mx th.we .wd{color:#e7a33e;}
.rpt-mx td{padding:0;height:27px;font-size:12px;}
.rpt-mx tbody tr td{border-top:2px solid #b9c3d6;}
.rpt-mx tbody tr:first-child td{border-top:0;}
.rpt-mx td.nm{font-size:11.5px;} .rpt-mx td.pr{font-size:10.5px;color:#5b6479;}
.rpt-mx td.pr,.rpt-mx th.prh{border-left:2px solid #8f9bb5;}
.rpt-mx td.first,.rpt-mx th.first{border-right:2px solid #8f9bb5;}
.rpt-mx th.sumh{background:#1d2c4d;}
.rpt-mx td.sum{background:#f1f4fa!important;font-weight:700;color:#14213b;}
.rpt-mx td.we{background:#eef1f6!important;}
.rpt-mx td.A{color:#1f7a56;font-weight:800;background:#e3f3ea!important;}
.rpt-mx td.R{color:#bd4438;font-weight:800;background:#fde8e6!important;}
.rpt-mx td.P{color:#b9761f;font-weight:800;background:#fff1da!important;}
.rpt-legend .lg{display:inline-block;width:18px;height:16px;line-height:16px;text-align:center;border:1px solid #cfd6e3;border-radius:4px;margin:0 2px 0 8px;font-weight:800;vertical-align:middle;}
.rpt-legend .lg.A{background:#e3f3ea;color:#1f7a56;} .rpt-legend .lg.R{background:#fde8e6;color:#bd4438;} .rpt-legend .lg.P{background:#fff1da;color:#b9761f;} .rpt-legend .lg.we{background:#eef1f6;}
.rpt-page .ltr{direction:ltr;unicode-bidi:isolate;display:inline-block;}
.rpt-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;}
.rpt-card{border:1px solid #dfe3ea;border-radius:10px;padding:9px 13px;border-right:4px solid #e7a33e;background:#fff;}
.rpt-card span{display:block;font-size:12px;color:#5b6479;}
.rpt-card b{display:block;font-size:20px;margin-top:3px;color:#14213b;}
.rpt-card.big{background:#14213b;} .rpt-card.big span{color:#c9d0de;} .rpt-card.big b{color:#fff;}
.rpt-card.red b{color:#bd4438;} .rpt-card.green b{color:#1f7a56;}
.rpt-notes{margin-top:10px;font-size:11.5px;color:#5b6479;line-height:1.9;}
.rpt-legend{font-size:11.5px;color:#5b6479;margin:-2px 0 6px;}
.rpt-foot{position:absolute;bottom:0;left:0;right:0;height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 34px;font-size:10.5px;color:#6b7489;border-top:1px solid #e3e7ef;background:#f9fafc;}
.rpt-foot .code{font-family:Consolas,'Courier New',monospace;color:#14213b;font-weight:700;direction:ltr;}
.rpt-wm{position:absolute;top:40%;left:0;right:0;text-align:center;font-size:120px;color:rgba(189,68,56,.06);transform:rotate(-14deg);font-weight:900;pointer-events:none;}
.rpt-sign{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:18px;}
.rpt-sign .box{flex:1;border:1px dashed #cfd5e0;border-radius:10px;padding:10px 14px;font-size:12px;color:#5b6479;min-height:86px;}
.rpt-sign .box b{display:block;color:#14213b;font-size:13px;margin-bottom:30px;}
.rpt-stamp{width:150px;height:150px;border-radius:50%;border:3px double #1f7a56;color:#1f7a56;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transform:rotate(-10deg);font-weight:800;flex:none;}
.rpt-stamp.drf{border-color:#bd4438;color:#bd4438;}
.rpt-stamp .s1{font-size:15px;} .rpt-stamp .s2{font-size:11px;margin:3px 0;} .rpt-stamp .s3{font-size:10px;font-family:Consolas,monospace;direction:ltr;}
.rpt-verify{margin-top:12px;border:1px solid #e3e7ef;border-radius:10px;background:#f9fafc;padding:9px 14px;font-size:11.5px;color:#5b6479;line-height:1.9;}
.rpt-verify .code{font-family:Consolas,'Courier New',monospace;color:#14213b;font-weight:800;direction:ltr;display:inline-block;}
.rpt-verify.has-qr{display:flex;align-items:center;gap:14px;}
.rpt-qr{width:86px;height:86px;flex:none;image-rendering:pixelated;border:1px solid #e3e7ef;border-radius:6px;background:#fff;}
.rpt-verify .signed{color:#1f7a56;font-weight:800;}
.rpt-verify .vurl{display:inline-block;direction:ltr;font-family:Consolas,'Courier New',monospace;font-size:10.5px;color:#1d4ed8;text-decoration:underline;white-space:nowrap;}`;

function ensureReportCss(){
  if($id('rptCss')) return;
  const st = document.createElement('style'); st.id = 'rptCss'; st.textContent = REPORT_CSS;
  document.head.appendChild(st);
}

function loadPdfLib(){
  return Promise.all([loadScript(PDF_LIBS[0], () => !!window.html2canvas), loadScript(PDF_LIBS[1], () => !!window.jspdf)])
    .catch(() => { throw new Error('تعذر تحميل مكتبة PDF'); });
}

// تاريخ/وقت بأرقام لاتينية وتوقيت الرياض (الأرقام الهندية مع "،" تنقلب ترتيبها داخل الصورة)
function rptDateTime(v){
  const p = riyadhParts(v ? new Date(v) : new Date());
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
// بصمة التقرير: رمز تحقق مشتق من محتواه — أي تعديل على الأرقام يغيّر الرمز
function reportFingerprint(r){
  const src = JSON.stringify({ m:r.month, f:!!r.final, c:r.closedAt||'', t:r.totals,
    w:r.workers.map(w=>[w.id, w.days, w.net, w.paid]), a:r.advances.map(a=>[a.date, a.amount]) });
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(let i=0; i<src.length; i++){ const c = src.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
  h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
  const hex = ((h2>>>0).toString(16).padStart(8,'0') + (h1>>>0).toString(16).padStart(8,'0')).toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

// يبني التقرير كمصفوفة صفحات HTML (مشتركة بين PDF والطباعة الاحتياطية)
/* حماية التقرير: التقرير النهائي يحمل توقيع الخادم (HMAC بمفتاح سري لا يصل للمتصفح) ورمز QR لصفحة التحقق.
   المسودة (أو خادم قديم بلا توقيع) تبقى برمز المحتوى المحلي، وهو لكشف الأخطاء فقط لا للاعتماد. */
const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const loadQrLib = () => loadScript(QR_LIB, () => !!window.qrcode);
const reportSigned = r => !!(r && r.final && r.signature && r.archiveId);
const verifyPageUrl = ()=> new URL('verify.html', location.href).href.split(/[?#]/)[0];
function reportVerifyUrl(r){ return verifyPageUrl() + '?id=' + encodeURIComponent(r.archiveId) + '&s=' + encodeURIComponent(r.signature); }
async function makeReportQr(r){
  if(!reportSigned(r)) return '';
  try{
    await loadQrLib();
    const q = window.qrcode(0, 'M'); q.addData(reportVerifyUrl(r)); q.make();
    return q.createDataURL(4, 1);
  }catch(e){ return ''; } // بلا اتصال: يبقى رقم التقرير ورمز التحقق المطبوعان للتحقق اليدوي
}

function buildReportPages(r){
  const t = r.totals, esc = escapeHtml, n = r.numDays;
  const signed = reportSigned(r);
  const code = signed ? r.signature : reportFingerprint(r);
  const reportNo = r.final && r.archiveId ? 'RPT-' + r.month.replace('-','') + '-' + String(r.archiveId).slice(0,6).toUpperCase() : 'مسودة';
  const createdAt = rptDateTime(r.final ? r.closedAt : r.generatedAt);

  // ---- الصفحة الأولى: الملخص العام + التكلفة حسب المهنة ----
  const cards = `<div class="rpt-cards">
    <div class="rpt-card big"><span>التكلفة التشغيلية الإجمالية</span><b>${fmt(t.totalCost)}</b></div>
    <div class="rpt-card"><span>عدد العمال</span><b>${t.workers}</b></div>
    <div class="rpt-card"><span>أيام العمل المعتمدة</span><b>${t.approvedDays}</b></div>
    <div class="rpt-card"><span>إجمالي المستحق منذ آخر تصفية</span><b>${fmt(t.totalEarned)}</b></div>
    <div class="rpt-card red"><span>إجمالي السلف</span><b>${fmt(t.totalAdvances)}</b></div>
    <div class="rpt-card green"><span>الصافي المدفوع</span><b>${fmt(t.totalNet)}</b></div>
    <div class="rpt-card red"><span>رصيد سالب مرحّل للشهر التالي</span><b>${fmt(t.totalCarried)}</b></div>
    <div class="rpt-card"><span>عدد السلف</span><b>${r.advances.length}</b></div>
  </div>`;
  const notes = `<div class="rpt-notes">
    <div>• التكلفة التشغيلية هي مجموع أجور أيام الحضور المعتمدة بتاريخ هذا الشهر.</div>
    <div>• المستحق والسلف والصافي تُحسب لكل عامل منذ آخر تصفية له حتى نهاية الشهر.</div>
    <div>• إن زادت السلف عن المستحق لا يُدفع شيء، ويُرحَّل الفرق كسلفة على الشهر التالي.</div>
    ${r.legacy ? '<div>• أرشيف من نسخة قديمة: كشف السلف التفصيلي غير متوفر.</div>' : ''}</div>`;

  // ---- الأقسام الجدولية (تُوزَّع على الصفحات حسب المساحة) ----
  const sections = [];
  sections.push({ title:'التكلفة التشغيلية حسب المهنة',
    head:`<colgroup><col style="width:40%"><col><col><col></colgroup><thead><tr><th>المهنة</th><th>عدد العمال</th><th>أيام معتمدة</th><th>التكلفة التشغيلية</th></tr></thead>`,
    rows:r.professions.map(p=>`<tr><td class="nm">${esc(p.profession)}</td><td>${p.workers}</td><td>${p.days}</td><td>${fmt(p.cost)}</td></tr>`),
    total:`<tr class="tot"><td>الإجمالي</td><td>${r.professions.reduce((s,p)=>s+p.workers,0)}</td><td>${t.approvedDays}</td><td>${fmt(t.totalCost)}</td></tr>`,
    empty:'لا يوجد حضور معتمد في هذا الشهر' });

  const [yy, mm] = r.month.split('-').map(Number);
  const weekend = d => new Date(Date.UTC(yy, mm-1, d)).getUTCDay() === 5; // الجمعة
  const WD = ['ح','ن','ث','ر','خ','ج','س']; // الأحد..السبت
  const wd = d => WD[new Date(Date.UTC(yy, mm-1, d)).getUTCDay()];
  let mxHead = `<colgroup><col style="width:132px"><col style="width:80px">${'<col>'.repeat(n)}<col style="width:42px"><col style="width:76px"></colgroup><thead><tr><th class="nmh">العامل</th><th class="prh">المهنة</th>`;
  for(let d=1; d<=n; d++) mxHead += `<th class="day${weekend(d)?' we':''}">${d}<span class="wd">${wd(d)}</span></th>`;
  mxHead += `<th class="sumh first">أيام</th><th class="sumh">المستحق</th></tr></thead>`;
  const SYM = { A:'✓', R:'✗', P:'○', '-':'' };
  sections.push({ title:'كشف الدوام الكامل', cls:'rpt-mx', breakBefore:true, extraLead:1,
    extra:'<div class="rpt-legend"><span class="lg A">✓</span> حضور معتمد <span class="lg R">✗</span> مرفوض <span class="lg P">○</span> معلّق <span class="lg">&nbsp;</span> غياب <span class="lg we">&nbsp;</span> يوم الجمعة</div>',
    head:mxHead,
    rows:r.workers.map(w=>{
      let row = `<tr><td class="nm">${esc(w.name)}</td><td class="pr">${esc(w.profession)}</td>`;
      for(let d=0; d<n; d++){ const c = w.days[d] || '-'; row += `<td class="${c}${weekend(d+1)?' we':''}">${SYM[c] || ''}</td>`; }
      return row + `<td class="sum first">${w.approvedDays}</td><td class="sum">${fmt(w.monthEarned)}</td></tr>`;
    }),
    total:`<tr class="tot"><td colspan="2">الإجمالي</td><td colspan="${n}"></td><td class="first">${t.approvedDays}</td><td>${fmt(r.workers.reduce((s,w)=>s+w.monthEarned,0))}</td></tr>`,
    empty:'لا يوجد عمال في هذا الشهر' });

  sections.push({ title:'ملخص الحسابات لكل عامل',
    head:`<colgroup><col style="width:38px"><col style="width:180px"><col style="width:120px"><col><col><col><col><col><col><col></colgroup><thead><tr><th>#</th><th>العامل</th><th>المهنة</th><th>اليومية</th><th>أيام الشهر</th><th>مستحق الشهر</th><th>السلف</th><th>الصافي</th><th>المدفوع</th><th>المرحّل</th></tr></thead>`,
    rows:r.workers.map((w,i)=>`<tr><td>${i+1}</td><td class="nm">${esc(w.name)}${w.status==='deleted'?' (ملغى)':''}</td><td>${esc(w.profession)}</td><td>${fmt(w.wage)}</td><td>${w.approvedDays}</td><td>${fmt(w.monthEarned)}</td><td>${fmt(w.advances)}</td><td style="color:${w.net<0?'#bd4438':'#1f7a56'};font-weight:800;">${fmt(w.net)}</td><td style="font-weight:800;">${fmt(w.paid)}</td><td>${w.carried?fmt(w.carried):'-'}</td></tr>`),
    total:`<tr class="tot"><td></td><td>الإجمالي</td><td></td><td></td><td>${t.approvedDays}</td><td>${fmt(r.workers.reduce((s,w)=>s+w.monthEarned,0))}</td><td>${fmt(t.totalAdvances)}</td><td>${fmt(t.totalEarned - t.totalAdvances)}</td><td>${fmt(t.totalNet)}</td><td>${fmt(t.totalCarried)}</td></tr>`,
    empty:'لا توجد حسابات' });

  sections.push({ title:'كشف السلف',
    head:`<colgroup><col style="width:40px"><col style="width:115px"><col style="width:200px"><col style="width:130px"><col style="width:115px"><col></colgroup><thead><tr><th>#</th><th>التاريخ</th><th>العامل</th><th>المهنة</th><th>المبلغ</th><th>ملاحظة</th></tr></thead>`,
    rows:r.advances.map((a,i)=>`<tr><td>${i+1}</td><td>${esc(a.date)}</td><td class="nm">${esc(a.name)}</td><td>${esc(a.profession)}</td><td style="font-weight:800;">${fmt(a.amount)}</td><td class="note">${esc(a.note||'')}</td></tr>`),
    total:r.advances.length ? `<tr class="tot"><td></td><td></td><td>إجمالي السلف</td><td></td><td>${fmt(t.totalAdvanceRows || r.advances.reduce((s,a)=>s+a.amount,0))}</td><td></td></tr>` : '',
    empty:'لا توجد سلف في هذه الفترة' });

  // توزيع الأقسام على الصفحات: الصفحة الأولى تبدأ بالبطاقات (تشغل ~8 وحدات)
  const pages = [{ html: cards, used: 8 }];
  const newPage = ()=>{ pages.push({ html:'', used:0 }); return pages[pages.length-1]; };
  sections.forEach(s=>{
    let page = pages[pages.length-1];
    // جدول فارغ (مثل كشف السلف بلا سلف): رأس الجدول كما هو والرسالة سطر تحته — لا خلية ممتدة داخل الجدول
    // (خلية colspan في جدول ثابت الأعمدة كانت تكسر رأس الجدول أو تنحشر في العمود الأول)
    if(!s.rows.length){
      const lead = 2 + 1 + (s.extra ? 1 : 0) + (s.extraLead || 0);
      if(s.breakBefore && page.used > 0 || page.used + lead + 1 > RPT_CAP) page = newPage();
      // صف خفي بارتفاع صفر بعدد الأعمدة: بدونه لا يوزّع المتصفح عرض الأعمدة فينكسر رأس الجدول
      const cols = (s.head.match(/<th[\s>]/g) || []).length || 1;
      page.html += (page.used ? '<div class="rpt-gap"></div>' : '') + `<div class="rpt-sec">${esc(s.title)}</div>${s.extra || ''}` +
        `<div class="rpt-tw"><table class="rpt-tbl ${s.cls||''}">${s.head}<tbody><tr class="rpt-zero">${'<td></td>'.repeat(cols)}</tr></tbody></table><div class="rpt-empty">${esc(s.empty)}</div></div>`;
      page.used += lead + 1;
      return;
    }
    const rows = s.rows;
    const lead = 2 + 1 + (s.extra ? 1 : 0) + (s.extraLead || 0); // عنوان + رأس جدول (+ مفتاح الرموز + رأس بسطرين)
    if(s.breakBefore && page.used > 0 || page.used + lead + Math.min(rows.length, 3) > RPT_CAP) page = newPage();
    let i = 0, cont = false;
    while(i < rows.length){
      if(page.used + lead + 1 > RPT_CAP) page = newPage();
      const room = RPT_CAP - page.used - lead;
      const part = rows.slice(i, i + room);
      i += part.length;
      const last = i >= rows.length;
      const withTotal = last && s.total && page.used + lead + part.length + 1 <= RPT_CAP;
      page.html += (page.used ? '<div class="rpt-gap"></div>' : '') +
        `<div class="rpt-sec">${esc(s.title)}${cont ? ' (تابع)' : ''}</div>${s.extra || ''}` +
        `<div class="rpt-tw"><table class="rpt-tbl ${s.cls||''}">${s.head}<tbody>${part.join('')}${withTotal ? s.total : ''}</tbody></table></div>`;
      page.used += lead + part.length + (withTotal ? 1 : 0);
      if(last && s.total && !withTotal){ // سطر الإجمالي وحده في صفحة جديدة
        page = newPage();
        page.html += `<div class="rpt-sec">${esc(s.title)} (تابع)</div><div class="rpt-tw"><table class="rpt-tbl ${s.cls||''}">${s.head}<tbody>${s.total}</tbody></table></div>`;
        page.used += lead + 1;
      }
      cont = true;
    }
  });
  // الملاحظات + التحقق + التوقيعات والختم في آخر صفحة
  const stamp = r.final
    ? `<div class="rpt-stamp"><div class="s1">${esc(COMPANY_AR)}</div><div class="s2">معتمد إلكترونيًا</div><div class="s2">عبر تطبيق ${esc(APP_SHORT)}</div><div class="s3">${esc(createdAt.slice(0,10))}</div></div>`
    : `<div class="rpt-stamp drf"><div class="s1">مسودة</div><div class="s2">غير معتمد</div><div class="s2">للمراجعة فقط</div><div class="s3">${esc(createdAt.slice(0,10))}</div></div>`;
  const closing = `${notes}
    ${signed
      ? `<div class="rpt-verify${r._qr ? ' has-qr' : ''}">${r._qr ? `<img class="rpt-qr" src="${r._qr}" alt="">` : ''}<div>
      <span class="signed">✓ تقرير موقّع من الخادم</span> — أُنشئ آليًا بواسطة ${esc(APP_NAME)} من بيانات الحضور المسجلة ببصمة الوجه، بتاريخ <span class="ltr">${esc(createdAt)}</span>.
      <br>رمز التحقق: <span class="code">${code}</span> — لا يمكن حساب رمز صحيح لأرقام معدّلة.
      <br>للتأكد من صحته: امسح الرمز بكاميرا الهاتف، أو افتح رابط التحقق:
      <br><span class="vurl" dir="ltr">${esc(reportVerifyUrl(r))}</span></div></div>`
      : `<div class="rpt-verify">أُنشئ هذا التقرير آليًا بواسطة ${esc(APP_NAME)} بتاريخ <span class="ltr">${esc(createdAt)}</span>.
      <br>${r.final ? 'رمز المحتوى' : 'مسودة غير موقّعة — لا تُعتمد. رمز المحتوى'}: <span class="code">${code}</span></div>`}
    <div class="rpt-sign">
      <div class="box"><b>أعدّه (المحاسب)</b>الاسم: ............................ التوقيع: ....................</div>
      <div class="box"><b>اعتمده (المدير)</b>الاسم: ............................ التوقيع: ....................</div>
      ${stamp}
    </div>`;
  if(pages[pages.length-1].used + (signed ? 12 : 10) > RPT_CAP) newPage();
  pages[pages.length-1].html += '<div class="rpt-gap"></div>' + closing;

  const total = pages.length;
  const status = r.final ? '<span class="rpt-status fin">نهائي — معتمد</span>' : '<span class="rpt-status drf">معاينة — غير نهائي</span>';
  return pages.map((p, i)=>`<div class="rpt-page">
    ${r.final ? '' : '<div class="rpt-wm">مسودة</div>'}
    <div class="rpt-band">
      <div class="rpt-brand"><img src="${LOGO_SRC}" alt=""><div><div class="rpt-co">${esc(COMPANY_AR)}</div><div class="rpt-app">${esc(APP_NAME)}</div></div></div>
      <div class="rpt-doc"><div class="t">تقرير الدوام والرواتب الشهري</div><div class="m">${esc(r.monthLabel)}</div></div>
    </div>
    <div class="rpt-meta">
      <span>رقم التقرير: <b class="ltr">${esc(reportNo)}</b></span>
      <span>الفترة: <b class="ltr">${r.month}-01</b> إلى <b class="ltr">${r.month}-${String(n).padStart(2,'0')}</b></span>
      <span>${r.final ? 'تاريخ الإقفال' : 'تاريخ الإنشاء'}: <b class="ltr">${esc(createdAt)}</b></span>
      <span>الحالة: ${status}</span>
    </div>
    <div class="rpt-body">${p.html}</div>
    <div class="rpt-foot"><span>أُنشئ آليًا بواسطة ${esc(APP_NAME)} — ${esc(COMPANY_AR)}</span><span>${signed ? 'رمز التحقق' : 'رمز المحتوى'}: <span class="code">${code}</span></span><span>صفحة ${i+1} من ${total}</span></div>
  </div>`);
}

// رابط التحقق في ملف PDF: نص حقيقي غير مرئي فوق مكانه في صورة الصفحة (يُحدَّد ويُنسخ) + رابط قابل للضغط
function addVerifyLinkLayer(pdf, pageEl){
  const el = pageEl.querySelector('.vurl');
  if(!el) return;
  try{
    const url = el.textContent.trim(), pr = pageEl.getBoundingClientRect(), r = el.getBoundingClientRect();
    const k = 297 / pr.width; // بكسل → ملم
    const x = (r.left - pr.left) * k, y = (r.top - pr.top) * k, w = r.width * k, h = r.height * k;
    pdf.setFont('courier', 'normal'); pdf.setFontSize(10);
    const size = 10 * w / pdf.getTextWidth(url); // حجم الخط الذي يطابق عرض الرابط في الصورة
    pdf.setFontSize(size);
    pdf.text(url, x, y + h * 0.78, { renderingMode: 'invisible' });
    pdf.link(x, y, w, h, { url });
  }catch(e){ console.warn('رابط التحقق في PDF', e); }
}

function reportFileName(r){ return `تقرير-الدوام-${r.month}${r.final ? '' : '-معاينة'}.pdf`; }

// مكتبة الرسم تقسّم النص عند المسافات وترسم كل كلمة وحدها فتضيع مسافات العربية ويختل ترتيبها؛
// المسافة غير القابلة للكسر تُبقي كل نص قطعة واحدة (الجداول لا تلتف أصلًا، والفقرات مقسمة لأسطر قصيرة)
function keepTextTogether(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for(let node; (node = walker.nextNode()); ){
    const v = node.nodeValue;
    if(!/\S/.test(v)) continue; // المسافات بين الوسوم تبقى قابلة للطي، وإلا تصير أسطرًا وخلايا فارغة
    node.nodeValue = v.replace(/\s+/g, ' ').replace(/ /g, ' ');
  }
}

async function generateReportPdf(report){
  if(!report) throw new Error('لا توجد بيانات للتقرير');
  ensureReportCss();
  report._qr = await makeReportQr(report);
  const pagesHtml = buildReportPages(report);
  try{ await loadPdfLib(); }
  catch(e){ printReportFallback(pagesHtml, report); return; }

  // الحاوية في أعلى يسار الشاشة (لا خارجها، وإلا تُقص الصفحة) وشفافة؛ تُظهَر فقط داخل نسخة الرسم
  const host = document.createElement('div');
  host.id = 'rptHost';
  host.style.cssText = `position:fixed;top:0;left:0;width:${RPT_W}px;direction:ltr;opacity:0;pointer-events:none;z-index:-1;`;
  document.body.appendChild(host);
  setApiBusy(true);
  try{
    const els = pagesHtml.map(h=>{ const d = document.createElement('div'); d.innerHTML = h; const el = d.firstElementChild; host.appendChild(el); return el; });
    keepTextTogether(host);
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map(img => img.complete ? 0 : new Promise(r=>{ img.onload = img.onerror = r; })));
    // قفل الملف: يُفتح ويُطبع بلا كلمة مرور، والتعديل يتطلب كلمة مرور مالك عشوائية لا يعرفها أحد
    // (للتعديل الصحيح: يُصدَر التقرير من جديد من التطبيق). محتوى الصفحات صور، فالنص الوحيد القابل للنسخ
    // هو رابط التحقق (طبقة نص فوق مكانه في الصورة + رابط قابل للضغط)
    const ownerPassword = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('');
    const pdf = new window.jspdf.jsPDF({ unit:'mm', format:'a4', orientation:'landscape', compress:true,
      encryption:{ userPassword:'', ownerPassword, userPermissions:['print', 'copy'] } });
    pdf.setProperties({ title:`تقرير الدوام ${report.month}`, author: COMPANY_AR, creator: APP_NAME,
      subject: (reportSigned(report) ? 'رمز التحقق ' + report.signature : 'رمز المحتوى ' + reportFingerprint(report)) });
    for(let i=0; i<els.length; i++){
      const canvas = await window.html2canvas(els[i], {
        scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
        width: RPT_W, height: RPT_H, windowWidth: RPT_W, windowHeight: RPT_H, scrollX: 0, scrollY: 0,
        onclone: doc => { const h = doc.getElementById('rptHost'); if(h) h.style.opacity = '1'; }
      });
      if(i) pdf.addPage('a4', 'landscape');
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 297, 210);
      addVerifyLinkLayer(pdf, els[i]);
    }
    pdf.save(reportFileName(report));
    toast('تم إنشاء التقرير PDF');
  }catch(error){
    console.error('PDF error', error);
    printReportFallback(pagesHtml, report);
  }finally{
    host.remove();
    setApiBusy(false);
  }
}

// بديل احتياطي: نافذة طباعة جاهزة (اختر «حفظ كـ PDF»)
function printReportFallback(pagesHtml, report){
  const w = window.open('', '_blank');
  if(!w){ toast('تعذر إنشاء PDF — اسمح بالنوافذ المنبثقة ثم أعد المحاولة'); return; }
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(reportFileName(report))}</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
    <style>${REPORT_CSS} @page{size:A4 landscape;margin:0;} body{margin:0;background:#888;} .rpt-page{margin:0 auto;page-break-after:always;break-after:page;}
    @media screen{.rpt-page{margin:12px auto;box-shadow:0 4px 20px rgba(0,0,0,.3);}}</style></head>
    <body>${pagesHtml.join('')}<script>window.onload=function(){setTimeout(function(){window.print();},600);};<\/script><\/body><\/html>`);
  // (وسم إغلاق body مكتوب بـ <\/ عمدًا: خوادم التطوير مثل Live Server تحقن سكربتها قبل أول وسم إغلاق حرفي له فتكسر هذا السكربت)
  w.document.close();
  toast('اختر «حفظ كـ PDF» من نافذة الطباعة');
}

function renderAdminSummary(){
  if(!$id('matrixMonthSelect').value) populateMatrixMonths();
  const month = selectedMonth();
  renderMonthlyMatrix();
  renderProfessionSummary(month);
  renderMonthAdvances(month);
  renderArchiveList();
  renderAccountsTable();
}

function renderAccountsTable(){
  const q = searchQuery('accountSearch');
  const allLog = loadLog();
  const advances = loadAdvances();
  // النشطون + من ألغى حسابه وما زال له رصيد (حتى لا يختفي من الحسابات)
  const rows = loadWorkers().filter(w=>isActive(w) || w.status==='deleted')
    .map(w=>({ w, acc: computeAccount(w, allLog, advances) }))
    .filter(x=> isActive(x.w) || x.acc.earned || x.acc.advanced)
    .filter(x=> matches(q, x.w.name, x.w.profession));
  renderRows('accountsBody','accountsEmpty', rows, ({w, acc})=>`<tr>
      <td data-label="العامل">${escapeHtml(w.name)}${isActive(w) ? '' : ' <small style="color:var(--red);">(ملغى)</small>'}</td>
      <td data-label="المهنة">${escapeHtml(w.profession)}</td>
      <td data-label="المستحق">${fmt(acc.earned)}</td>
      <td data-label="السلف">${fmt(acc.advanced)}</td>
      <td data-label="الصافي" style="font-weight:800;color:${acc.net>=0?'var(--green)':'var(--red)'}">${fmt(acc.net)}</td>
      <td data-label="" class="td-actions">
        ${isActive(w) ? `<button class="btn btn-outline btn-sm" onclick="openAdvanceModal('${w.id}')">+ سلفة</button>` : ''}
        <button class="btn btn-green btn-sm" onclick="settleWorkerAccount('${w.id}')">تصفية الحساب</button>
      </td>
    </tr>`);
  const sum = f => money(rows.reduce((s,x)=> s + x.acc[f], 0));
  $id('accountsFoot').innerHTML = rows.length
    ? `<tr><td data-label="">الإجمالي</td><td></td><td data-label="المستحق">${fmt(sum('earned'))}</td><td data-label="السلف">${fmt(sum('advanced'))}</td><td data-label="الصافي">${fmt(sum('net'))}</td><td></td></tr>` : '';
}

let advanceWorkerId = null;

function openAdvanceModal(workerId){
  const worker = loadWorkers().find(w=>w.id===workerId);
  if(!worker) return;
  advanceWorkerId = workerId;
  $id('advanceWorkerLabel').textContent = 'للعامل: ' + worker.name;
  $id('advanceAmount').value = '';
  setModal('advanceModal', true);
}

function closeAdvanceModal(){
  setModal('advanceModal', false);
  advanceWorkerId = null;
}

async function submitAdvance(){
  const amount = money(parseFloat($id('advanceAmount').value));
  if(!amount || amount<=0){ toast('أدخل قيمة سلفة صحيحة'); return; }
  const worker = loadWorkers().find(w=>w.id===advanceWorkerId);
  if(!worker) return;

  closeAdvanceModal();
  adminAction('addAdvance', { workerId: worker.id, amount }, s=>{
    s.advances.push({ id:'tmp-'+uid(), workerId: worker.id, amount, note: '', date: todayStr(), timestamp: Date.now() });
  }, 'تم تسجيل السلفة');
}

async function settleWorkerAccount(workerId){
  const worker = loadWorkers().find(w=>w.id===workerId);
  if(!worker) return;
  const log = loadLog();
  const { earned, advanced, net } = computeAccount(worker, log, loadAdvances());

  const pending = countPending(worker, log);
  if(pending){ toast(`لدى العامل ${pending} طلب حضور معلّق — اعتمده أو ارفضه قبل التصفية`); return; }
  if(!earned && !advanced){ toast('لا يوجد رصيد لتصفيته'); return; }

  const negWarn = net < 0 ? `\n⚠ الصافي سالب: لن يُدفع شيء، وسيُرحَّل ${fmt(-net)} كسلفة على الفترة القادمة.` : '';
  if(!confirm(`تصفية حساب "${worker.name}"\nالمستحق: ${fmt(earned)}\nالسلف: ${fmt(advanced)}\nالصافي المطلوب دفعه: ${fmt(Math.max(net,0))}${negWarn}\n\nهل تريد تأكيد التصفية؟`)) return;

  try{ await apiCall('settleWorkerAccount', { token: getAdminToken(), workerId }); }
  catch(error){ toast(error.message); return; }
  toast('تمت تصفية الحساب');
  renderAdmin();
}

/* =========================================================================
   بدء التشغيل
   ========================================================================= */
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
let _adminVer = '', _adminFullAt = 0, _adminSeen = null, _adminRedrawPending = false;
let _workerVer = '', _workerFullAt = 0, _workerHash = '', _workerWv = '';

function visibleScreen(){
  return ['screen-admin','screen-worker','screen-pending','screen-device-pending']
    .find(id => !$id(id).classList.contains('hidden')) || '';
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
    const scr = visibleScreen();
    if(scr === 'screen-admin' && getAdminToken()) await syncAdmin();
    else if(scr === 'screen-worker' && currentPhone) await syncWorker();
    else if(scr === 'screen-pending') await refreshPendingStatus(true);
    else if(scr === 'screen-device-pending') await refreshDeviceStatus(true);
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
        if(visibleScreen() === 'screen-worker'){ _workerHash = ''; _workerVer = ''; _workerWv = ''; } // تحديث كامل عند الطلب
        if(visibleScreen() === 'screen-admin') _adminVer = '';
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

// ---------- الإدارة ----------
async function syncAdmin(){
  if(_adminOps || _closingMonth) return; // لا نتدخل أثناء عملية فورية أو تصفية
  // since: الخادم يرد بما تغيّر منذه فقط (أو «لم يتغير»)؛ نسخة كاملة كل ADMIN_FULL_MS للتصحيح الذاتي
  const since = Date.now() - _adminFullAt < ADMIN_FULL_MS ? _adminVer : '';
  let res;
  try{ res = await apiCall('getAdminData', { token: getAdminToken(), since, delta: 1 }, { silent:true }); }
  catch(error){ if(/غير مصرح/.test(error.message)){ adminSessionLost(); } return; }
  if(res.unchanged || _adminOps) return;
  if(!applyAdminData(res)){ // تغييرات على نسخة غير المحفوظة لدينا: نسخة كاملة فورًا
    try{ res = await apiCall('getAdminData', { token: getAdminToken() }, { silent:true }); }catch(e){ return; }
    if(_adminOps || !applyAdminData(res)) return;
  }
  redrawAdminSafely();
}
// لا نعيد رسم اللوحة والمدير يكتب (يومية/بحث) أو نافذة مفتوحة — وإلا يضيع ما كتبه؛ نرسم بعد انتهائه
function redrawAdminSafely(){
  const a = document.activeElement;
  const typing = a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && $id('screen-admin').contains(a);
  const modalOpen = ['advanceModal','archiveViewModal'].some(id => { const m = $id(id); return m && !m.classList.contains('hidden'); });
  if(typing || modalOpen){ _adminRedrawPending = true; return; }
  _adminRedrawPending = false;
  drawAdmin();
}
document.addEventListener('focusout', ()=> setTimeout(()=>{ if(_adminRedrawPending && visibleScreen() === 'screen-admin') redrawAdminSafely(); }, 300));

// طلبات جديدة للإدارة: تُقارن بما شوهد سابقًا (أول تحميل يُسجَّل فقط، دون إشعار)
function adminNews(d){
  const pendW = (d.workers||[]).filter(w => w.status === 'pending');
  const pendL = (d.log||[]).filter(r => r.status === 'pending');
  const pendD = d.pendingDevices || [];
  const seen = _adminSeen;
  _adminSeen = { w:new Set(pendW.map(x=>x.id)), l:new Set(pendL.map(x=>x.id)), d:new Set(pendD.map(x=>x.id)) };
  if(!seen) return;
  const nw = pendW.filter(x => !seen.w.has(x.id)), nl = pendL.filter(x => !seen.l.has(x.id)), nd = pendD.filter(x => !seen.d.has(x.id));
  if(nw.length) notifyUser('طلب تسجيل جديد', nw.length === 1 ? `${nw[0].name} (${nw[0].profession}) بانتظار القبول` : `${nw.length} عمال جدد بانتظار القبول`, 'adm-workers');
  if(nl.length) notifyUser('طلب حضور جديد', nl.length === 1 ? `${nl[0].workerName} سجّل حضوره الساعة ${nl[0].time}` : `${nl.length} طلبات حضور جديدة بانتظار الاعتماد`, 'adm-log');
  if(nd.length) notifyUser('طلب جهاز جديد', nd.length === 1 ? `${nd[0].workerName || nd[0].phone} يحاول الدخول من جهاز جديد` : `${nd.length} طلبات أجهزة جديدة`, 'adm-devices');
}

// ---------- العامل ----------
async function syncWorker(){
  const faceOpen = !$id('faceModal').classList.contains('hidden');
  if(_checkinBusy || faceOpen) return; // لا نقاطع تسجيل الحضور
  const since = Date.now() - _workerFullAt < FULL_REFRESH_MS ? _workerVer : '';
  let res;
  // wv: إصدار بيانات حسابي — إن تغيّرت بيانات غيري فقط يرد الخادم «لم يتغير» دون قراءة الشيت أصلًا؛
  // hash: بصمة آخر بيانات وصلتني — إن قُرئت ولم يتغير فيها شيء يخصني لا تُرسل من جديد.
  // التحقق الكامل الدوري (since فارغ) يتجاوز wv أيضًا: يلتقط تعديلات الشيت التي لا تمر بالخادم
  const wid = currentWorker ? currentWorker.id : '';
  try{ res = await apiCall('getWorkerData', workerAuth({ since, hash: _workerHash, wid, wv: since ? _workerWv : '' }), { silent:true }); }
  catch(error){
    if(isLockedError(error)){ lockApp(); return; } // انتهت جلسة القفل (مثلًا بعد 6 ساعات بلا استخدام)
    // "الجلسة غير صالحة" قد تكون خطأً عابرًا من Google: نتأكد من حالة الجهاز أولًا ولا نغيّر الشاشة إلا إن تغيرت فعلًا
    if(!/الجلسة غير صالحة/.test(error.message)) return;
    let st;
    try{ st = await apiCall('refreshDeviceStatus', workerAuth(), { silent:true }); }catch(e){ return; }
    if(st.deviceStatus === 'approved') return;
    if(st.deviceStatus === 'deleted'){ toast('لم يعد هذا الحساب موجودًا'); logout(); return; }
    _lastDeviceStatus = st.deviceStatus; setDevicePendingText(st.deviceStatus); showScreen('screen-device-pending');
    return;
  }
  if(res.unchanged){ // تغيّرت بيانات غيري فقط
    if(res.version) _workerVer = res.version;
    if(res.wv) _workerWv = res.wv;
    return;
  }
  renderWorkerStats(); // يستخدم البيانات التي وصلت للتو (_workerPrefetch)
}

// تغييرات تخص العامل منذ آخر مرة رآها (محفوظة على جهازه، فتصله أيضًا التغييرات التي حدثت والتطبيق مغلق)
const SEEN_KEY = 'hudurak_seen_';
function workerNews(worker, log, advances){
  let old = null;
  try{ old = JSON.parse(localStorage.getItem(SEEN_KEY + worker.id) || 'null'); }catch(e){}
  const recent = [...(log||[])].sort((a,b)=> b.timestamp - a.timestamp).slice(0, 60);
  const snap = { st: worker.status, w: worker.wage, ls: worker.lastSettledAt,
    l: Object.fromEntries(recent.map(r => [r.id, r.status])), a: (advances||[]).map(a => a.id) };
  try{ localStorage.setItem(SEEN_KEY + worker.id, JSON.stringify(snap)); }catch(e){}
  if(!old) return;
  if(old.st === 'pending' && worker.status === 'active')
    notifyUser('تم قبول حسابك 🎉', `وافقت الإدارة على تسجيلك بيومية ${fmt(worker.wage)}. يمكنك الآن تسجيل الحضور`, 'account');
  else if(old.st === 'active' && old.w && worker.wage !== old.w)
    notifyUser('تعديل اليومية', `أصبحت يوميتك ${fmt(worker.wage)}`, 'wage');
  const decided = recent.filter(r => old.l && old.l[r.id] === 'pending' && r.status !== 'pending');
  const ok = decided.filter(r => r.status === 'approved'), no = decided.filter(r => r.status === 'rejected');
  if(ok.length) notifyUser('تم اعتماد حضورك ✓', ok.length === 1 ? `اعتمدت الإدارة حضورك ليوم ${ok[0].date}` : `اعتمدت الإدارة ${ok.length} أيام من حضورك`, 'att-ok');
  if(no.length) notifyUser('تم رفض حضور', no.length === 1 ? `رفضت الإدارة حضورك ليوم ${no[0].date}` : `رفضت الإدارة ${no.length} أيام من حضورك`, 'att-no');
  // الرصيد السالب المرحّل من التصفية ليس "سلفة جديدة" (نافذة التصفية تشرحه)
  const newAdv = (advances||[]).filter(a => old.a && !old.a.includes(a.id) && !/^رصيد سالب مرحّل/.test(a.note || ''));
  if(newAdv.length) notifyUser('سلفة جديدة', newAdv.length === 1 ? `سُجّلت عليك سلفة بمبلغ ${fmt(newAdv[0].amount)}` + (newAdv[0].note ? ' — ' + newAdv[0].note : '') : `سُجّلت عليك ${newAdv.length} سلف جديدة`, 'adv');
  // (التصفية لها نافذة تفاصيل خاصة تبقى حتى يضغط "تم" — showSettlement — وتُحفظ في الإشعارات من هناك)
}

/* =========================================================================
   مركز إشعارات العامل: كل إشعار يخصه يُحفظ على هاتفه (لا في الشيت) مع نوعه وتاريخه،
   ويستطيع قراءته أو حذفه أو تحديد الكل كمقروء. يُملأ من نفس مصدر الإشعارات (تغيّرات حسابه).
   ========================================================================= */
const INBOX_MAX = 100;
const INBOX_TYPES = {
  account: { icon:'🎉', label:'الحساب',       cls:'acct' },
  device:  { icon:'📱', label:'الجهاز',       cls:'acct' },
  'att-ok':{ icon:'✓',  label:'حضور معتمد',   cls:'ok' },
  'att-no':{ icon:'✗',  label:'حضور مرفوض',   cls:'no' },
  adv:     { icon:'💵', label:'سلفة',         cls:'money' },
  settle:  { icon:'🧾', label:'تصفية الحساب', cls:'money' },
  wage:    { icon:'💰', label:'اليومية',      cls:'money' },
  info:    { icon:'ℹ️', label:'تنبيه',        cls:'' }
};
let _inboxFilter = 'all';
const inboxKey = () => currentPhone ? 'hudurak_inbox_' + phoneKeyOf(currentPhone) : '';
function inboxLoad(){ try{ const k = inboxKey(); return k ? JSON.parse(localStorage.getItem(k) || '[]') : []; }catch(e){ return []; } }
function inboxSave(list){ try{ const k = inboxKey(); if(k) localStorage.setItem(k, JSON.stringify(list.slice(0, INBOX_MAX))); }catch(e){} updateInboxBadge(); }
// ref: معرّف الحدث (مثل رقم التصفية) — نفس الحدث لا يُحفظ مرتين
function inboxAdd(type, title, body, ref){
  if(!inboxKey()) return;
  const list = inboxLoad();
  if(ref && list.some(n => n.ref === ref)) return;
  list.unshift({ id: uid(), type: INBOX_TYPES[type] ? type : 'info', title, body, at: Date.now(), read: false, ref: ref || '' });
  inboxSave(list);
  if(!$id('inboxModal').classList.contains('hidden')) renderInbox();
}
function updateInboxBadge(){
  const n = inboxLoad().filter(x => !x.read).length;
  const b = $id('inboxBadge');
  if(b){ b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); }
  const u = $id('inboxUnreadN'); if(u) u.textContent = n ? '(' + n + ')' : '';
}
// "اليوم 14:05" / "أمس 09:10" / "2026-09-28 14:05" بتوقيت الرياض
function inboxTime(ts){
  const p = riyadhParts(new Date(ts)), day = `${p.year}-${p.month}-${p.day}`, hm = `${p.hour}:${p.minute}`;
  const y = riyadhParts(new Date(Date.now() - 864e5)), yday = `${y.year}-${y.month}-${y.day}`;
  return { day: day === todayStr() ? 'اليوم' : day === yday ? 'أمس' : day, time: hm };
}
function renderInbox(){
  const all = inboxLoad(), list = _inboxFilter === 'unread' ? all.filter(n => !n.read) : all;
  const box = $id('inboxList');
  document.querySelectorAll('.inbox-tabs button').forEach(b => b.classList.toggle('on', b.dataset.f === _inboxFilter));
  if(!list.length){
    box.innerHTML = `<div class="inbox-empty">${_inboxFilter === 'unread' ? 'لا توجد إشعارات غير مقروءة ✓' : 'لا توجد إشعارات بعد.<br>ستظهر هنا موافقات الإدارة، الحضور، السلف، والتصفية.'}</div>`;
    return;
  }
  let lastDay = '';
  box.innerHTML = list.map(n => {
    const t = INBOX_TYPES[n.type] || INBOX_TYPES.info, when = inboxTime(n.at);
    const head = when.day !== lastDay ? `<div class="inbox-day">${escapeHtml(when.day)}</div>` : '';
    lastDay = when.day;
    return head + `<div class="inbox-item${n.read ? '' : ' unread'}" onclick="inboxRead('${n.id}')">
      <div class="inbox-ico ${t.cls}">${t.icon}</div>
      <div class="inbox-body"><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p>
        <div class="inbox-meta"><span class="inbox-type">${t.label}</span><span dir="ltr">${escapeHtml(when.time)}</span></div></div>
      <button class="inbox-del" onclick="event.stopPropagation();inboxDelete('${n.id}')" aria-label="حذف الإشعار" title="حذف">✕</button>
    </div>`;
  }).join('');
}
function openInbox(){ _inboxFilter = 'all'; renderInbox(); updateInboxBadge(); setModal('inboxModal', true); }
function closeInbox(){ setModal('inboxModal', false); }
function setInboxFilter(f){ _inboxFilter = f; renderInbox(); }
function inboxRead(id){ const l = inboxLoad(); const n = l.find(x => x.id === id); if(n && !n.read){ n.read = true; inboxSave(l); renderInbox(); } }
function inboxDelete(id){ inboxSave(inboxLoad().filter(x => x.id !== id)); renderInbox(); }
function inboxMarkAllRead(){ const l = inboxLoad(); if(!l.some(n => !n.read)) return toast('كل الإشعارات مقروءة'); l.forEach(n => n.read = true); inboxSave(l); renderInbox(); }
function inboxClear(){
  if(!inboxLoad().length) return toast('لا توجد إشعارات');
  if(!confirm('حذف كل الإشعارات؟')) return;
  inboxSave([]); renderInbox();
}

// ---------- إشعارات النظام ----------
function notifyUser(title, body, tag){
  const foreground = document.visibilityState === 'visible' && document.hasFocus();
  if(tag && !/^adm/.test(tag)) inboxAdd(tag, title, body); // إشعارات العامل تُحفظ في مركز الإشعارات
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
// شريط "فعّل الإشعارات": يظهر مرة واحدة فقط. بعد الضغط على "تفعيل" أو "×" لا يعود أبدًا على هذا الجهاز
// (كان يعود كل 3 ثوانٍ إن رُفض الطلب أو أُغلق دون قرار، لأن حالة الإذن تبقى "default").
const NOTIF_ASKED = 'hudurak_notif_asked';
function notifAsked(){ try{ return localStorage.getItem(NOTIF_ASKED) === '1'; }catch(e){ return false; } }
function updateNotifBar(){
  let bar = $id('notifBar');
  const show = 'Notification' in window && Notification.permission === 'default' && !notifAsked()
    && ['screen-admin','screen-worker','screen-pending'].includes(visibleScreen());
  if(!show){ if(bar) bar.remove(); return; }
  if(bar) return;
  bar = document.createElement('div'); bar.id = 'notifBar';
  bar.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 76px);left:50%;transform:translateX(-50%);z-index:150;background:#14213b;color:#fff;border:2px solid #e7a33e;border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:14px;max-width:calc(100% - 24px);';
  bar.innerHTML = '<span>🔔 فعّل الإشعارات لتصلك الموافقات حتى والتطبيق مغلق</span><button class="btn btn-amber btn-sm" id="notifYes">تفعيل</button><button class="btn btn-ghost btn-sm" id="notifNo" style="color:#fff;">×</button>';
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
  [['notifStatus','notifBtn'], ['admNotifStatus','admNotifBtn']].forEach(([s, b]) => {
    const st = $id(s), btn = $id(b);
    if(!st) return;
    st.textContent = text; st.classList.toggle('on', perm === 'granted');
    btn.classList.toggle('hidden', !supported || perm !== 'default');
  });
}
async function enableNotifications(){
  try{ localStorage.setItem(NOTIF_ASKED, '1'); }catch(e){} // لا يعود الشريط العلوي بعد ذلك
  const bar = $id('notifBar'); if(bar) bar.remove();
  let p = 'default';
  try{ p = await Notification.requestPermission(); }catch(e){}
  if(p === 'granted'){ toast('تم تفعيل الإشعارات ✓'); pushSubscribe(true); }
  else if(p === 'denied') toast('رُفض الإذن — يمكنك السماح بالإشعارات من إعدادات الهاتف');
  else toast('لم يتم تفعيل الإشعارات');
  renderNotifRows();
}

/* ---------- إشعارات تصل والتطبيق مغلق (Web Push) ----------
   الهاتف يشترك لدى خدمة الإشعارات الخاصة به (Google/Apple) بمفتاح الخادم العام، ويُرسل عنوان الاشتراك للخادم.
   عند أي حدث يرسل الخادم تنبيهًا فارغًا؛ فيستيقظ sw.js ويجلب النص ويعرضه — ولو كان التطبيق مغلقًا. */
let _pushActive = false, _pushOwnerDone = '', _pushFailAt = 0;
const b64ToBytes = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
function pushIdentity(){
  if(ADMIN_MODE){ const token = getAdminToken(); return token && visibleScreen() === 'screen-admin' ? { token } : null; }
  if(currentPhone) return { phone: currentPhone, deviceId: getDeviceId() };
  return null;
}
async function pushSubscribe(force){
  try{
    if(!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || Notification.permission !== 'granted') return;
    const id = pushIdentity(); if(!id) return;
    const owner = id.token ? 'admin' : 'w:' + id.phone;
    if(!force && _pushOwnerDone === owner) return;
    if(!force && Date.now() - _pushFailAt < 5 * 60000) return; // فشل مؤخرًا: لا نكرر كل 4 ثوانٍ
    const reg = await navigator.serviceWorker.ready;
    const { key } = await apiCall('getPushKey', {}, { silent:true });
    let sub = await reg.pushManager.getSubscription();
    // اشتراك قديم بمفتاح مختلف (أُعيد توليد المفاتيح في الخادم): يُستبدل
    if(sub && sub.options && sub.options.applicationServerKey){
      const old = new Uint8Array(sub.options.applicationServerKey), cur = b64ToBytes(key);
      if(old.length !== cur.length || old.some((b, i) => b !== cur[i])){ await sub.unsubscribe(); sub = null; }
    }
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await apiCall('savePush', Object.assign({ endpoint: sub.endpoint }, id), { silent:true });
    // هوية المستخدم لـ sw.js (ليجلب نصوص الإشعارات من الخادم والتطبيق مغلق)
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type:'identity', data: Object.assign({ url: WEB_APP_URL, apiKey: SHEET_API_KEY }, id) });
    _pushActive = true; _pushOwnerDone = owner;
  }catch(e){ _pushFailAt = Date.now(); console.warn('تعذر الاشتراك في الإشعارات', e); }
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
// quiet: الشاشة معروضة أصلًا من النسخة المحلية؛ التحقق يجري في الخلفية بلا شاشة "جاري الاتصال"
async function resumeWorkerSession(phone, quiet){
  currentPhone = phone;
  for(let attempt = 0; ; attempt++){
    let res;
    try{ res = await apiCall('checkPhone', { phone, deviceId: getDeviceId(), userAgent: navigator.userAgent, device: await deviceInfo(), session: getWorkerSession() }, { silent: !!quiet }); }
    catch(error){
      if(currentPhone !== phone) return; // خرج المستخدم أثناء المحاولات
      if(!quiet) bootMessage(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت — سيتم الدخول تلقائيًا فور عودة الاتصال...' : 'جاري الاتصال بالخادم...');
      await sleep(Math.min(3000 * (attempt + 1), 15000));
      continue;
    }
    bootMessage('');
    if(currentPhone !== phone) return;
    if(!res.exists){ forgetFace(); outboxSave([]); clearRememberedPhone(); clearLocalCaches(CACHE_W); currentPhone = null; showScreen('screen-landing'); toast('لم يعد هذا الحساب موجودًا'); return; }
    if(!res.deviceOk){ _lastDeviceStatus = res.deviceStatus; setDevicePendingText(res.deviceStatus, res.switchFrom); showScreen('screen-device-pending'); return; }
    handleWorkerResponse(res); // نفس الشاشة غالبًا: تتحدث البيانات فقط دون وميض (أو شاشة القفل)
    return;
  }
}

/* ---------- فتح فوري من نسخة محلية ----------
   آخر بيانات وصلت من الخادم تُحفظ على الجهاز، فيفتح التطبيق مباشرة على شاشة المستخدم بدل شاشة الدخول
   (كانت تظهر ثانيتين إلى أربع حتى يرد Google، فيبدو كأنه "خرج ثم دخل"). الخادم يبقى هو المرجع:
   يُتحقق فورًا في الخلفية، وأي عملية (حضور/اعتماد) تمر عليه كما هي. بصمة الوجه لا تُحفظ إطلاقًا. */
const CACHE_W = 'hudurak_cache_worker', CACHE_A = 'hudurak_cache_admin';
// المساحة ممتلئة: تُحذف النسخة القديمة (فتحٌ ببيانات قديمة أسوأ من فتحٍ ينتظر الخادم)
function saveLocalCache(key, obj){
  try{ localStorage.setItem(key, JSON.stringify(obj)); }
  catch(e){ try{ localStorage.removeItem(key); }catch(e2){} }
}
function readLocalCache(key){ try{ return JSON.parse(localStorage.getItem(key) || 'null'); }catch(e){ return null; } }
function clearLocalCaches(only){ try{ (only ? [only] : [CACHE_W, CACHE_A]).forEach(k => localStorage.removeItem(k)); }catch(e){} }

// الخادم مستيقظ؟ (نداء خفيف؛ لا يمنع الفتح إن تأخر Google — مهلة قصيرة)
function pingServer(ms){
  return Promise.race([ fetch(WEB_APP_URL, { mode:'no-cors' }).then(()=>true, ()=>false), sleep(ms).then(()=>false) ]);
}

// أول فتح بلا حساب: لا تظهر صفحة الدخول إلا بعد تجهيز كل شيء (التسجيل يحتاج الكاميرا والتعرف على الوجه فورًا)
async function prepareFirstOpen(){
  Splash.set(8, 'جاري تجهيز التطبيق...');
  ensureFaceModels();
  const server = pingServer(10000);
  const faceOk = await Promise.race([faceReady, sleep(60000).then(()=>false)]);
  Splash.set(95, 'جاري الاتصال بالخادم...');
  const serverOk = await server;
  if(faceOk && (serverOk || navigator.onLine !== false)){ Splash.hide(); return; }
  Splash.error(navigator.onLine === false || !serverOk
    ? 'لا يوجد اتصال بالإنترنت. اتصل بالإنترنت ثم اضغط «إعادة المحاولة».'
    : 'تعذر تجهيز نظام التعرف على الوجه. تحقق من الاتصال ثم أعد المحاولة.');
}

async function init(){
  $id('spVer').textContent = 'v' + APP_VERSION;
  warmUpServer();
  renderNetBar(); // عمليات محفوظة لم تُرسل من فتح سابق
  // تخزين دائم: يطلب من المتصفح ألا يمسح بيانات التطبيق (معرّف الجهاز المربوط، النسخة المحلية، الجلسة)
  // عند امتلاء مساحة الهاتف — وإلا قد «يخرج» المستخدم فجأة ويُطلب اعتماد جهازه من جديد
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(()=>{}); }catch(e){}
  // تطبيق الإدارة من المتصفح وغير مثبّت: شاشة التثبيت أولًا — لا دخول ولا لوحة قبل التثبيت
  if(ADMIN_MODE && window.InstallGate && InstallGate.required()){ Splash.hide(); InstallGate.show(); return; }
  // تطبيق الإدارة المثبّت (admin.html) — بلا نماذج وجه. جلسة الإدارة تخصه وحده (تطبيق العمال لا يفتح لوحة الإدارة أبدًا):
  // جهاز مسجّل = شاشة القفل ونافذة البصمة تلقائيًا (مثل تطبيق العمال)، وإلا نموذج الدخول
  const handoff = takeUpdateHandoff(); // بعد «تحديث» من داخل التطبيق: يبقى داخل حسابه
  const updated = () => { if(handoff && handoff.v !== APP_VERSION) toast('تم التحديث إلى الإصدار ' + APP_VERSION + ' ✓'); };
  if(ADMIN_MODE && handoff && handoff.admin){
    setAdminToken(handoff.admin); updateAdminExit();
    const cached = readLocalCache(CACHE_A);
    if(cached) applyAdminData(cached);
    showScreen('screen-admin'); drawAdmin(); Splash.hide(); updated();
    renderAdmin(); // تحديث البيانات (وإن انتهت الجلسة: شاشة القفل)
    return;
  }
  if(!ADMIN_MODE && handoff && handoff.ws) setWorkerSession(handoff.ws);
  if(ADMIN_MODE){
    updateAdminExit();
    // الفتح بقفل الهاتف مفعّل: شاشة القفل ونافذة البصمة تلقائيًا (لا جلسة محفوظة على الجهاز)
    if(adminLockOn()){ try{ localStorage.removeItem(ADMIN_TOKEN_KEY); }catch(e){} showAdminLock(true); Splash.hide(); return; }
    // غير مفعّل: الجلسة المحفوظة على الجهاز → اللوحة مباشرة (من النسخة المحلية فورًا، ثم تتحدّث)
    let saved = null; try{ saved = localStorage.getItem(ADMIN_TOKEN_KEY); }catch(e){}
    if(saved){
      setAdminToken(saved);
      const cached = readLocalCache(CACHE_A);
      if(cached){ applyAdminData(cached); showScreen('screen-admin'); drawAdmin(); Splash.hide(); renderAdmin().then(() => setTimeout(offerAdminLock, 1200)); }
      else{
        Splash.set(40, 'جاري تحميل بيانات الإدارة...');
        try{ await refreshAdminData(); }catch(e){} // الجلسة مرفوضة: تنتقل هي لشاشة الدخول
        if(getAdminToken()){ showScreen('screen-admin'); drawAdmin(); setTimeout(offerAdminLock, 1200); }
        Splash.hide();
      }
      return;
    }
    showScreen('screen-admin-login'); Splash.hide();
    return;
  }
  // العامل في متصفح الهاتف والتطبيق غير مثبّت: نافذة التثبيت الكبيرة بدل أي صفحة حتى يثبّته.
  // نماذج الوجه تُحمَّل في الخلفية وتُحفظ على الجهاز، فيفتح التطبيق المثبّت بسرعة.
  if(window.InstallGate && InstallGate.required()){ ensureFaceModels(); Splash.hide(); InstallGate.show(); return; }
  const phone = getRememberedPhone();
  if(!phone){ await prepareFirstOpen(); return; }
  const cached = readLocalCache(CACHE_W);
  if(cached && cached.phone === phone && cached.worker && cached.passkey && !getWorkerSession()){
    // جهاز مقفل: شاشة القفل فورًا (بلا أي بيانات)، ونافذة بصمة الهاتف تظهر تلقائيًا
    currentPhone = phone; currentWorker = cached.worker;
    showLockScreen(cached.worker, true);
  }else if(cached && cached.phone === phone && cached.worker){
    currentPhone = phone;
    _hasPasskey = !!cached.passkey;
    _workerPrefetch = { worker: cached.worker, log: cached.log || [], advances: cached.advances || [], at: Date.now() };
    enterWorkerArea(cached.worker);
    updated();
    resumeWorkerSession(phone, true);
  }else{
    bootMessage('جاري الدخول...'); // لا نسخة محلية بعد (أول فتح بعد التحديث): شاشة انتظار بدل شاشة الدخول
    await resumeWorkerSession(phone);
  }
}
// يبدأ بعد تحميل كل سكربتات الصفحة (بوابة التثبيت معرّفة في السكربت التالي)
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true }); else init();
