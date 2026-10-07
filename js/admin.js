/* =========================================================================
   تطبيق الإدارة (admin.html) — يُحمَّل بعد core.js: الدخول وقفل الهاتف، الأمان، اللوحة (العمال، الحضور،
   الأجهزة)، الملخص والتصفية وتقرير PDF. «الخطافات» التي يستدعيها core.js في آخر الملف.
   ========================================================================= */
let _adminFresh = false;     // بيانات الإدارة وصلت مرفقة مع آخر عملية — لا حاجة لجلبها مجددًا

/* =========================================================================
   بيانات لوحة الإدارة في الذاكرة (تُملأ من الخادم أو من النسخة المحلية، وتُستخدم للعرض فقط)
   historyFrom: السجلات تصل لنافذة الأشهر الأخيرة (+ كل ما لم يُصفَّ)؛ الأقدم في الأرشيف
   ========================================================================= */
let STATE = { workers:[], log:[], advances:[], archives:[], pendingDevices:[], messages:[], historyFrom:'' };
function loadWorkers(){ return STATE.workers; }
function loadLog(){ return STATE.log; }
function loadAdvances(){ return STATE.advances; }
function loadArchives(){ return STATE.archives; }
// تاريخ/وقت بتوقيت الرياض: منسّق واحد يُنشأ مرة (إنشاؤه مكلف، وكان يُنشأ في كل نداء)

/* =========================================================================
   لوحة الإدارة
   ========================================================================= */
/* ---------- دخول الإدارة: صفحة مخفية (admin.html) + حساب أساسي دائم ----------
   create: أول مرة — كلمة المرور الحالية (ADMIN_PASSWORD) ثم اسم مستخدم وكلمة مرور جديدة
   login : اسم المستخدم وكلمة المرور (وبعد resetAdminAccess: المؤقتة + كلمة مرور جديدة)
   بصمة الجهاز لا تُطلب عند الدخول: هي «الفتح بقفل الهاتف» الاختياري، ويُفعَّل من داخل اللوحة (🔐 الأمان). */
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
  btn.disabled = true; btn.classList.add('is-busy'); showAdminLoginError('');
  try{
    const data = { user: $id('adminUser').value.trim(), password: $id('adminPass').value, deviceId: getDeviceId(), ua: deviceLabel(),
      since: (readLocalCache(CACHE_A) || {}).version || '', delta: 1 };
    data.trust = adminTrustFor(data.user); // جهاز دخل منه المدير سابقًا: لا يُغلق دخوله بمحاولات خاطئة من غيره
    if(_alMode !== 'create' && !data.user){ fieldError('adminUser'); throw new Error('أدخل اسم المستخدم'); }
    if(!data.password){ fieldError('adminPass'); throw new Error('أدخل كلمة المرور'); }
    if(!$id('alNewRows').classList.contains('hidden')){
      if($id('adminNewPass').value !== $id('adminNewPass2').value){ fieldError('adminNewPass2'); throw new Error('كلمتا المرور الجديدتان غير متطابقتين'); }
      data.newPassword = $id('adminNewPass').value;
      if(_alMode === 'create') data.newUser = $id('adminNewUser').value.trim();
    }
    finishAdminLogin(await apiCall('adminLogin', data));
  }catch(e){
    showAdminLoginError((e && e.message) || 'تعذر الدخول');
    if(/انتهت|غير موجود|أُنشئ/.test((e && e.message) || '')) prepareAdminLogin();
  }finally{ btn.disabled = false; btn.classList.remove('is-busy'); }
}
// «جهاز موثوق» للإدارة: رمز موقّع من الخادم بعد دخول ناجح باسم المستخدم (ليس جلسة، ويبقى بعد الخروج)
const ADMIN_TRUST_KEY = 'hudurak_admin_trust';
function adminTrustFor(user){
  try{ const t = JSON.parse(localStorage.getItem(ADMIN_TRUST_KEY) || 'null'); return t && t.u === String(user || '').toLowerCase() ? t.t : ''; }catch(e){ return ''; }
}
async function finishAdminLogin(res, quiet){
  if(res.trust && res.user) try{ localStorage.setItem(ADMIN_TRUST_KEY, JSON.stringify({ u: String(res.user).toLowerCase(), t: res.trust })); }catch(e){}
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
function updateAdminExit(){ const b = $id('adminExitBtn'); if(b){ const l = adminLockOn() ? 'قفل اللوحة' : 'تسجيل الخروج'; b.innerHTML = icon(adminLockOn() ? 'lock' : 'log-out'); b.title = l; b.setAttribute('aria-label', l); } }
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
  if(_lockOpts && Date.now() - _lockOptsAt < (_lockOpts.local ? LOCAL_OPTS_MS : 4 * 60000)) return _lockOpts; // تحدي الإدارة صالح 5 دقائق
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
    // بلا اتصال: فتح بالبصمة على الهاتف نفسه لعرض آخر بيانات محفوظة (الخادم يتحقق عند عودة الاتصال)
    const c = readLocalCache(CACHE_A);
    if(e.net && d0.id && c && c.workers && !$id('screen-lock').classList.contains('hidden')){
      $id('lockHint').textContent = 'لا يوجد اتصال — افتح ببصمتك لعرض آخر بيانات محفوظة';
      _lockOpts = { mode: 'login', local: true, challenge: localChallenge(), allow: [d0.id] }; _lockOptsAt = Date.now();
      return _lockOpts;
    }
    $id('lockHint').textContent = navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : e.message;
    return null;
  }
}
// فُتحت اللوحة بلا إنترنت (بصمة على الهاتف فقط) وعاد الاتصال: شاشة القفل ونافذة البصمة ليتحقق الخادم ويعطي الجلسة،
// ثم تُرسل القرارات المحفوظة وتُحدَّث البيانات
async function adminReconnect(){
  if(_adminOps) return; // عملية جارية: بعد انتهائها
  try{ await apiCall('adminOptions', { deviceId: getDeviceId() }, { silent:true }); }
  catch(e){ if(e.net) return; } // لا يزال بلا اتصال
  if(!_pendingUnlock || !_pendingUnlock.local) return; // قُفلت أثناء الانتظار
  _lockOpts = null; // يُجلب تحدٍّ حقيقي من الخادم (مع التحقق من أن الجهاز ما زال مسجّلًا)
  lockAdmin(true);
  $id('lockHint').textContent = 'عاد الاتصال — افتح ببصمتك مرة أخرى لإرسال التغييرات وتحديث البيانات';
}
function adminUnlockApp(userTap){
  return passkeyUnlockFlow(userTap, {
    precheck: () => { if(!webauthnOk()) throw new Error(WEBAUTHN_MSG); },
    prefetch: prefetchAdminUnlock,
    allow: o => { const d = getAdminDevice() || {}; return d.id ? [d.id] : o.allow || []; },
    nextKey: ADMIN_NEXT,
    showCached: o => {
      const c = readLocalCache(CACHE_A);
      if(!(c && c.workers)) return false;
      if(o.local) _pendingUnlock = { local: true, tried: Date.now(), reconnect: adminReconnect }; // قبل عرض اللوحة: لا تحديث بلا جلسة
      applyAdminData(c); showScreen('screen-admin'); drawAdmin();
      return true;
    },
    action: 'adminUnlock',
    request: assertion => ({ ua: deviceLabel(), since: (readLocalCache(CACHE_A) || {}).version || '', delta: 1, assertion }),
    done: res => { _unlockFails = 0; return finishAdminLogin(res, true); },
    relock: () => showScreen('screen-lock'),
    prefetchOnFail: true,
    // الجهاز لم يعد مسجّلًا للإدارة: نموذج الدخول الكامل بدل شاشة القفل
    onError: msg => {
      if(!/غير مسجّل للإدارة/.test(msg)) return false;
      clearAdminDevice(); updateAdminExit(); showScreen('screen-admin-login'); showAdminLoginError(msg);
      return true;
    }
  });
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
  $id('secKeys').innerHTML = (s.keys || []).map(k => `<div class="sec-key"><span class="k-ic">${icon(/iPhone|Android|iPad/.test(k.name) ? 'smartphone' : 'monitor')}</span>
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
  _adminTab = tab;
  drawAdminTab(tab);
}
/* الأقسام غير الظاهرة لا تُرسم مع كل تحديث: كانت كل الأقسام تُرسم عند أي تغيير (300 عامل: ~70 ألف عنصر وثلث ثانية
   على الحاسوب، وأضعاف ذلك على الهاتف) — يُرسم القسم عند فتحه. «نظرة عامة» والأرقام والشارات تُحدَّث دائمًا */
let _adminTab = 'overview';
function drawAdminTab(tab){
  if(tab === 'workers'){ renderWorkersTable(); renderMessages(); }
  else if(tab === 'summary') renderAdminSummary();
  else if(tab === 'log'){ populateLogFilter(loadWorkers()); renderAdminLog(); }
  else if(tab === 'devices') renderDevices();
}

// يجلب كل بيانات الإدارة من الشيت دفعة واحدة، ثم يعيد رسم كل الأقسام منها
async function refreshAdminData(){
  let res;
  try{ res = await apiCall('getAdminData', { token: getAdminToken() }, { silent: true }); } // بلا شريط التحميل: اللوحة ثابتة
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
    messages: upsert(base.messages, d.messages, rm.messages),
    archives: d.archives || base.archives, pendingDevices: d.pendingDevices || base.pendingDevices,
    rules: d.rules || base.rules
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
  STATE.messages = d.messages || [];
  STATE.rules = d.rules || null; // شروط الحضور (null: خادم أقدم لا يدعمها)
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

  renderRulesSummary();
  renderPendingWorkers(workers);
  renderPending(workers, log);
  const nDev = (STATE.pendingDevices || []).length; // شارة «أجهزة جديدة» ظاهرة من أي قسم
  $id('devicesTabCount').textContent = nDev;
  $id('devicesTabCount').classList.toggle('hidden', nDev === 0);
  drawAdminTab(_adminTab);
}

function renderPendingWorkers(workers = loadWorkers()){
  const list = workers.filter(isPendingWorker);
  $id('pendingWorkersCount').textContent = list.length;
  $id('pendingWorkersCount').classList.toggle('hidden', list.length === 0);
  renderRows('pendingWorkersBody','pendingWorkersEmpty', list, w=>{
    const chars = [...String(w.name||'?').trim()];
    const color = (chars[0]?.charCodeAt(0) || 0) % 4;
    const date = w.createdAt ? rptDate(w.createdAt) : '';
    return `<div class="req-card">
      <div class="req-head">
        <div class="req-avatar c${color}">${escapeHtml(chars[0] || '?')}</div>
        <div class="req-info">
          <b class="req-name">${escapeHtml(w.name)}</b>
          <span class="req-meta"><span class="req-prof">${escapeHtml(w.profession)}</span>${date ? `<span>${escapeHtml(date)}</span>` : ''}</span>
        </div>
      </div>
      <div class="req-email">${escapeHtml(workerPhone(w))}</div>
      ${w.deviceFrom ? `<div class="req-warn">${icon('smartphone')} سجّل من جهاز مرتبط بحساب «${escapeHtml(w.deviceFrom)}» — القبول ينقل الجهاز إلى هذا الحساب ويُلغي ربطه بـ «${escapeHtml(w.deviceFrom)}»</div>` : ''}
      ${w.reviewNote ? `<div class="req-warn bad">${icon('triangle-alert')} ${escapeHtml(w.reviewNote)}</div>` : ''}
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
      <td data-label="الوقت">${escapeHtml(r.time)}${locLink(r)}</td>
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
      <td data-label="الاسم">${escapeHtml(w.name)}${w.passkey ? ' <span class="w-lock" title="يفتح التطبيق بقفل الهاتف">' + icon('lock') + '</span>' : ''}</td><td data-label="المهنة">${escapeHtml(w.profession)}</td><td data-label="اليومية">${isActive(w) ? escapeHtml(w.wage) : '-'}</td><td data-label="رقم الهاتف">${escapeHtml(workerPhone(w))}</td>
      <td data-label="الحالة"><span class="pill ${cls}">${label}</span>${faceNote(w)}</td>
      <td data-label="تاريخ التسجيل">${w.createdAt ? rptDate(w.createdAt) : '-'}</td>
      <td data-label="" class="td-actions">${w.status==='deleted' ? '' : `<button class="btn btn-outline btn-sm" title="رسالة تظهر في تطبيقه حتى يضغط «تم»" onclick="openMessageModal('${w.id}')">${MSG_SVG}رسالة</button>` + (w.passkey ? `<button class="btn btn-outline btn-sm" title="العامل غيّر قفل هاتفه أو لا يستطيع الفتح" onclick="resetDeviceLock('${w.id}')">${icon('lock')}إعادة ضبط القفل</button>` : '')
        + `<button class="btn btn-outline btn-sm" title="بصمة وجهه الآن بكاميرا هذا الجهاز (تحل محل بصماته السابقة)" onclick="openAdminFace('enroll','${w.id}')">${icon('scan-face')}التقاط الوجه</button>`
        + (w.faceV !== undefined && !w.faceReset ? `<button class="btn btn-outline btn-sm" title="يعيد العامل تسجيل وجهه من هاتفه (تغيّر مظهره كثيرًا) — خلال 48 ساعة" onclick="allowFaceReset('${w.id}')">${icon('refresh-cw')}إذن تسجيل الوجه</button>` : '') + `<button class="btn btn-danger btn-sm" onclick="adminDeleteWorker('${w.id}')">حذف</button>`}</td>
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
// حالة بصمة الوجه تحت حالة الحساب: إعادة تسجيل مسموح بها، أو لا بصمة
// (faceV غير موجود = الخادم أقدم من 2.12: لا شيء يُعرض)
const FACE_SF_ID = 'sf1'; // = FACE_MODEL في face.js (لا يُحمَّل في تطبيق الإدارة إلا عند فتح الكاميرا)
function faceNote(w){
  if(w.status === 'deleted' || w.faceV === undefined) return '';
  // لا بصمة بالنظام الحالي (حساب قديم أو بصمة النظام السابق الملغى): «التقاط الوجه» أو «إذن تسجيل الوجه»
  const t = w.faceReset ? 'مسموح بإعادة تسجيل الوجه' : w.faceV !== FACE_SF_ID ? 'لا توجد بصمة وجه — التقط وجهه أو اسمح بتسجيله' : '';
  return t ? `<div class="face-note">${icon('scan-face')}${t}</div>` : '';
}
// السماح للعامل بإعادة تسجيل وجهه (تغيّر مظهره كثيرًا): 48 ساعة
function allowFaceReset(id){
  const worker = loadWorkers().find(w=>w.id===id);
  if(!worker || !confirm(`السماح لـ "${worker.name}" بإعادة تسجيل بصمة وجهه؟
عند فتحه «تسجيل الحضور» يسجّل وجهه من جديد (خلال 48 ساعة) وتُستبدل بصمته الحالية.
تأكد أولًا أنه صاحب الحساب فعلًا.`)) return;
  adminAction('allowFaceReset', { workerId:id }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w){ w.faceReset = true; w.faceUpdate = true; }
  }, 'تم السماح بإعادة تسجيل الوجه');
}

function resetDeviceLock(id){
  const worker = loadWorkers().find(w=>w.id===id);
  if(!worker || !confirm(`إعادة ضبط قفل التطبيق لـ "${worker.name}"؟\nسيفتح التطبيق على جهازه المعتمد دون قفل، ثم يُطلب منه تفعيل القفل من جديد.`)) return;
  adminAction('resetDeviceLock', { workerId:id }, s=>{
    const w = s.workers.find(x=>x.id===id); if(w) w.passkey = false;
  }, 'تمت إعادة ضبط القفل');
}

/* ---------- رسائل للعمال: جماعية أو لعمال محددين ----------
   تظهر في تطبيق العامل حتى يضغط «تم» وتصله كإشعار. هنا حالة كل مستلم: أُرسلت ← وصلت ← ✓ تم.
   الخادم يرسل نص الرسالة مع أول صف منها فقط (لا يتكرر لكل عامل): يُجمع هنا حسب batchId */
let _msgTarget = ''; // عامل واحد (معرّفه) أو '' = كل العمال النشطين
function messageBatches(){
  const by = new Map();
  (STATE.messages || []).forEach(m => {
    let b = by.get(m.batchId);
    if(!b) by.set(m.batchId, b = { id: m.batchId, title: '', body: '', sentAt: m.sentAt, rows: [] });
    if(m.body !== undefined){ b.title = m.title; b.body = m.body; }
    b.rows.push(m);
  });
  return [...by.values()].sort((a, b) => b.sentAt - a.sentAt);
}
const msgStatus = m => m.doneAt ? `<span class="pill pill-approved">✓ تم</span> <small dir="ltr">${escapeHtml(rptDateTime(m.doneAt))}</small>`
  : m.seenAt ? `<span class="pill pill-pending">وصلت</span> <small dir="ltr">${escapeHtml(rptDateTime(m.seenAt))}</small>` : '<span class="pill pill-sent">أُرسلت</span>';
const MSG_SVG = icon('mail'); // أيقونة الرسالة في الأزرار (js/icons.js)
function renderMessages(){
  if(!$id('messagesBody')) return;
  renderRows('messagesBody', 'messagesEmpty', messageBatches(), b => {
    const n = b.rows.length, done = b.rows.filter(m => m.doneAt).length, seen = b.rows.filter(m => m.seenAt && !m.doneAt).length, sent = n - done - seen;
    const pct = x => (x * 100 / n).toFixed(1) + '%';
    const rows = [...b.rows].sort((x, y) => (!!y.doneAt - !!x.doneAt) || (!!y.seenAt - !!x.seenAt) || String(x.workerName).localeCompare(String(y.workerName), 'ar'));
    const one = n === 1, all = done === n;
    return `<div class="msg-item${all ? ' msg-all-done' : ''}">
      <div class="msg-ico">${MSG_SVG}</div>
      <div class="msg-main">
        <div class="msg-item-head"><b>${escapeHtml(b.title || 'رسالة من الإدارة')}</b><small dir="ltr">${escapeHtml(rptDateTime(b.sentAt))}</small></div>
        <div class="msg-to-line">${one ? 'إلى: <b>' + escapeHtml(b.rows[0].workerName) + '</b>' : 'إلى: <b>' + n + ' عمال</b>'}</div>
        <p>${escapeHtml(b.body)}</p>
        <div class="msg-progress" title="تم ${done} · وصلت ${seen} · لم تصل ${sent}"><span class="p-done" style="width:${pct(done)}"></span><span class="p-seen" style="width:${pct(seen)}"></span></div>
        <div class="msg-stats">
          <span class="ms ms-done"><i></i>تم ${done}</span><span class="ms ms-seen"><i></i>وصلت ${seen}</span><span class="ms ms-sent"><i></i>لم تصل ${sent}</span>
          ${all ? '<span class="msg-all">✓ اطّلع عليها الجميع</span>' : ''}
        </div>
        ${one ? `<div class="msg-rcpt msg-rcpt-one"><span>${escapeHtml(b.rows[0].workerName)}</span><span>${msgStatus(b.rows[0])}</span></div>`
          : `<details><summary>حالة كل عامل (${n})</summary>${rows.map(m => `<div class="msg-rcpt"><span>${escapeHtml(m.workerName)}</span><span>${msgStatus(m)}</span></div>`).join('')}</details>`}
        <div class="msg-actions"><button class="btn btn-ghost btn-sm msg-del" data-id="${escapeHtml(b.id)}" onclick="deleteMessageBatch(this.dataset.id)">حذف الرسالة</button></div>
      </div>
    </div>`;
  }, 10);
}
// workerId: رسالة لهذا العامل وحده (زر «📩 رسالة» في صفّه بالجدول)؛ بدونه: لكل العمال النشطين
function openMessageModal(workerId){
  const w = workerId ? loadWorkers().find(x => x.id === workerId && x.status !== 'deleted') : null;
  if(workerId && !w) return toast('العامل غير موجود');
  _msgTarget = w ? w.id : '';
  const n = loadWorkers().filter(isActive).length;
  $id('mcTitle').textContent = w ? 'رسالة إلى ' + w.name : 'رسالة لكل العمال';
  const initial = escapeHtml([...String((w && w.name) || '?').trim()][0] || '?');
  $id('mcTo').innerHTML = w
    ? `<div class="mc-av">${initial}</div><div class="mc-who"><b>${escapeHtml(w.name)}</b><span>${escapeHtml(w.profession || '')}${w.profession ? ' · ' : ''}<span dir="ltr">${escapeHtml(workerPhone(w))}</span>${isPendingWorker(w) ? ' · بانتظار القبول' : ''}</span></div>`
    : `<div class="mc-av mc-av-all">${icon('users')}</div><div class="mc-who"><b>كل العمال النشطين</b><span>${n} ${n === 1 ? 'عامل' : 'عمال'} — تصل لكل واحد منهم</span></div>`;
  $id('msgSendBtn').textContent = w ? 'إرسال إلى ' + w.name : `إرسال إلى كل العمال (${n})`;
  $id('msgTitle').value = ''; $id('msgBody').value = ''; updateMsgCounter();
  setModal('msgComposeModal', true);
  setTimeout(() => $id('msgBody').focus(), 50);
}
function closeMessageModal(){ setModal('msgComposeModal', false); }
function updateMsgCounter(){ $id('mcCount').textContent = $id('msgBody').value.length + ' / 600'; }
function sendWorkerMessage(){
  const all = !_msgTarget;
  const title = $id('msgTitle').value.trim(), body = $id('msgBody').value.trim();
  if(!body){ $id('msgBody').focus(); return toast('اكتب نص الرسالة'); }
  const n = all ? loadWorkers().filter(isActive).length : 1;
  if(!n) return toast('لا يوجد عمال نشطون');
  if(all && !confirm(`إرسال الرسالة إلى كل العمال النشطين (${n})؟`)) return;
  const name = all ? '' : (loadWorkers().find(w => w.id === _msgTarget) || {}).name || '';
  closeMessageModal();
  adminAction('sendMessage', { all: all ? 1 : 0, workerIds: all ? [] : [_msgTarget], title, body }, null,
    all ? `أُرسلت الرسالة إلى ${n} ${n === 1 ? 'عامل' : 'عمال'}` : 'أُرسلت الرسالة إلى ' + name);
}
function deleteMessageBatch(batchId){
  if(!confirm('حذف هذه الرسالة؟ تختفي من تطبيق كل من لم يضغط «تم» عليها بعد.')) return;
  adminAction('deleteMessage', { batchId }, s => { s.messages = (s.messages || []).filter(m => m.batchId !== batchId); }, 'حُذفت الرسالة');
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
      <td data-label="العامل">${escapeHtml(r.workerName)}</td><td data-label="التاريخ">${escapeHtml(r.date)}</td><td data-label="الوقت">${escapeHtml(r.time)}${locLink(r)}</td>
      <td data-label="الحالة"><span class="pill pill-${escapeHtml(r.status)}">${statusMap[r.status]}</span></td>
    </tr>`);
}
// موقع الحضور (حين تُفعّل شروط الموقع): البعد عن موقع العمل + فتحه على الخريطة
function locLink(r){
  const m = String(r.loc || '').match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if(!m) return '';
  const d = String(r.loc).match(/يبعد (\d+)/);
  // الخادم يعلّم الدقة غير الطبيعية (±1 م): علامة شائعة لتطبيقات الموقع الوهمي — للمراجعة قبل الاعتماد
  const fake = /دقة غير طبيعية/.test(String(r.loc)) ? ` <span class="loc-warn" title="دقة ±1 م لا يعطيها GPS هاتف حقيقي — قد يكون موقعًا وهميًا">${icon('triangle-alert')} موقع مشبوه</span>` : '';
  return `<a class="loc-link" href="https://www.google.com/maps?q=${m[1]},${m[2]}" target="_blank" rel="noopener">${icon('map-pin')} ${d ? 'يبعد ' + d[1] + ' م' : 'الموقع'}</a>${fake}`;
}

/* =========================================================================
   شروط تسجيل الحضور: موقع العمل (خريطة OpenStreetMap عبر Leaflet) + وقت الحضور
   ========================================================================= */
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
// بصمات الملفات (SRI) من cdnjs لهذه النسخ المثبّتة: نسخة معدّلة على الخادم الخارجي تُرفض ولا تُنفَّذ في لوحة الإدارة
const SRI = {
  leafletJs: 'sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO',
  leafletCss: 'sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb',
  html2canvas: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
  jspdf: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
  qrcode: 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1'
};
const RULES_DEFAULT_CENTER = [24.7136, 46.6753]; // الرياض — حين لا يوجد موقع محدد بعد
let _rMap = null, _rMarker = null, _rCircle = null, _rPoint = null;
// ما يراه العامل من الشروط (مثل workerRules_ في الخادم): تغيّره فقط يستحق إبلاغ العمال
const publicRules = r => JSON.stringify({
  geo: r && r.geo && r.geo.on ? { lat: r.geo.lat, lng: r.geo.lng, radius: r.geo.radius, label: r.geo.label || '' } : null,
  time: r && r.time && r.time.on ? { from: r.time.from, to: r.time.to } : null });
// نص الرسالة كما يصل للعامل (مطابق لـ rulesMessage_ في الخادم) — للمعاينة قبل الحفظ
function rulesMessageText(r){
  if(!r.time.on && !r.geo.on) return 'أُلغيت شروط تسجيل الحضور.\nيمكنك الآن تسجيل حضورك في أي وقت ومن أي مكان.';
  const lines = ['حدّدت الإدارة شروط تسجيل الحضور:'];
  if(r.time.on) lines.push('🕒 الوقت: من الساعة ' + r.time.from + ' إلى الساعة ' + r.time.to + ' (بتوقيت الرياض)');
  if(r.geo.on) lines.push('📍 المكان: داخل ' + r.geo.radius + ' متر من ' + (r.geo.label ? '«' + r.geo.label + '»' : 'موقع العمل'),
    'شغّل خدمة الموقع (GPS) واسمح للتطبيق بالوصول لموقعك عند تسجيل الحضور.');
  lines.push('لا يُقبل الحضور خارج هذه الشروط.');
  return lines.join('\n');
}
// شريط «نظرة عامة»: الشروط الحالية كشارات
function renderRulesSummary(){
  const el = $id('rulesSummary'), r = STATE.rules;
  if(!el) return;
  if(!r){ el.innerHTML = '<span class="rchip warn">غير متاحة — انشر النسخة الجديدة من Code.gs</span>'; return; }
  const chips = [];
  if(r.time.on) chips.push(`<span class="rchip on">${icon('clock')} <b dir="ltr">${escapeHtml(r.time.from)} – ${escapeHtml(r.time.to)}</b></span>`);
  if(r.geo.on) chips.push(`<span class="rchip on">${icon('map-pin')} ${r.geo.radius} م من ${escapeHtml(r.geo.label || 'موقع العمل')}</span>`);
  el.innerHTML = chips.join('') || '<span class="rchip">بلا شروط — الحضور في أي وقت ومن أي مكان</span>';
}
function loadLeaflet(){
  if(!$id('leafletCss')){
    const l = document.createElement('link'); l.id = 'leafletCss'; l.rel = 'stylesheet';
    l.integrity = SRI.leafletCss; l.crossOrigin = 'anonymous'; l.href = LEAFLET + 'leaflet.min.css';
    document.head.appendChild(l);
  }
  return loadScript(LEAFLET + 'leaflet.min.js', () => !!(window.L && L.map), '', SRI.leafletJs);
}
async function openRulesModal(){
  if(!STATE.rules) return toast('انشر النسخة الجديدة من Code.gs أولًا (Deploy ← New version)');
  const r = STATE.rules;
  $id('ruleGeoOn').checked = !!r.geo.on; $id('ruleTimeOn').checked = !!r.time.on;
  $id('ruleLabel').value = r.geo.label || '';
  $id('ruleFrom').value = r.time.from || '06:00'; $id('ruleTo').value = r.time.to || '09:00';
  $id('ruleNotify').checked = true;
  _rPoint = r.geo.lat != null && r.geo.lng != null ? { lat: r.geo.lat, lng: r.geo.lng } : null;
  $id('ruleCoords').value = _rPoint ? _rPoint.lat + ', ' + _rPoint.lng : '';
  rulesRadiusInput(r.geo.radius || 200);
  $id('rlPreviewBox').open = innerWidth > 600; // الهاتف: معاينة الرسالة مطوية (تقصير التمرير)
  setModal('rulesModal', true);
  $id('rulesModal').querySelector('.mc-body').scrollTop = 0;
  rulesUi();
}
function closeRulesModal(){ setModal('rulesModal', false); }
// الشروط كما في النموذج الآن (بصيغة الخادم)
function formRules(){
  return {
    geo: { on: $id('ruleGeoOn').checked, lat: _rPoint ? _rPoint.lat : null, lng: _rPoint ? _rPoint.lng : null,
      radius: rulesRadius(), label: $id('ruleLabel').value.trim() },
    time: { on: $id('ruleTimeOn').checked, from: $id('ruleFrom').value, to: $id('ruleTo').value }
  };
}
// إظهار/إخفاء أقسام الشروط حسب التفعيل، والخريطة تُحمَّل عند أول حاجة إليها فقط
function rulesUi(){
  const geo = $id('ruleGeoOn').checked, time = $id('ruleTimeOn').checked;
  $id('rlGeoSec').classList.toggle('on', geo); $id('rlTimeSec').classList.toggle('on', time);
  $id('rulesGeoBox').classList.toggle('hidden', !geo);
  $id('rulesTimeBox').classList.toggle('hidden', !time);
  if(geo) initRulesMap();
  rulesPreview();
}
// حالة كل قسم + الشارات المختارة + معاينة الرسالة + هل سيُبلَّغ العمال
function rulesPreview(){
  const r = formRules(), mins = t => { const p = String(t).split(':'); return p.length === 2 ? +p[0] * 60 + +p[1] : NaN; };
  $id('rlTimeState').textContent = r.time.on ? 'من ' + (r.time.from || '--:--') + ' إلى ' + (r.time.to || '--:--') : 'في أي وقت';
  $id('rlGeoState').textContent = !r.geo.on ? 'من أي مكان' : _rPoint ? 'داخل ' + r.geo.radius + ' م من ' + (r.geo.label || 'موقع العمل') : 'حدّد الموقع على الخريطة';
  document.querySelectorAll('#rlTimeChips .rl-chip').forEach(b => b.classList.toggle('on', b.dataset.from === r.time.from && b.dataset.to === r.time.to));
  document.querySelectorAll('#rlRadiusChips .rl-chip').forEach(b => b.classList.toggle('on', Number(b.dataset.r) === r.geo.radius));
  const a = mins(r.time.from), b = mins(r.time.to);
  if(isFinite(a) && isFinite(b) && a !== b){
    const d = (b - a + 1440) % 1440, h = Math.floor(d / 60), m = d % 60;
    $id('rlTimeHint').textContent = 'بتوقيت الرياض — المدة ' + (h ? h + ' ساعة' : '') + (h && m ? ' و' : '') + (m ? m + ' دقيقة' : '') + (b < a ? '، وتمتد بعد منتصف الليل' : '') + '.';
  }else $id('rlTimeHint').textContent = 'اختر وقتين مختلفين للبداية والنهاية (بتوقيت الرياض).';
  $id('rlPreview').textContent = rulesMessageText(r);
  const changed = publicRules(r) !== publicRules(STATE.rules), n = loadWorkers().filter(isActive).length;
  $id('rlNotifyRow').classList.toggle('off', !changed);
  $id('rlNotifyNote').textContent = !changed ? 'لم تتغير الشروط بعد — لن يُرسل شيء'
    : !$id('ruleNotify').checked ? 'لن يُبلَّغ العمال — تصلهم الشروط الجديدة بصمت مع التحديث'
    : `يصل ${n} عامل: إشعار على الهاتف + نافذة في التطبيق لا تختفي حتى يضغط «تم»`;
}
function rulesPresetTime(btn){ $id('ruleFrom').value = btn.dataset.from; $id('ruleTo').value = btn.dataset.to; rulesPreview(); }
async function initRulesMap(){
  const box = $id('rulesMap');
  try{ await loadLeaflet(); }
  catch(e){ box.innerHTML = '<p class="al-hint" style="padding:12px;">تعذر تحميل الخريطة — تحقق من الاتصال، أو الصق الإحداثيات في الحقل بالأسفل.</p>'; return; }
  if(!_rMap){
    box.innerHTML = '';
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' });
    // عرض مبدئي فورًا: إضافة العلامة والدائرة لخريطة بلا عرض بعد تفشل (layerPointToLatLng)
    _rMap = L.map(box, { layers: [street] }).setView(_rPoint ? [_rPoint.lat, _rPoint.lng] : RULES_DEFAULT_CENTER, _rPoint ? 16 : 11);
    L.control.layers({ 'خريطة': street, 'قمر صناعي': sat }, null, { position: 'topleft' }).addTo(_rMap);
    _rMap.on('click', e => setRulesPoint(e.latlng.lat, e.latlng.lng, false));
  }
  // الخريطة داخل نافذة كانت مخفية: تُعاد معايرة حجمها بعد ظهورها
  setTimeout(() => {
    _rMap.invalidateSize();
    if(_rPoint) setRulesPoint(_rPoint.lat, _rPoint.lng, true);
    else{
      _rMap.setView(RULES_DEFAULT_CENTER, 11);
      if(_rMarker){ _rMap.removeLayer(_rMarker); _rMap.removeLayer(_rCircle); _rMarker = _rCircle = null; }
    }
  }, 60);
}
let _rRadius = 200;
function rulesRadius(){ return _rRadius; }
// النطاق من الشريط أو الشارات أو الحقل الرقمي (typing: لا يُعاد كتابة الحقل أثناء الكتابة فيه)
function rulesRadiusInput(v, typing){
  const n = Math.round(Number(v));
  if(!(n >= 20 && n <= 5000)){ if(!typing) rulesRadiusInput(_rRadius); return; }
  _rRadius = n;
  if(!typing) $id('ruleRadius').value = n;
  $id('ruleRadiusRange').value = Math.min(n, 1000);
  $id('rlRadiusVal').textContent = n >= 1000 ? (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' كم' : n + ' م';
  if(_rCircle) _rCircle.setRadius(n);
  if($id('rulesModal') && !$id('rulesModal').classList.contains('hidden')) rulesPreview();
}
function setRulesPoint(lat, lng, fit){
  _rPoint = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  $id('ruleCoords').value = _rPoint.lat + ', ' + _rPoint.lng;
  rulesPreview();
  if(!_rMap) return;
  const ll = [_rPoint.lat, _rPoint.lng];
  if(!_rMarker){
    _rMarker = L.marker(ll, { draggable: true, icon: L.divIcon({ className: 'rules-pin', html: icon('map-pin'), iconSize: [32, 32], iconAnchor: [16, 30] }) }).addTo(_rMap);
    _rMarker.on('drag', e => { const p = e.target.getLatLng(); _rCircle.setLatLng(p); });
    _rMarker.on('dragend', e => { const p = e.target.getLatLng(); setRulesPoint(p.lat, p.lng, false); });
    _rCircle = L.circle(ll, { radius: rulesRadius(), color: '#dd9a34', weight: 2, fillOpacity: .15 }).addTo(_rMap);
  }else{ _rMarker.setLatLng(ll); _rCircle.setLatLng(ll); }
  _rCircle.setRadius(rulesRadius());
  // حدود النطاق من النقطة نفسها (لا من الدائرة: حدودها تتطلب أن تكون قد رُسمت)
  if(fit) _rMap.fitBounds(L.latLng(ll).toBounds(rulesRadius() * 2), { padding: [24, 24], maxZoom: 18 });
}
// إحداثيات ملصوقة: "24.7136, 46.6753" أو رابط خرائط Google (…@24.7136,46.6753,17z أو ?q=24.7136,46.6753)
function rulesCoordsInput(){
  const m = $id('ruleCoords').value.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if(!m) return toast('لم أجد إحداثيات — مثال صحيح: 24.7136, 46.6753');
  const lat = Number(m[1]), lng = Number(m[2]);
  if(Math.abs(lat) > 90 || Math.abs(lng) > 180) return toast('إحداثيات غير صحيحة');
  setRulesPoint(lat, lng, true);
}
function rulesUseMyLocation(){
  if(!navigator.geolocation) return toast('هذا الجهاز لا يدعم تحديد الموقع');
  const btn = $id('rulesMyLocBtn'); btn.disabled = true; btn.textContent = 'جاري التحديد...';
  const done = () => { btn.disabled = false; btn.textContent = '◎ موقعي الحالي'; };
  navigator.geolocation.getCurrentPosition(p => { done(); setRulesPoint(p.coords.latitude, p.coords.longitude, true);
    if(p.coords.accuracy > 100) toast('دقة الموقع ±' + Math.round(p.coords.accuracy) + ' م — راجع العلامة على الخريطة'); },
    e => { done(); toast(e.code === 1 ? 'لم يُسمح بالوصول للموقع — اسمح به من إعدادات المتصفح' : 'تعذر تحديد موقعك — حدده على الخريطة'); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
async function saveRulesFromAdmin(){
  const rules = formRules(), radiusTyped = Math.round(Number($id('ruleRadius').value));
  if(rules.geo.on && !_rPoint) return toast('حدّد موقع العمل على الخريطة أولًا');
  if(rules.geo.on && !(radiusTyped >= 20 && radiusTyped <= 5000)) return toast('نطاق الموقع يجب أن يكون بين 20 و 5000 متر');
  if(rules.time.on && (!rules.time.from || !rules.time.to)) return toast('حدّد وقت البداية والنهاية');
  if(rules.time.on && rules.time.from === rules.time.to) return toast('وقت البداية يجب أن يختلف عن وقت النهاية');
  const notify = $id('ruleNotify').checked;
  const btn = $id('rulesSaveBtn'); btn.disabled = true; btn.textContent = 'جاري الحفظ...';
  // ليس عبر صندوق الإرسال: شرط يُطبَّق على كل العمال يجب أن يؤكده الخادم الآن، لا لاحقًا عند عودة الاتصال
  try{
    const res = await apiCall('saveCheckinRules', { token: getAdminToken(), rules, notify, since: _adminVer, delta: 1 });
    // بيانات اللوحة المرفقة (ومنها رسالة الشروط في «الرسائل المرسلة») طُبّقت في roleOnResponse
    STATE.rules = res.rules; _adminFresh = false;
    drawAdmin();
    closeRulesModal();
    toast(res.notified ? `تم حفظ الشروط ✓ وأُبلغ ${res.notified} عامل` : res.changed === false ? 'لم تتغير الشروط' : 'تم حفظ شروط الحضور ✓');
  }catch(e){ toast(e.net ? 'لا يوجد اتصال — لم تُحفظ الشروط، أعد المحاولة' : e.message); }
  finally{ btn.disabled = false; btn.textContent = 'حفظ الشروط'; }
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
    const date = d.createdAt ? rptDateTime(d.createdAt) : '';
    return `<div class="req-card">
      <div class="req-head">
        <div class="req-avatar c2">${icon('smartphone')}</div>
        <div class="req-info">
          <b class="req-name">${escapeHtml(w ? w.name : d.phone)}</b>
          <span class="req-meta"><span>${escapeHtml(d.phone)}</span>${date?`<span>${escapeHtml(date)}</span>`:''}</span>
        </div>
      </div>
      <div class="req-email" style="direction:rtl;text-align:right;white-space:normal;">${d.model || d.os || d.browser
        ? `<b>${escapeHtml([d.model || 'طراز غير معروف', d.os, d.browser].filter(Boolean).join(' — '))}</b>` : escapeHtml(d.userAgent || 'جهاز غير معروف')}</div>
      ${d.fromName ? `<div class="req-warn">${icon('refresh-cw')} طلب فتح حساب آخر: هذا الجهاز مرتبط الآن بحساب «${escapeHtml(d.fromName)}» — الاعتماد ينقله إلى «${escapeHtml(w ? w.name : d.phone)}» ويُلغي ربطه بـ «${escapeHtml(d.fromName)}»</div>` : ''}
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

// (مطابق لـ computeAccount_ / countPending_ في الخادم، بنفس تحويل الأنواع حتى لا يختلف الرقم المعروض عن الملزِم)
const inAccountPeriod = (x, worker, since, untilTs) =>
  String(x.workerId)===String(worker.id) && Number(x.timestamp)>since && Number(x.timestamp)<=untilTs;
function computeAccount(worker, log, advances, untilTs = Infinity){
  const since = Number(worker.lastSettledAt) || 0;
  const earned = log
    .filter(r=>r.status==='approved' && inAccountPeriod(r, worker, since, untilTs))
    .reduce((sum,r)=> sum + recordWage(r, worker), 0);
  const advanced = advances
    .filter(a=>inAccountPeriod(a, worker, since, untilTs))
    .reduce((sum,a)=> sum + (Number(a.amount) || 0), 0);
  return { earned: money(earned), advanced: money(advanced), net: money(earned - advanced) };
}

function countPending(worker, log, untilTs = Infinity){
  const since = Number(worker.lastSettledAt) || 0;
  return log.filter(r=>r.status==='pending' && inAccountPeriod(r, worker, since, untilTs)).length;
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
      <td data-label="تاريخ التصفية">${a.closedAt ? rptDate(a.closedAt) : '-'}</td>
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
  let html = `<div class="summary-actions" style="margin:0 0 12px;"><button class="btn btn-green btn-sm" onclick="downloadArchivePdf('${id}')">${icon('file-down')}تنزيل التقرير PDF</button>
    ${/^https:\/\/docs\.google\.com\//.test(r.reportSheet || '')
      ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(r.reportSheet)}" target="_blank" rel="noopener">${icon('sheet')}فتح ملف التقرير في Google Sheets</a>`
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
.rpt-page{width:${RPT_W}px;height:${RPT_H}px;box-sizing:border-box;padding:0 0 46px;background:#fff;color:#141a4d;font-family:'Tajawal',Tahoma,Arial,sans-serif;direction:rtl;position:relative;overflow:hidden;}
.rpt-page *{letter-spacing:0!important;box-sizing:border-box;}
.rpt-band{background:#141a4d;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:14px 34px;border-bottom:4px solid #94650f;}
.rpt-brand{display:flex;align-items:center;gap:14px;}
.rpt-brand img{height:54px;width:auto;}
.rpt-co{font-size:24px;font-weight:800;line-height:1.2;}
.rpt-app{font-size:12px;color:#c9d0de;margin-top:2px;}
.rpt-doc{text-align:left;}
.rpt-doc .t{font-size:19px;font-weight:800;}
.rpt-doc .m{font-size:14px;color:#f3c572;font-weight:700;margin-top:3px;}
.rpt-meta{display:flex;justify-content:space-between;gap:10px;background:#f4f6fa;border-bottom:1px solid #e3e7ef;padding:7px 34px;font-size:12px;color:#5b6479;}
.rpt-meta b{color:#141a4d;font-weight:700;}
.rpt-status{font-weight:800;padding:1px 10px;border-radius:999px;}
.rpt-status.fin{background:#e3f3ea;color:#1f7a56;} .rpt-status.drf{background:#fdecea;color:#bd4438;}
.rpt-body{padding:12px 34px 0;}
.rpt-sec{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800;color:#141a4d;margin:4px 0 8px;}
.rpt-sec:before{content:'';width:5px;height:17px;border-radius:3px;background:#94650f;display:inline-block;}
.rpt-gap{height:14px;}
.rpt-tw{border:1px solid #d5dbe6;border-radius:10px;overflow:hidden;background:#fff;}
.rpt-tbl{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;}
.rpt-tbl th{background:#141a4d;color:#fff;padding:8px 4px;font-weight:700;text-align:center;white-space:nowrap;border-left:1px solid #2b3b5f;border-bottom:3px solid #94650f;}
.rpt-tbl td{border-top:1px solid #e6e9f0;border-left:1px solid #e6e9f0;padding:4px 6px;text-align:center;height:26px;white-space:nowrap;overflow:hidden;color:#2a3450;}
.rpt-tbl th:last-child,.rpt-tbl td:last-child{border-left:0;}
.rpt-tbl td.nm{font-weight:700;color:#141a4d;}
.rpt-tbl td.note{text-align:right;color:#5b6479;}
.rpt-tbl tr.rpt-zero td{height:0;padding:0;border:0;line-height:0;}
.rpt-empty{padding:9px 12px;text-align:center;font-size:12.5px;font-weight:700;color:#8f9bb5;background:#fafbfd;}
.rpt-tbl tbody tr:nth-child(even) td{background:#f6f8fc;}
.rpt-tbl tr.tot td{background:#fbf0d9!important;font-weight:800;color:#141a4d;border-top:2px solid #94650f;}
/* كشف الدوام: خط فاصل واضح بين كل عامل، فاصل بين الاسم والأيام وبين الأيام والمجاميع */
.rpt-mx{font-size:11px;}
.rpt-mx th{padding:4px 0 3px;font-size:10.5px;line-height:1.15;}
.rpt-mx th .wd{display:block;font-size:8.5px;font-weight:500;color:#aeb8cf;margin-top:1px;}
.rpt-mx th.we{background:#27337d;} .rpt-mx th.we .wd{color:#f3c572;}
.rpt-mx td{padding:0;height:27px;font-size:12px;}
.rpt-mx tbody tr td{border-top:2px solid #b9c3d6;}
.rpt-mx tbody tr:first-child td{border-top:0;}
.rpt-mx td.nm{font-size:11.5px;} .rpt-mx td.pr{font-size:10.5px;color:#5b6479;}
.rpt-mx td.pr,.rpt-mx th.prh{border-left:2px solid #8f9bb5;}
.rpt-mx td.first,.rpt-mx th.first{border-right:2px solid #8f9bb5;}
.rpt-mx th.sumh{background:#1d2c4d;}
.rpt-mx td.sum{background:#f1f4fa!important;font-weight:700;color:#141a4d;}
.rpt-mx td.we{background:#eef1f6!important;}
.rpt-mx td.A{color:#1f7a56;font-weight:800;background:#e3f3ea!important;}
.rpt-mx td.R{color:#bd4438;font-weight:800;background:#fde8e6!important;}
.rpt-mx td.P{color:#b9761f;font-weight:800;background:#fff1da!important;}
.rpt-legend .lg{display:inline-block;width:18px;height:16px;line-height:16px;text-align:center;border:1px solid #cfd6e3;border-radius:4px;margin:0 2px 0 8px;font-weight:800;vertical-align:middle;}
.rpt-legend .lg.A{background:#e3f3ea;color:#1f7a56;} .rpt-legend .lg.R{background:#fde8e6;color:#bd4438;} .rpt-legend .lg.P{background:#fff1da;color:#b9761f;} .rpt-legend .lg.we{background:#eef1f6;}
.rpt-page .ltr{direction:ltr;unicode-bidi:isolate;display:inline-block;}
.rpt-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;}
.rpt-card{border:1px solid #dfe3ea;border-radius:10px;padding:9px 13px;border-right:4px solid #94650f;background:#fff;}
.rpt-card span{display:block;font-size:12px;color:#5b6479;}
.rpt-card b{display:block;font-size:20px;margin-top:3px;color:#141a4d;}
.rpt-card.big{background:#141a4d;} .rpt-card.big span{color:#c9d0de;} .rpt-card.big b{color:#fff;}
.rpt-card.red b{color:#bd4438;} .rpt-card.green b{color:#1f7a56;}
.rpt-notes{margin-top:10px;font-size:11.5px;color:#5b6479;line-height:1.9;}
.rpt-legend{font-size:11.5px;color:#5b6479;margin:-2px 0 6px;}
.rpt-foot{position:absolute;bottom:0;left:0;right:0;height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 34px;font-size:10.5px;color:#6b7489;border-top:1px solid #e3e7ef;background:#f9fafc;}
.rpt-foot .code{font-family:Consolas,'Courier New',monospace;color:#141a4d;font-weight:700;direction:ltr;}
.rpt-wm{position:absolute;top:40%;left:0;right:0;text-align:center;font-size:120px;color:rgba(189,68,56,.06);transform:rotate(-14deg);font-weight:900;pointer-events:none;}
.rpt-sign{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:18px;}
.rpt-sign .box{flex:1;border:1px dashed #cfd5e0;border-radius:10px;padding:10px 14px;font-size:12px;color:#5b6479;min-height:86px;}
.rpt-sign .box b{display:block;color:#141a4d;font-size:13px;margin-bottom:30px;}
.rpt-stamp{width:150px;height:150px;border-radius:50%;border:3px double #1f7a56;color:#1f7a56;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transform:rotate(-10deg);font-weight:800;flex:none;}
.rpt-stamp.drf{border-color:#bd4438;color:#bd4438;}
.rpt-stamp .s1{font-size:15px;} .rpt-stamp .s2{font-size:11px;margin:3px 0;} .rpt-stamp .s3{font-size:10px;font-family:Consolas,monospace;direction:ltr;}
.rpt-verify{margin-top:12px;border:1px solid #e3e7ef;border-radius:10px;background:#f9fafc;padding:9px 14px;font-size:11.5px;color:#5b6479;line-height:1.9;}
.rpt-verify .code{font-family:Consolas,'Courier New',monospace;color:#141a4d;font-weight:800;direction:ltr;display:inline-block;}
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
  return Promise.all([loadScript(PDF_LIBS[0], () => !!window.html2canvas, '', SRI.html2canvas), loadScript(PDF_LIBS[1], () => !!window.jspdf, '', SRI.jspdf)])
    .catch(() => { throw new Error('تعذر تحميل مكتبة PDF'); });
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
const loadQrLib = () => loadScript(QR_LIB, () => !!window.qrcode, '', SRI.qrcode);
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

/* ---------- ملخص حسابات العمال حسب الشهر المختار (قائمة الأشهر أعلى «الملخص») ----------
   شهر مُصفّى (في الأرشيف)   ← ملخص كل عامل كما حُفظ وقت الإقفال، للعرض فقط (لا تصفية ولا سلفة)
   الشهر الحالي              ← الحساب المفتوح منذ آخر تصفية، مع «+ سلفة» و«تصفية الحساب»
   شهر سابق لم يُصفَّ بعد     ← حضور وسلف ذلك الشهر وحده للعرض؛ التصفية والسلف من الشهر الحالي (تشمله) */
let _accountsReq = 0; // آخر طلب رسم: تغيير الشهر أثناء تحميل الأرشيف لا يرسم بيانات شهر آخر
const archiveOfMonth = month => loadArchives().find(a => String(a.month).slice(0, 7) === month);
const deletedTag = deleted => deleted ? ' <small style="color:var(--red);">(ملغى)</small>' : '';
function setAccountsHeader(month, cols, note){
  $id('accountsTitle').textContent = 'ملخص حسابات العمال — ' + monthLabel(month);
  $id('accountsNote').innerHTML = note;
  $id('accountsHead').innerHTML = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';
}
function renderAccountsTable(){
  const month = selectedMonth(), req = ++_accountsReq, archive = archiveOfMonth(month);
  if(archive) return renderClosedAccounts(month, archive, req);
  if(month === monthStr()) return renderOpenAccounts(month);
  renderUnsettledMonth(month);
}
// الشهر الحالي: الحساب المفتوح لكل عامل منذ آخر تصفية — هنا فقط تُضاف السلف وتُصفّى الحسابات
function renderOpenAccounts(month){
  setAccountsHeader(month, ['العامل', 'المهنة', 'المستحق', 'السلف', 'الرصيد الصافي', 'إجراءات'],
    `<span class="pill pill-pending">${icon('clock')} الشهر الحالي</span><span>الحساب المفتوح لكل عامل منذ آخر تصفية — أضف السلف أو صفِّ الحساب من هنا</span>`);
  const q = searchQuery('accountSearch');
  const allLog = loadLog();
  const advances = loadAdvances();
  // النشطون + من ألغى حسابه وما زال له رصيد (حتى لا يختفي من الحسابات)
  const rows = loadWorkers().filter(w=>isActive(w) || w.status==='deleted')
    .map(w=>({ w, acc: computeAccount(w, allLog, advances) }))
    .filter(x=> isActive(x.w) || x.acc.earned || x.acc.advanced)
    .filter(x=> matches(q, x.w.name, x.w.profession));
  renderRows('accountsBody','accountsEmpty', rows, ({w, acc})=>`<tr>
      <td data-label="العامل">${escapeHtml(w.name)}${deletedTag(!isActive(w))}</td>
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
// شهر مُصفّى: ملخص كل عامل من تقرير الأرشيف الموقّع (يُجلب مرة ويُحفظ في الذاكرة) — للعرض فقط
function renderClosedAccounts(month, archive, req){
  setAccountsHeader(month, ['العامل', 'المهنة', 'أيام العمل', 'المستحق', 'السلف', 'المدفوع'],
    `<span class="pill pill-approved">${icon('circle-check')} مُصفّى</span><span>أُقفل حساب الشهر بتاريخ <bdi dir="ltr" style="white-space:nowrap">${archive.closedAt ? rptDate(archive.closedAt) : '-'}</bdi> — ملخص محفوظ للعرض فقط</span>`);
  const cached = _archiveCache.get(archive.id);
  if(cached) return drawClosedAccounts(cached);
  $id('accountsBody').innerHTML = `<tr><td colspan="6" class="acc-loading">${icon('refresh-cw', 'spin')} جارٍ تحميل ملخص ${escapeHtml(monthLabel(month))}...</td></tr>`;
  $id('accountsFoot').innerHTML = ''; $id('accountsEmpty').classList.add('hidden');
  fetchArchive(archive.id).then(r => { if(req === _accountsReq) drawClosedAccounts(r); })
    .catch(e => { if(req !== _accountsReq) return;
      $id('accountsBody').innerHTML = `<tr><td colspan="6" class="acc-loading">${escapeHtml(e.net ? 'لا يوجد اتصال بالخادم — ملخص الشهر المُصفّى يحتاج الاتصال' : e.message)}
        <button class="btn btn-outline btn-sm" onclick="renderAccountsTable()">إعادة المحاولة</button></td></tr>`; });
}
function drawClosedAccounts(report){
  const q = searchQuery('accountSearch');
  const rows = (report.workers || []).filter(w => matches(q, w.name, w.profession));
  renderRows('accountsBody','accountsEmpty', rows, w => {
    const carried = Number(w.carried) || 0;
    return `<tr>
      <td data-label="العامل">${escapeHtml(w.name)}${deletedTag(w.status === 'deleted')}</td>
      <td data-label="المهنة">${escapeHtml(w.profession || '')}</td>
      <td data-label="أيام العمل">${escapeHtml(w.approvedDays ?? '-')}</td>
      <td data-label="المستحق">${fmt(w.earned ?? w.monthEarned ?? 0)}</td>
      <td data-label="السلف">${fmt(w.advances || 0)}</td>
      <td data-label="المدفوع" style="font-weight:800;">${fmt(w.paid || 0)}${carried ? `<br><small style="color:var(--red);">مرحّل ${fmt(carried)}</small>` : ''}</td>
    </tr>`; });
  const sum = f => money(rows.reduce((s, w) => s + (Number(w[f]) || 0), 0));
  $id('accountsFoot').innerHTML = rows.length
    ? `<tr><td data-label="">الإجمالي</td><td></td><td data-label="أيام العمل">${sum('approvedDays')}</td><td data-label="المستحق">${fmt(sum('earned'))}</td><td data-label="السلف">${fmt(sum('advances'))}</td><td data-label="المدفوع">${fmt(sum('paid'))}</td></tr>` : '';
}
// شهر سابق لم يُصفَّ بعد: حضور وسلف ذلك الشهر وحده — حسابه ما زال مفتوحًا ويُصفّى من الشهر الحالي
function renderUnsettledMonth(month){
  setAccountsHeader(month, ['العامل', 'المهنة', 'أيام العمل', 'مستحق الشهر', 'سلف الشهر', 'الصافي'],
    `<span class="pill pill-sent">${icon('info')} لم يُصفَّ بعد</span><span>حضور وسلف هذا الشهر للعرض — تصفيته وإضافة السلف من الشهر الحالي</span>`);
  const q = searchQuery('accountSearch');
  const monthLog = loadLog().filter(r => r.status === 'approved' && r.date.startsWith(month));
  const monthAdv = loadAdvances().filter(a => String(a.date || '').startsWith(month));
  const rows = monthWorkers(loadLog().filter(r => r.date.startsWith(month)))
    .map(w => {
      const days = monthLog.filter(r => r.workerId === w.id);
      const earned = money(days.reduce((s, r) => s + recordWage(r, w), 0));
      const advanced = money(monthAdv.filter(a => a.workerId === w.id).reduce((s, a) => s + (Number(a.amount) || 0), 0));
      return { w, days: days.length, earned, advanced, net: money(earned - advanced) };
    })
    .filter(x => x.days || x.advanced)
    .filter(x => matches(q, x.w.name, x.w.profession));
  renderRows('accountsBody','accountsEmpty', rows, x => `<tr>
      <td data-label="العامل">${escapeHtml(x.w.name)}${deletedTag(!isActive(x.w))}</td>
      <td data-label="المهنة">${escapeHtml(x.w.profession)}</td>
      <td data-label="أيام العمل">${x.days}</td>
      <td data-label="مستحق الشهر">${fmt(x.earned)}</td>
      <td data-label="سلف الشهر">${fmt(x.advanced)}</td>
      <td data-label="الصافي" style="font-weight:800;color:${x.net>=0?'var(--green)':'var(--red)'}">${fmt(x.net)}</td>
    </tr>`);
  const sum = f => money(rows.reduce((s, x) => s + x[f], 0));
  $id('accountsFoot').innerHTML = rows.length
    ? `<tr><td data-label="">الإجمالي</td><td></td><td data-label="أيام العمل">${sum('days')}</td><td data-label="مستحق الشهر">${fmt(sum('earned'))}</td><td data-label="سلف الشهر">${fmt(sum('advanced'))}</td><td data-label="الصافي">${fmt(sum('net'))}</td></tr>` : '';
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
  // مبلغ غير معتاد (أكبر من 5 أيام عمل): تأكيد قبل التسجيل — خطأ إدخال (صفر زائد) يدخل الحسابات والتقرير الموقّع
  const wage = Number(worker.wage) || 0;
  if(wage && amount > wage * 5 && !confirm(`سلفة بمبلغ ${fmt(amount)} لـ "${worker.name}"
هذا أكبر من ${Math.floor(amount / wage)} أيام من يوميته (${fmt(wage)}).

هل المبلغ صحيح؟`)) return;

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
let _adminVer = '', _adminFullAt = 0, _adminSeen = null, _adminRedrawPending = false;
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

// الخروج (بضغطة المستخدم فقط): يُنهي الجلسة في الخادم ويمسح جلسة الجهاز. عمليات الإدارة المؤجلة تبقى:
// تُرسل بعد الدخول التالي. (تطبيق العمال على نفس الجهاز لا يتأثر)
function logout(){
  const token = getAdminToken();
  if(token) apiCall('adminLogout', { token }, { silent:true }).catch(()=>{});
  _pendingUnlock = null; _lockOpts = null;
  clearAdminToken(); clearAdminDevice(); clearLocalCaches(CACHE_A);
  pushUnsubscribe();
  _adminVer = ''; _adminFullAt = 0; _adminSeen = null;
  showScreen('screen-admin-login');
}
// أزرار مشتركة في الصفحتين (شاشة القفل ونافذة «احمِ حسابك بقفل الهاتف»)
function unlockApp(userTap){ return adminUnlockApp(userTap); }
function enablePasskey(){ return adminEnableLock(); }
function passkeyLater(){
  try{ localStorage.setItem(ADMIN_PK_LATER, String(Date.now())); }catch(e){}
  setModal('passkeyModal', false);
}

/* =========================================================================
   الوجه من تطبيق الإدارة: فتح حساب عامل ببصمته، التقاط بصمة عامل موجود، والحضور الجماعي
   بكاميرا هذا الجهاز (الأمامية أو الخلفية). محرك الوجه (js/face.js) ونماذجه (~55MB) تُحمَّل عند أول فتح
   للكاميرا فقط وتُحفظ على الجهاز. التعرّف على الوجوه في الخادم: البصمات المحفوظة لا تصل للمتصفح
   ========================================================================= */
let _faceEngine = null;
// إيقاف الكاميرا (محرك الوجه قد لا يكون حُمّل بعد عند الإغلاق)
const stopCam = st => { if(st) st.getTracks().forEach(t => t.stop()); };
function loadFaceEngine(){
  if(!_faceEngine) _faceEngine = loadScript('js/face.js?v=' + APP_VERSION, () => typeof loadFaceModels === 'function', 'faceEngine')
    .then(() => loadFaceModels())
    .then(() => { if(!modelsReady) throw new Error('تعذر تجهيز نظام التعرف على الوجه — تحقق من الاتصال وحاول مجددًا'); })
    .catch(e => { _faceEngine = null; throw e; });
  return _faceEngine;
}
const ENGINE_WAIT = 'جاري تجهيز نظام التعرف على الوجه... (أول مرة على هذا الجهاز قد تستغرق دقيقة)';
// ينتظر محرك الوجه، ويعرض نسبة التنزيل في أول مرة على هذا الجهاز (faceLoadingMsg من face.js بعد تحميله)
async function waitFaceEngine(st){
  st.textContent = ENGINE_WAIT;
  const t = setInterval(() => { if(typeof faceLoadingMsg === 'function' && !modelsReady) st.textContent = faceLoadingMsg(); }, 400);
  try{ await loadFaceEngine(); }finally{ clearInterval(t); }
}
// الكاميرا المختارة لكل نافذة (أمامية user أو خلفية environment) — تُحفظ على هذا الجهاز. الافتراضي الخلفية:
// المدير يوجّه هاتفه للعامل (والحاسوب بلا كاميرا خلفية يستخدم كاميرته الوحيدة تلقائيًا)
const CAM_KEY = 'hudurak_admin_cam';
function camFacing(k){ try{ return JSON.parse(localStorage.getItem(CAM_KEY) || '{}')[k] || 'environment'; }catch(e){ return 'environment'; } }
function setCamFacing(k, v){ try{ const o = JSON.parse(localStorage.getItem(CAM_KEY) || '{}'); o[k] = v; localStorage.setItem(CAM_KEY, JSON.stringify(o)); }catch(e){} }
async function flipAdminCamera(k){
  setCamFacing(k, camFacing(k) === 'user' ? 'environment' : 'user');
  if(k === 'afm' && _afm){ await startAdminFaceCamera(); }
  if(k === 'grp' && _grp){
    stopCam(_grp.stream);
    _grp.stream = await startCamera($id('grpVideo'), $id('grpStatus'), 'وجّه الكاميرا للعمال', camFacing('grp'), true);
  }
}

/* ---------- فتح حساب عامل ببصمته، أو التقاط بصمة عامل موجود ---------- */
let _afm = null; // { mode: 'create' | 'enroll', workerId, stream, loop, descriptors }
async function openAdminFace(mode, workerId){
  const w = workerId ? loadWorkers().find(x => x.id === workerId) : null;
  if(mode === 'enroll' && !w) return;
  _afm = { mode, workerId: w ? w.id : '', stream: null, loop: 0, descriptors: null };
  $id('afmTitle').textContent = mode === 'create' ? 'إضافة عامل' : 'بصمة وجه «' + w.name + '»';
  $id('afmSub').textContent = mode === 'create' ? 'بيانات العامل ثم بصمة وجهه بكاميرا هذا الجهاز — الحساب يُفتح نشطًا فورًا'
    : 'تحل البصمة الجديدة محل كل بصمات العامل السابقة';
  $id('afmForm').classList.toggle('hidden', mode !== 'create');
  if(mode === 'create'){
    ['afmName', 'afmPhone', 'afmWage'].forEach(id => { $id(id).value = ''; });
    $id('afmProfession').innerHTML = '<option value="">اختر المهنة</option>' + PROFESSIONS.map(p => `<option>${escapeHtml(p)}</option>`).join('');
  }
  const save = $id('afmSave');
  save.disabled = true; save.textContent = mode === 'create' ? 'حفظ وفتح الحساب' : 'حفظ البصمة';
  $id('afmVideo').closest('.cam-wrap').classList.remove('face-on', 'face-ok', 'face-bad');
  setModal('adminFaceModal', true);
  await startAdminFaceCamera();
}
async function startAdminFaceCamera(){
  const a = _afm, st = $id('afmStatus');
  if(!a) return;
  try{ await waitFaceEngine(st); }catch(e){ st.textContent = e.message; return; }
  if(_afm !== a) return;
  stopCam(a.stream);
  a.stream = await startCamera($id('afmVideo'), st, 'وجّه الكاميرا لوجه العامل', camFacing('afm'));
  if(_afm === a && a.stream && !a.descriptors) runAdminCapture();
}
// نفس التقاط تسجيل العامل من هاتفه: 3 لقطات أمامية ثم إدارة الرأس لجانب ثم للآخر
async function runAdminCapture(){
  const a = _afm;
  if(!a) return;
  const my = ++a.loop, video = $id('afmVideo'), st = $id('afmStatus'), wrap = video.closest('.cam-wrap');
  a.descriptors = null; $id('afmSave').disabled = true; wrap.classList.remove('face-ok', 'face-bad');
  const res = await captureEnrollment(video, st, () => _afm === a && a.loop === my && !!a.stream);
  if(_afm !== a || a.loop !== my || !res) return;
  if(res.error){ st.textContent = res.error + ' — اضغط «إعادة الالتقاط»'; wrap.classList.add('face-bad'); return; }
  a.descriptors = res.descriptors;
  wrap.classList.add('face-ok');
  st.textContent = 'تم التقاط البصمة ✓ — ' + (a.mode === 'create' ? 'أكمل البيانات ثم اضغط «حفظ وفتح الحساب»' : 'اضغط «حفظ البصمة»');
  $id('afmSave').disabled = false;
}
function restartAdminFace(){ if(_afm && _afm.stream) runAdminCapture(); else startAdminFaceCamera(); }
function closeAdminFace(){
  if(_afm){ _afm.loop++; stopCam(_afm.stream); }
  _afm = null;
  $id('afmVideo').srcObject = null;
  setModal('adminFaceModal', false);
}
async function saveAdminFace(force){
  const a = _afm;
  if(!a || !a.descriptors) return;
  const data = { token: getAdminToken(), descriptors: a.descriptors, fm: FACE_MODEL, since: _adminVer, delta: 1 };
  if(force) data.force = true;
  if(a.mode === 'create'){
    const name = cleanName($id('afmName').value), phone = normalizePhone($id('afmPhone').value);
    const profession = $id('afmProfession').value, wage = money(parseFloat($id('afmWage').value));
    if(!validFullName(name)){ fieldError('afmName'); return toast('اكتب اسم العامل الثنائي على الأقل بالحروف فقط'); }
    if(!phone){ fieldError('afmPhone'); return toast('أدخل رقم هاتف صحيحًا'); }
    if(!PROFESSIONS.includes(profession)){ fieldError('afmProfession'); return toast('اختر المهنة'); }
    if(!(wage > 0)){ fieldError('afmWage'); return toast('أدخل قيمة اليومية'); }
    Object.assign(data, { name, phone, profession, wage });
  }else data.workerId = a.workerId;
  const btn = $id('afmSave');
  btn.disabled = true;
  try{ await apiCall(a.mode === 'create' ? 'adminCreateWorker' : 'adminEnrollFace', data); }
  catch(e){
    btn.disabled = false;
    if(/غير مصرح/.test(e.message)){ closeAdminFace(); adminSessionLost(); return; }
    // وجه مطابق لعامل مسجل: يُحفظ فقط بتأكيد صريح أنه شخص آخر
    if(!force && /الوجه مطابق للعامل/.test(e.message) && confirm(e.message + '\n\nهل هو شخص آخر فعلًا وتريد المتابعة؟')) return saveAdminFace(true);
    toast(e.message); return;
  }
  toast(a.mode === 'create' ? 'تم فتح حساب العامل ✓ — يدخل من هاتفه برقمه واسمه، ويصلك طلب جهازه لتعتمده' : 'تم حفظ بصمة الوجه الجديدة ✓');
  closeAdminFace();
  drawAdmin();
}

/* ---------- الحضور الجماعي ----------
   كل وجه أمام الكاميرا (حتى 6 معًا) يُتابَع بين اللقطات: لقطتان متتاليتان واضحتان لنفس الوجه تُرسلان للخادم الذي
   يتعرّف عليه بين كل العمال ويسجّل حضوره اليوم معتمدًا (أو «مسجّل سابقًا»). الوجه المعروف لا يُرسل مرة أخرى
   ما دام أمام الكاميرا (10 دقائق)، والوجه غير المعروف يُعاد بعد ثوانٍ. على الصورة: إطار واسم كل وجه */
const GRP_MAX_FACES = 6, GRP_MIN_W = 0.06, GRP_MAX_YAW = 30, GRP_DONE_MS = 10 * 60e3, GRP_RETRY_MS = 4000, GRP_LOST_MS = 2500, GRP_INFLIGHT = 2;
let _grp = null; // { stream, loop, tracks, ids, done, inflight }
async function openGroupCheckin(){
  _grp = { stream: null, loop: 0, tracks: [], ids: {}, done: 0, inflight: 0 };
  $id('grpList').innerHTML = '<p class="grp-empty">من يُتعرَّف عليه يظهر هنا</p>';
  $id('grpCount').textContent = '0 حضور';
  setModal('groupModal', true);
  const g = _grp, st = $id('grpStatus');
  try{ await waitFaceEngine(st); }catch(e){ st.textContent = e.message; return; }
  if(_grp !== g) return;
  g.stream = await startCamera($id('grpVideo'), st, 'وجّه الكاميرا للعمال', camFacing('grp'), true);
  if(_grp === g && g.stream) groupLoop();
}
function closeGroupCheckin(){
  const had = !!_grp;
  if(_grp){ _grp.loop++; stopCam(_grp.stream); }
  _grp = null;
  $id('grpVideo').srcObject = null;
  const cv = $id('grpOverlay'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  setModal('groupModal', false);
  if(had) backgroundSync(true); // الحضور المسجّل يظهر في اللوحة
}
// أقرب متابعة لهذا الوجه (نفس الشخص بين لقطتين)، أو متابعة جديدة
function groupTrack(g, d, now){
  let t = null, best = FACE_SIM_STEADY;
  g.tracks.forEach(x => { const s = faceSim(x.d, d); if(s > best){ best = s; t = x; } });
  if(!t){ t = { d, prev: null, n: 0, state: 'new', name: '', until: 0, seen: now }; g.tracks.push(t); }
  t.prev = t.d; t.d = d; t.n++; t.seen = now;
  return t;
}
/* السرعة (2.20): 1) بصمات وجوه اللقطة تُحسب في الخيط الخلفي أثناء كشف الوجوه في اللقطة التالية (لا انتظار بينهما)،
   فتظهر الإطارات متأخرة لقطة واحدة فقط. 2) كل الوجوه الجاهزة تُرسل للخادم في طلب واحد (faces) بدل طلب لكل وجه —
   رحلة خادم Google وحدها ثانيتان أو أكثر */
async function groupLoop(){
  const g = _grp;
  if(!g) return;
  const my = ++g.loop, video = $id('grpVideo');
  const alive = () => _grp === g && g.loop === my && !!g.stream;
  let prev = null; // اللقطة السابقة: وجوهها وبصماتها (قيد الحساب في الخيط الخلفي)
  while(alive()){
    if(!modelsReady || video.readyState < 2 || !video.videoWidth){ await sleep(200); continue; }
    let faces = [];
    try{ faces = await analyzeFaces(video, GRP_MAX_FACES); }catch(e){}
    if(!alive()) return;
    const W = video.videoWidth;
    // البصمة تُنسخ من لوحة الوجه لحظة الطلب (اللوحات تُعاد في التحليل التالي)، وتُحسب في الخلفية
    const cur = { now: Date.now(), faces, ds: Promise.all(faces.map(f =>
      f.box.width / W >= GRP_MIN_W && f.score >= AUTO_MIN_SCORE && Math.abs(f.yaw) <= GRP_MAX_YAW ? faceEmbed(f.frame, f.mesh).catch(() => null) : null)) };
    if(prev) groupFrame(g, video, prev.faces, await prev.ds, prev.now);
    if(!alive()) return;
    prev = cur;
    await sleep(30);
  }
}
// وجوه لقطة واحدة وبصماتها: المتابعة بين اللقطات، الإرسال، والرسم فوق الفيديو
function groupFrame(g, video, faces, ds, now){
  const W = video.videoWidth, marks = [];
  let small = 0;
  faces.forEach((f, i) => {
    if(f.box.width / W < GRP_MIN_W) small++;
    marks.push({ box: f.tight, t: ds[i] ? groupTrack(g, ds[i], now) : null });
  });
  g.tracks = g.tracks.filter(t => now - t.seen < (t.state === 'done' ? GRP_DONE_MS : GRP_LOST_MS));
  const ready = g.tracks.filter(t => t.n >= 2 && t.prev && (t.state === 'new' || (t.state === 'unknown' && now > t.until)));
  if(ready.length && g.inflight < GRP_INFLIGHT) sendGroupFaces(g, ready.slice(0, GRP_MAX_FACES));
  drawGroupOverlay(video, marks);
  $id('grpStatus').textContent = !faces.length ? 'لا وجوه أمام الكاميرا — وجّهها للعمال'
    : small === faces.length ? 'الوجوه بعيدة — اقترب قليلًا' : faces.length + (faces.length === 1 ? ' وجه' : ' وجوه') + ' أمام الكاميرا';
}
// الوجوه الجاهزة كلها في طلب واحد. descriptors (الوجه الأول) لخادم أقدم من 2.14 يعرف وجهًا واحدًا فقط:
// يرد بنتيجته وحده، والبقية تُرسل في الدفعة التالية
async function sendGroupFaces(g, ts){
  ts.forEach(t => t.state = 'sending'); g.inflight++;
  let r;
  try{ r = await apiCall('adminGroupCheckin', { token: getAdminToken(), fm: FACE_MODEL, faces: ts.map(t => [t.prev, t.d]), descriptors: [ts[0].prev, ts[0].d] }, { silent: true }); }
  catch(e){
    g.inflight--;
    if(_grp !== g) return;
    if(/غير مصرح/.test(e.message)){ closeGroupCheckin(); adminSessionLost(); return; }
    ts.forEach(t => { t.state = 'unknown'; t.until = Date.now() + (e.net ? 2500 : GRP_RETRY_MS); t.n = 0; });
    $id('grpStatus').textContent = e.net ? 'لا اتصال بالخادم — يُعاد تلقائيًا' : e.message;
    return;
  }
  g.inflight--;
  if(_grp !== g) return;
  const results = Array.isArray(r.results) ? r.results : [r];
  ts.forEach((t, i) => {
    const x = results[i];
    if(!x){ t.state = 'new'; return; } // لم يعالجه خادم أقدم: في الدفعة التالية
    if(x.status === 'ok' || x.status === 'already'){ t.state = 'done'; t.name = x.name; addGroupResult(g, x); }
    else{ t.state = 'unknown'; t.until = Date.now() + GRP_RETRY_MS; t.n = 0; }
  });
}
function addGroupResult(g, r){
  if(g.ids[r.workerId]) return; // نفس العامل من متابعة أخرى
  g.ids[r.workerId] = 1;
  if(r.status === 'ok'){ g.done++; try{ navigator.vibrate && navigator.vibrate(60); }catch(e){} }
  $id('grpCount').textContent = g.done + ' حضور';
  const list = $id('grpList'), empty = list.querySelector('.grp-empty');
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'grp-row' + (r.status === 'ok' ? ' ok' : '');
  row.innerHTML = `<span class="grp-ic">${icon(r.status === 'ok' ? 'check' : 'clock')}</span><div><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.profession || '')}</small></div>
    <span class="pill ${r.status === 'ok' ? 'pill-approved' : 'pill-pending'}">${r.status === 'ok' ? 'سُجّل ' + escapeHtml(r.time || '') : 'مسجّل اليوم سابقًا'}</span>`;
  list.prepend(row);
}
// إطار حول كل وجه واسمه: أخضر معروف، ذهبي قيد التعرّف، أحمر غير معروف. الفيديو بلا قص (contain) والمرآة للأمامية
function drawGroupOverlay(video, marks){
  const cv = $id('grpOverlay'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if(cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)){ cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const g = cv.getContext('2d'), vw = video.videoWidth, vh = video.videoHeight;
  g.clearRect(0, 0, cv.width, cv.height);
  if(!vw || !vh) return;
  const k = Math.min(cv.width / vw, cv.height / vh), ox = (cv.width - vw * k) / 2, oy = (cv.height - vh * k) / 2;
  const mirror = !video.classList.contains('cam-rear');
  g.lineWidth = 3 * dpr; g.font = `700 ${14 * dpr}px Tajawal, Tahoma, sans-serif`; g.textBaseline = 'bottom';
  g.direction = 'rtl'; g.textAlign = 'right'; // الأسماء العربية من اليمين داخل شريطها
  marks.forEach(({ box, t }) => {
    let x = ox + box.x * k; const y = oy + box.y * k, w = box.width * k, h = box.height * k;
    if(mirror) x = cv.width - x - w;
    const st = t ? t.state : 'new';
    const color = st === 'done' ? '#3ecf8e' : st === 'unknown' ? '#e0675a' : '#e7ad4f';
    const label = st === 'done' ? t.name : st === 'unknown' ? 'غير معروف' : st === 'sending' ? 'جاري التعرّف...' : '';
    g.strokeStyle = color; g.strokeRect(x, y, w, h);
    if(label){
      const bw = Math.max(g.measureText(label).width + 14 * dpr, w), th = 24 * dpr, by = Math.max(0, y - th);
      g.fillStyle = color; g.fillRect(x + w - bw, by, bw, th); // الشريط يبدأ من حافة الإطار اليمنى
      g.fillStyle = '#0d1030'; g.fillText(label, x + w - 7 * dpr, by + th - 5 * dpr);
    }
  });
}

/* ---------- خطافات core.js ---------- */
function roleOnResponse(res){
  // بيانات اللوحة مرفقة بالرد تُغني عن طلب ثانٍ. أثناء عمليات فورية متداخلة نؤجل تطبيقها
  // (رد عملية سابقة قد يصل بعد التعديل الفوري لعملية لاحقة فيُظهر حالة قديمة لحظيًا)
  if(res.admin){ if(_adminOps){ _lastAdmin = res.admin; } else { _adminFresh = applyAdminData(res.admin); } }
}
function roleOutboxAuth(){ const token = getAdminToken(); return token ? { token, since: _adminVer, delta: 1 } : null; }
function roleOutboxDone(it, res, err){
  if(err){ toast(err === 'expired' ? 'لم تصل عملية للخادم لانقطاع الاتصال طويلًا — أعد تنفيذها' : err); _adminVer = ''; }
  if(visibleScreen() === 'screen-admin'){ if(res && res.admin) redrawAdminSafely(); else backgroundSync(true); }
}
function roleShowScreen(id){
  if(id !== 'screen-admin'){ if(_afm) closeAdminFace(); if(_grp) closeGroupCheckin(); } // قفل/خروج: لا تبقى الكاميرا تعمل
  if(id === 'screen-admin-login'){ showAdminLoginError(''); renderAdminLoginForm(); prepareAdminLogin(); } // يعرف: إنشاء الحساب أم دخول
  if(id !== 'screen-admin') setModal('securityModal', false);
}
async function roleSync(scr){ if(scr === 'screen-admin' && getAdminToken()) await syncAdmin(); }
function roleForceRefresh(){ _adminVer = ''; }
function roleRelock(){ if(adminLockOn() && visibleScreen() === 'screen-admin') lockAdmin(true); }
function roleNotify(){} // إشعارات الإدارة لا تُحفظ في مركز إشعارات
async function roleInit(handoff, updated){
  // من المتصفح وغير مثبّت: شاشة التثبيت أولًا — لا دخول ولا لوحة قبل التثبيت
  if(window.InstallGate && InstallGate.required()){ Splash.hide(); InstallGate.show(); return; }
  // بلا نماذج وجه. جلسة الإدارة تخص هذا التطبيق وحده: جهاز مسجّل = شاشة القفل ونافذة البصمة تلقائيًا، وإلا نموذج الدخول
  if(handoff && handoff.admin){
    setAdminToken(handoff.admin); updateAdminExit();
    const cached = readLocalCache(CACHE_A);
    if(cached) applyAdminData(cached);
    showScreen('screen-admin'); drawAdmin(); Splash.hide(); updated();
    renderAdmin(); // تحديث البيانات (وإن انتهت الجلسة: شاشة القفل)
    return;
  }
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
      Splash.show('جاري تحميل بيانات الإدارة...'); Splash.set(40);
      try{ await refreshAdminData(); }catch(e){} // الجلسة مرفوضة: تنتقل هي لشاشة الدخول
      if(getAdminToken()){ showScreen('screen-admin'); drawAdmin(); setTimeout(offerAdminLock, 1200); }
      Splash.hide();
    }
    return;
  }
  showScreen('screen-admin-login'); Splash.hide();
}
