/* =========================================================================
   تطبيق العمال (app.html) — يُحمَّل بعد core.js: الدخول برقم الهاتف، التسجيل ببصمة الوجه، الحضور،
   لوحة العامل، الفتح بقفل الهاتف، ومركز الإشعارات. «الخطافات» التي يستدعيها core.js في آخر الملف.
   ========================================================================= */
let _workerPrefetch = null;  // بيانات لوحة العامل وصلت مرفقة مع آخر رد
// محرك الوجه في js/face.js (يُحمَّل قبل هذا الملف): النماذج تُجهَّز فور فتح التطبيق
window.addEventListener('load', () => ensureFaceModels(), { once:true });

/* =========================================================================
   تسجيل الدخول — رقم الهاتف + بصمة الجهاز
   ========================================================================= */
let pendingProfile = null; // {phone, name}


let _loggingIn = false;
async function continueWithPhone(){
  if(_loggingIn) return;
  const phone = normalizePhone($id('loginPhone').value);
  const name = cleanName($id('loginName').value);
  if(!phone){ toast('أدخل رقم هاتف صحيحًا'); fieldError('loginPhone'); return; }
  if(name && !validFullName(name)){ toast('اكتب اسمك الثنائي على الأقل بالحروف فقط'); fieldError('loginName'); return; }
  _loggingIn = true;
  const btn = $id('loginBtn');
  btn.classList.add('is-busy');
  try{ await routeAfterLogin(phone, name); } finally { _loggingIn = false; btn.classList.remove('is-busy'); }
}

async function routeAfterLogin(phone, name){
  const deviceId = getDeviceId();
  let res;
  try{
    res = await apiCall('checkPhone', { phone, deviceId, name, userAgent: navigator.userAgent, device: await deviceInfo(), session: getWorkerSession() });
  }catch(error){ toast(error.message); return; }

  if(!res.exists){
    if(!validFullName(name)){ toast('رقم جديد: اكتب اسمك الكامل (الثنائي على الأقل) ثم اضغط المتابعة'); fieldError('loginName'); return; }
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

/* ---------- التحقق المحلي من الوجه عند الحضور ----------
   هاتف العامل يحفظ لقطات وجهه هو فقط (من تسجيله، أو من أول حضور قبله الخادم) — لا تصل من الخادم أبدًا.
   عند الحضور تُقارن اللقطة بها على الهاتف فورًا: غير مطابق = رد فوري بلا انتظار الخادم، ومطابق = قبول فوري
   على الشاشة والخادم يتحقق من جديد (هو الحكم النهائي) في الخلفية. بنفس حدود الخادم تمامًا. */
const LOCAL_FACE_TRIES = 3;
const faceKey = () => currentPhone ? 'hudurak_sface_' + phoneKeyOf(currentPhone) : '';
function localFaceRefs(){
  try{ const k = faceKey(), v = k && JSON.parse(localStorage.getItem(k) || 'null'); return Array.isArray(v) && v.length ? v : null; }
  catch(e){ return null; }
}
// replace: تحديث المرجع (الخادم قبل وجهًا رفضه المرجع المحلي — تغيّر المظهر أو الإضاءة)
function rememberFace(descs, replace){
  const k = faceKey();
  if(!k || !Array.isArray(descs) || !descs.length || (!replace && localFaceRefs())) return;
  try{ localStorage.setItem(k, JSON.stringify(descs.slice(0, 6).map(d => d.map(x => Math.round(x * 1e4) / 1e4)))); }catch(e){}
}
const forgetLocalFace = () => { try{ const k = faceKey(); if(k) localStorage.removeItem(k); }catch(e){} };
// قرار المطابقة: كل لقطة تُقارن بأقرب بصمة مرجعية
function faceMatches(descs, refs){
  const s = descs.map(p => Math.max.apply(null, refs.map(r => faceSim(p, r))));
  return s.reduce((a, x) => a + x, 0) / s.length >= FACE_SIM_AVG && Math.min.apply(null, s) >= FACE_SIM_MIN;
}
// true مطابق، false غير مطابق، null لا توجد نسخة محلية
function localFaceCheck(descs){
  const refs = localFaceRefs();
  return refs ? faceMatches(descs, refs) : null;
}
let _regLoopId = 0;
async function startRegisterCamera(){
  regStream = await startCamera(
    $id('regVideo'),
    $id('regCamStatus'),
    'ضع وجهك داخل الدائرة وانظر للكاميرا — سيتم الالتقاط تلقائيًا');
  if(regStream) autoRegisterLoop();
}

// التقاط تلقائي للبصمة المرجعية فور ظهور الوجه بوضوح، دون ضغط أي زر (الزر يعيد الالتقاط من البداية)
async function autoRegisterLoop(){
  const my = ++_regLoopId;
  const video = $id('regVideo'), status = $id('regCamStatus');
  const res = await captureEnrollment(video, status, () => my === _regLoopId && !!regStream && !capturedDescriptors);
  if(!res || my !== _regLoopId) return;
  if(res.error){
    status.textContent = res.error + '، سيُعاد تلقائيًا';
    setTimeout(() => { if(my === _regLoopId && regStream) autoRegisterLoop(); }, 1500);
    return;
  }
  capturedDescriptors = res.descriptors; // الخادم يحفظها كلها + متوسط الأمامية كبصمات مرجعية
  _regLoopId++;
  status.textContent = 'تم بنجاح ✓';
  stopStream(regStream);
  $id('regStep1').classList.add('hidden');
  $id('regStep2').classList.remove('hidden');
  $id('stepDot2').classList.add('active');
}

async function captureRegistrationFace(){
  if(!regStream){ await startRegisterCamera(); return; }
  autoRegisterLoop();
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
      descriptors: capturedDescriptors, fm: FACE_MODEL, // كل اللقطات: الخادم يحفظها ومتوسط الأمامية كبصمات مرجعية
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

/* ---------- صفحة الحساب: حركة الأرقام (المظهر الداكن/النهاري في core.js) ---------- */
// الأرقام تعدّ من قيمتها السابقة إلى الجديدة فقط عند تغيّر حقيقي والعامل ينظر للصفحة (اعتماد حضور، سلفة...).
// القيمة النهائية مباشرة: أول عرض، التطبيق في الخلفية أو الشاشة مطفأة، شاشة البداية/القفل —
// (كان العدّ يبدأ والتطبيق مخفي فيتجمد المتصفح في منتصفه، ثم يكمل أمام العامل «وحده» بقيم مثل 193.17 و 0.97 يوم)
const _countTweens = new Set();
function countTo(el, value){
  const to = money(value), from = el._v === undefined ? to : el._v;
  el._v = to;
  if(el._tw){ el._tw.kill(); _countTweens.delete(el._tw); el._tw = null; }
  if(from === to || !window.gsap || _reduceMotion() || document.hidden || document.documentElement.classList.contains('scroll-lock')){
    el.textContent = fmt(to); return;
  }
  const o = { v: from }, whole = Number.isInteger(from) && Number.isInteger(to); // الأيام والمبالغ الصحيحة بخطوات صحيحة
  const tw = gsap.to(o, { v: to, duration: .9, ease: 'power2.out',
    onUpdate: () => { el.textContent = fmt(whole ? Math.round(o.v) : Math.round(o.v * 100) / 100); },
    onComplete: () => { el.textContent = fmt(to); el._tw = null; _countTweens.delete(tw); } });
  el._tw = tw; _countTweens.add(tw);
}
// التطبيق يُخفى أثناء العدّ: يكتمل فورًا (لا يبقى رقم وسيط يكمل عند العودة)
document.addEventListener('visibilitychange', () => { if(document.hidden) [..._countTweens].forEach(tw => tw.progress(1)); });
function replayAnim(el, cls){
  if(!el) return;
  el.classList.remove(cls); void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/* ---------- أقسام صفحة الحساب: شريط سفلي ثابت (الرئيسية، سجلي، الإشعارات، حسابي) ---------- */
let _wTab = 'home';
function wTab(t, quiet){
  const changed = t !== _wTab;
  _wTab = t;
  document.querySelectorAll('.w-pane').forEach(p => {
    const on = p.dataset.tab === t;
    p.classList.toggle('hidden', !on);
    if(on && changed && !quiet) replayAnim(p, 'w-anim'); // ظهور خفيف عند تغيير القسم بلمسة العامل فقط
  });
  document.querySelectorAll('.w-tab').forEach(b => {
    const on = b.dataset.tab === t;
    b.classList.toggle('on', on);
    if(on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if(t === 'inbox'){ _inboxFilter = 'all'; renderInbox(); updateInboxBadge(); }
  if(changed) window.scrollTo(0, 0);
}

/* ---------- النوافذ الصاعدة من الأسفل (الهاتف): سحبها للأسفل يغلقها ----------
   للنوافذ التي يمكن إغلاقها فقط؛ التصفية ورسالة الإدارة وقفل الهاتف تبقى حتى يضغط العامل زرها */
const SHEET_CLOSE = { aboutModal: () => closeAbout(), faceModal: () => closeFaceModal(), notifModal: () => notifModalLater(), gpsModal: () => gpsModalLater() };
(function(){
  let card = null, id = '', y0 = 0, dy = 0;
  const phone = () => !(window.matchMedia && matchMedia('(min-width: 601px)').matches);
  document.addEventListener('touchstart', e => {
    const c = e.target.closest && e.target.closest('[id$="Modal"] > .card');
    card = null;
    if(!c || !phone() || !SHEET_CLOSE[c.parentElement.id] || c.scrollTop > 0 || e.touches.length !== 1) return;
    card = c; id = c.parentElement.id; y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if(!card) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    card.style.transition = 'none'; card.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if(!card) return;
    const c = card, close = dy > 110; card = null;
    c.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    c.style.transform = close ? 'translateY(110%)' : '';
    setTimeout(() => { c.style.transition = ''; c.style.transform = ''; if(close) SHEET_CLOSE[id](); }, close ? 220 : 240);
  });
})();

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
    try{ data = await apiCall('getWorkerData', workerAuth(), { silent: true }); } // بلا شريط التحميل: الصفحة ثابتة
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
  // رسائل الإدارة: من الخادم إن وصلت معه، وإلا من النسخة المحلية (تبقى أمامه بلا إنترنت حتى «تم»)
  const cachedMsgs = (readLocalCache(CACHE_W) || {}).messages;
  setMessages(data.messages !== undefined ? data.messages : cachedMsgs || _messages);
  saveLocalCache(CACHE_W, { phone: currentPhone, worker: data.worker, log: allLog, advances, passkey: _hasPasskey, messages: _messages });

  const month = monthStr();
  const approvedThisMonth = log.filter(r=>r.status==='approved' && r.date.startsWith(month));
  countTo($id('stApprovedDays'), approvedThisMonth.length);
  countTo($id('stMonthEarn'), approvedThisMonth.reduce((sum,r)=> sum + recordWage(r, currentWorker), 0));
  $id('pfWage').textContent = fmt(currentWorker.wage);
  renderWorkerMoney(currentWorker, log, advances);

  const todays = allLog.find(r=>r.date===todayStr()); // حضور اليوم ولو سبق تصفيةً تمت اليوم (لا يُسجَّل مرتين)
  const statusMap = {pending:'بانتظار الموافقة', approved:'تم اعتماد الحضور', rejected:'تم رفض الحضور', queued:'يُرسل تلقائيًا عند عودة الاتصال'};
  $id('stTodayStatus').textContent = todays ? statusMap[todays.status] : 'لم يسجل بعد';
  $id('wTodayChip').dataset.s = todays ? todays.status : 'none'; // لون الشارة حسب الحالة
  try{ $id('wToday').textContent = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh' }).format(new Date()); }catch(e){}

  const checkinBtn = $id('checkinBtn');
  const title = $id('checkinTitle');
  const sub = $id('checkinSub');
  // زر أخضر بعلامة ✓ بعد التسجيل، وينبثق مرة واحدة فقط لحظة التسجيل (لا عند كل فتح أو مزامنة)
  const done = !!todays && todays.status !== 'rejected';
  if(done && _heroDone === false){
    checkinBtn.classList.remove('just-done'); void checkinBtn.offsetWidth;
    checkinBtn.classList.add('just-done');
    checkinBtn.addEventListener('animationend', () => checkinBtn.classList.remove('just-done'), { once: true });
  }
  _heroDone = done;
  checkinBtn.classList.toggle('is-done', done);
  if(todays){
    checkinBtn.style.opacity = done ? 1 : .5;
    checkinBtn.onclick = ()=>toast('تم تسجيل حضورك اليوم بالفعل');
    title.textContent = 'تم تسجيل الحضور اليوم';
    sub.textContent = statusMap[todays.status];
  }else{
    checkinBtn.style.opacity = 1;
    checkinBtn.onclick = openFaceModal;
    title.textContent = 'تسجيل الحضور اليوم';
    sub.textContent = 'اضغط الزر وسيتم التحقق من وجهك تلقائيًا' + checkinRulesHint();
  }

  const sorted = [...log].sort((a,b)=> b.timestamp - a.timestamp);
  renderRows('workerLogBody','workerLogEmpty', sorted, r=>
    `<tr><td data-label="التاريخ">${escapeHtml(r.date)}</td><td data-label="الوقت">${escapeHtml(r.time)}</td><td data-label="الحالة"><span class="pill pill-${escapeHtml(r.status)}">${statusMap[r.status]}</span></td></tr>`);
  // (النسخة المحلية عند الفتح لا تحمل التصفية: لا نُخفي نافذة ظاهرة بسببها — الرد الحقيقي من الخادم هو الحكم)
  if(data.settlement !== undefined) showSettlement(data.settlement);
  workerPrompts(); // رسالة من الإدارة، تفعيل القفل، إذن الإشعارات، أو «أعد المحاولة» من إشعار الحضور
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

/* ---------- رسائل الإدارة: نافذة تبقى حتى يضغط العامل «تم» ----------
   حالتها في الخادم (تظهر على أي جهاز معتمد حتى «تم»)، ونسخة منها مع النسخة المحلية فتظهر بلا إنترنت أيضًا.
   ظهورها يُبلَّغ للخادم فترى الإدارة «وصلت»، و«تم» يُرسل فورًا (أو يُحفظ في صندوق الإرسال بلا اتصال) */
let _messages = [], _msgSeenSent = {};
// «تم» محفوظ في صندوق الإرسال ولم يصل الخادم بعد: لا تعود نافذته من بيانات أقدم منه
function pendingMsgDone(){
  const s = {};
  outboxLoad().forEach(i => { if(i.action === 'messageAck' && i.data && i.data.done) (i.data.ids || []).forEach(id => s[id] = 1); });
  return s;
}
function setMessages(list){
  const done = pendingMsgDone();
  _messages = (Array.isArray(list) ? list : []).filter(m => m && m.id && !done[m.id]);
  _messages.forEach(m => inboxAdd('msg', m.title || 'رسالة من الإدارة', m.body, 'msg:' + m.id)); // مرجع دائم في مركز الإشعارات
  const cur = $id('msgModal').dataset.id; // حُذفت، أو ضغط «تم» عليها من جهاز آخر
  if(cur && !_messages.some(m => m.id === cur)){ setModal('msgModal', false); delete $id('msgModal').dataset.id; }
}
function showMessage(){
  const m = _messages[0];
  if(!m) return;
  const modal = $id('msgModal'), when = inboxTime(m.sentAt || Date.now());
  modal.dataset.id = m.id;
  $id('wmsgTitle').textContent = m.title || 'رسالة من الإدارة';
  $id('wmsgTime').textContent = when.day + ' — ' + when.time;
  $id('wmsgBody').textContent = m.body;
  $id('wmsgCount').textContent = _messages.length > 1 ? `1 من ${_messages.length} رسائل` : '';
  const btn = $id('wmsgOk'); btn.disabled = false;
  setModal('msgModal', true);
  if(!m.seen && !_msgSeenSent[m.id]){ _msgSeenSent[m.id] = 1; sendReliable('messageAck', workerAuth({ ids: [m.id] })).catch(() => {}); }
}
async function ackMessage(){
  const modal = $id('msgModal'), id = modal.dataset.id, btn = $id('wmsgOk');
  if(!id || btn.disabled) return;
  btn.disabled = true;
  // فوري على الشاشة وفي النسخة المحلية؛ الخادم يُبلَّغ في الخلفية
  _messages = _messages.filter(m => m.id !== id);
  const c = readLocalCache(CACHE_W);
  if(c && Array.isArray(c.messages)){ c.messages = c.messages.filter(m => m.id !== id); saveLocalCache(CACHE_W, c); }
  setModal('msgModal', false); delete modal.dataset.id;
  try{ await sendReliable('messageAck', workerAuth({ ids: [id], done: true })); }
  catch(error){ if(isLockedError(error)){ lockApp(); return; } toast(error.message); }
  workerPrompts();
}

/* ---------- نوافذ تظهر للعامل بالترتيب، واحدة في كل مرة ----------
   تصفية الحساب ← رسائل الإدارة ← إعادة تسجيل الوجه (إن سمحت بها الإدارة) ← قفل الهاتف (اختياري) ←
   تشغيل الموقع (إن اشترطته الإدارة) ← إذن الإشعارات */
const PROMPT_MODALS = ['settleModal', 'msgModal', 'passkeyModal', 'gpsModal', 'notifModal', 'aboutModal'];
const promptOpen = () => PROMPT_MODALS.some(id => { const m = $id(id); return m && !m.classList.contains('hidden'); });
const canPrompt = () => !!currentPhone && !_unlocking && ['screen-worker', 'screen-pending'].includes(visibleScreen())
  && $id('faceModal').classList.contains('hidden') && !promptOpen();
let _promptBusy = false;
async function workerPrompts(){
  retryCheckinIfAsked();
  if(_promptBusy || !canPrompt()) return;
  _promptBusy = true;
  try{
    if(_messages.length && visibleScreen() === 'screen-worker'){ showMessage(); return; }
    if(modelsReady && await offerFaceUpdate()) return;
    if(!_hasPasskey && !pkDeclined() && await passkeySupported()){ await offerPasskey(); return; }
    if(canPrompt() && await offerGps()) return;
    if(canPrompt()) offerNotifications();
  }finally{ _promptBusy = false; }
}
setInterval(workerPrompts, 3000);

/* ---------- تشغيل الموقع (GPS) عند فتح التطبيق ----------
   حين تشترط الإدارة موقع العمل للحضور: يُفحص الموقع عند كل فتح للتطبيق (وعند العودة إليه)، فإن كان مغلقًا أو
   غير مسموح تظهر نافذة تطلب تشغيله — قبل الحضور لا أثناءه. المتصفح لا يستطيع تشغيل GPS بنفسه، لكن طلب الموقع
   يُظهر نافذة النظام: إذن التطبيق، وفي أندرويد «شغّل الموقع» إن كان مغلقًا. «لاحقًا» يؤجلها 30 دقيقة */
const GPS_RECHECK = 10 * 60e3, GPS_LATER = 30 * 60e3;
let _gpsCheckedAt = 0, _gpsLaterAt = 0;
// عاد للتطبيق (مثلًا من إعدادات الهاتف بعد تشغيل الموقع): يُفحص من جديد، والنافذة المفتوحة تُغلق وحدها إن صار الموقع يعمل
document.addEventListener('visibilitychange', async () => {
  if(document.visibilityState !== 'visible') return;
  _gpsCheckedAt = 0;
  if($id('gpsModal').classList.contains('hidden') || $id('gpsModalYes').disabled) return;
  if(await gpsPermission() !== 'granted') return;
  const r = await gpsFix(8000, 0);
  if(r.ok && r.acc < GEO_APPROX && !$id('gpsModal').classList.contains('hidden')){ setModal('gpsModal', false); _gpsCheckedAt = Date.now(); toast('تم تشغيل الموقع ✓ يمكنك تسجيل الحضور'); }
});
const gpsNeeded = () => !!checkinRules().geo && visibleScreen() === 'screen-worker' && currentWorker && (currentWorker.status || 'active') === 'active';
// حالة إذن الموقع: granted / denied / prompt ('' إن لم يدعم المتصفح السؤال عنها)
async function gpsPermission(){
  try{ return (await navigator.permissions.query({ name: 'geolocation' })).state; }catch(e){ return ''; }
}
// قراءة موقع واحدة (code: 1 غير مسموح، 2 الموقع مغلق/لا إشارة، 3 انتهت المهلة)
const gpsFix = (timeout, maxAge) => new Promise(resolve => {
  if(!navigator.geolocation) return resolve({ code: 2 });
  navigator.geolocation.getCurrentPosition(p => resolve({ ok: true, acc: Math.round(p.coords.accuracy || 0) }),
    e => resolve({ code: e.code || 2 }), { enableHighAccuracy: true, timeout, maximumAge: maxAge });
});
const GPS_TEXT = {
  ask:    ['شغّل الموقع (GPS)', 'تسجيل الحضور يتطلب موقعك داخل موقع العمل. اضغط «تشغيل الموقع» ثم اختر «السماح» — وإن ظهرت نافذة تشغيل الموقع في الهاتف اضغط «موافق».', 'تشغيل الموقع'],
  off:    ['الموقع (GPS) مغلق', 'تسجيل الحضور يتطلب موقعك. شغّل الموقع: اسحب شريط الهاتف العلوي للأسفل ← اضغط «الموقع» (Location)، ثم اضغط «أعد المحاولة».', 'أعد المحاولة'],
  denied: ['الموقع غير مسموح للتطبيق', 'تسجيل الحضور يتطلب موقعك. للسماح به: الإعدادات ← التطبيقات ← UniGuard (أو المتصفح) ← الأذونات ← الموقع ← «السماح أثناء استخدام التطبيق»، ثم اضغط «أعد المحاولة».', 'أعد المحاولة'],
  precise:['فعّل «الموقع الدقيق»', 'هاتفك يعطي موقعًا تقريبيًا فقط (بفارق كيلومترات)، فلن يُقبل حضورك.\nأندرويد: الإعدادات ← التطبيقات ← Chrome (أو UniGuard) ← الأذونات ← الموقع ← «استخدام الموقع الدقيق».\nآيفون: الإعدادات ← الخصوصية والأمان ← خدمات الموقع ← Safari (أو UniGuard) ← «الموقع الدقيق».\nثم اضغط «أعد المحاولة».', 'أعد المحاولة']
};
function showGps(kind){
  const t = GPS_TEXT[kind];
  $id('gpsModalTitle').textContent = t[0]; $id('gpsModalText').textContent = t[1];
  const yes = $id('gpsModalYes'); yes.textContent = t[2]; yes.disabled = false;
  setModal('gpsModal', true);
}
// true = ظهرت النافذة. الفحص الصامت لا يُظهر أي نافذة نظام: إذن لم يُطلب بعد → نافذتنا تشرح أولًا ثم تطلبه
async function offerGps(){
  if(!gpsNeeded() || Date.now() - _gpsLaterAt < GPS_LATER || Date.now() - _gpsCheckedAt < GPS_RECHECK) return false;
  _gpsCheckedAt = Date.now();
  const perm = await gpsPermission();
  if(perm === 'denied'){ showGps('denied'); return true; }
  if(perm !== 'granted'){ showGps('ask'); return true; } // لم يُسأل بعد (أو متصفح لا يجيب): نافذتنا قبل نافذة النظام
  // مسموح: هل الموقع يعمل الآن فعلًا؟ (قراءة حديثة لا محفوظة: قراءة قديمة لا تعني أن GPS ما زال يعمل)
  const r = await gpsFix(8000, 0);
  // انتهاء المهلة (إشارة ضعيفة داخل مبنى) ليس «مغلقًا»: لا إزعاج — الحضور نفسه يشرح إن تعذر الموقع
  if((r.ok && r.acc < GEO_APPROX) || r.code === 3 || !gpsNeeded() || !canPrompt()) return false;
  // يعمل لكن «تقريبي» فقط، أو: الإذن ممنوح فالرفض هنا (1) أو عدم التوفر (2) = خدمة الموقع في الهاتف مغلقة
  showGps(r.ok ? 'precise' : 'off');
  return true;
}
async function gpsModalAllow(){
  const yes = $id('gpsModalYes');
  yes.disabled = true; yes.textContent = 'جاري تحديد موقعك...';
  const r = await gpsFix(15000, 0); // يُظهر إذن الموقع، وفي أندرويد نافذة «تشغيل الموقع» إن كان مغلقًا
  if(r.ok && r.acc >= GEO_APPROX) return showGps('precise');
  if(r.ok){ setModal('gpsModal', false); _gpsCheckedAt = Date.now(); toast('تم تشغيل الموقع ✓ يمكنك تسجيل الحضور'); return; }
  // رفض بينما إذن التطبيق ممنوح = خدمة الموقع في الهاتف مغلقة (هكذا تجيب بعض هواتف أندرويد)
  showGps(r.code === 1 && await gpsPermission() !== 'granted' ? 'denied' : 'off');
}
function gpsModalLater(){ setModal('gpsModal', false); _gpsLaterAt = Date.now(); }

// إذن الإشعارات: نافذة عند كل فتح حتى يسمح (أو «لاحقًا» لهذه الجلسة). محظورة: شرح السماح من الإعدادات (مرة في اليوم)
const NOTIF_LATER = 'hudurak_notif_later';
let _notifLater = false;
function offerNotifications(){
  if(_notifLater || !('Notification' in window) || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const p = Notification.permission;
  if(p === 'granted') return;
  if(p === 'denied'){ let t = 0; try{ t = Number(localStorage.getItem(NOTIF_LATER) || 0); }catch(e){} if(Date.now() - t < 24 * 3600e3) return; }
  const denied = p === 'denied';
  $id('notifModalTitle').textContent = denied ? 'الإشعارات محظورة على هاتفك' : 'فعّل الإشعارات';
  $id('notifModalText').textContent = denied
    ? 'لن تصلك رسائل الإدارة ولا تنبيهات الحضور. للسماح بها: افتح إعدادات الهاتف ← التطبيقات ← UniGuard (أو المتصفح) ← الإشعارات ← سماح، ثم أعد فتح التطبيق.'
    : 'لتصلك رسائل الإدارة، وتنبيه فوري إن لم يصل حضورك للخادم أو رُفضت بصمة وجهك، وموافقات الحضور والتصفية — حتى والتطبيق مغلق.';
  $id('notifModalYes').classList.toggle('hidden', denied);
  $id('notifModalNo').textContent = denied ? 'حسنًا' : 'لاحقًا';
  setModal('notifModal', true);
}
async function notifModalAllow(){ setModal('notifModal', false); _notifLater = true; await enableNotifications(); }
function notifModalLater(){
  setModal('notifModal', false); _notifLater = true;
  if('Notification' in window && Notification.permission === 'denied') try{ localStorage.setItem(NOTIF_LATER, String(Date.now())); }catch(e){}
}

// بطاقة إجمالي السلف + الرصيد الصافي + جدول السلف (نفس معادلة الخادم في التصفية)
function renderWorkerMoney(worker, log, advances){
  const since = Number(worker.lastSettledAt) || 0;
  const open = advances.filter(a => a.timestamp > since);
  const advTotal = money(open.reduce((s,a)=> s + a.amount, 0));
  const earned = money(log.filter(r => r.status==='approved' && r.timestamp > since).reduce((s,r)=> s + recordWage(r, worker), 0));
  const net = money(earned - advTotal);
  countTo($id('stAdvancesTotal'), advTotal);
  const last = [...open].sort((a,b)=> b.timestamp - a.timestamp)[0];
  // التاريخ معزول باتجاه LTR وفي سطر واحد: داخل نص عربي كان ينكسر ويظهر مقلوبًا («-2026» ثم «02-10») على الهواتف الصغيرة
  $id('stAdvancesSub').innerHTML = open.length
    ? `${open.length} سلفة — آخرها <bdi dir="ltr" style="white-space:nowrap">${escapeHtml(last.date)}</bdi>` : 'لا توجد سلف غير مصفّاة';
  const netEl = $id('stNetBalance');
  countTo(netEl, net);
  netEl.classList.toggle('neg', net < 0); // اللون من المظهر (داكن/نهاري)
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
  forgetLocalFace(); outboxSave([]);
  currentWorker = null;
  currentPhone = null;
  setWorkerSession(''); _hasPasskey = false;
  clearRememberedPhone();
  clearLocalCaches(CACHE_W); clearNext(PK_NEXT); clearNext(PK_CRED);
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
let _heroDone = null;      // حالة زر الحضور في آخر رسم (null = أول رسم بعد الفتح: بلا حركة)
const CAM_OK_MS = 650;     // مدة ظهور ✓ داخل الكاميرا قبل إغلاقها (رسمها يكتمل عند 540ms)

// حركة نتيجة التحقق داخل الكاميرا: ✓ ترتسم (ok) أو اهتزاز بحدود حمراء (bad)، مع اهتزاز الهاتف (أندرويد)
function camFeedback(kind){
  const w = $id('checkVideo').closest('.cam-wrap');
  w.classList.remove('face-on', 'face-ok', 'face-bad');
  void w.offsetWidth; // إعادة تشغيل الحركة إن تكررت النتيجة نفسها
  w.classList.add('face-' + kind);
  try{ if(navigator.vibrate) navigator.vibrate(kind === 'ok' ? 40 : [60, 50, 60]); }catch(e){}
  if(kind === 'bad') setTimeout(() => w.classList.remove('face-bad'), 700);
}
function camReset(){ $id('checkVideo').closest('.cam-wrap').classList.remove('face-on', 'face-ok', 'face-bad'); }

/* ---------- شروط الحضور التي تحددها الإدارة: وقت الحضور وموقع العمل ----------
   الخادم هو الحكم (وقته هو، وموقع الهاتف المرسل). الفحص هنا قبل فتح الكاميرا ليعرف العامل السبب فورًا،
   وموقع الهاتف يُرسل مع بصمة الوجه. الشروط تصل مع بيانات العامل وتُحفظ على الهاتف (تعمل بلا اتصال) */
const RULES_KEY = 'hudurak_checkin_rules';
const GEO_MAX_ACCURACY = 150, GEO_ACC_GRACE = 50; // نفس حدود الخادم
let _checkinLoc = null; // موقع الهاتف لحظة فتح نافذة الحضور
function checkinRules(){ try{ return JSON.parse(localStorage.getItem(RULES_KEY) || 'null') || {}; }catch(e){ return {}; } }
function storeCheckinRules(r){ try{ localStorage.setItem(RULES_KEY, JSON.stringify(r || {})); }catch(e){} }
function checkinRulesHint(){
  const r = checkinRules(), parts = [];
  if(r.time) parts.push('من ' + r.time.from + ' إلى ' + r.time.to);
  if(r.geo) parts.push('من داخل ' + (r.geo.label ? '«' + r.geo.label + '»' : 'موقع العمل'));
  return parts.length ? ' — متاح ' + parts.join(' ') : '';
}
// نفس منطق الخادم: تشمل دقيقتي البداية والنهاية، وتدعم الوقت الممتد بعد منتصف الليل
const inTimeWindow = (t, from, to) => from < to ? t >= from && t <= to : t >= from || t <= to;
function distanceM(a, b){
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/* «الموقع التقريبي»: أندرويد 12+ يعرض عند طلب الإذن خيار «تقريبي»، وفي الآيفون «الموقع الدقيق» قد يكون مطفأً.
   عندها تأتي القراءات بدقة ±1–3 كم مهما انتظرنا أو خرج العامل لمكان مكشوف — الحل الوحيد تفعيل الموقع الدقيق */
const GEO_APPROX = 1000;
const PRECISE_MSG = 'هاتفك يعطي «موقعًا تقريبيًا» فقط، وتسجيل الحضور يحتاج الموقع الدقيق.\n\n'
  + 'أندرويد: الإعدادات ← التطبيقات ← Chrome (أو UniGuard) ← الأذونات ← الموقع ← فعّل «استخدام الموقع الدقيق».\n'
  + 'آيفون: الإعدادات ← الخصوصية والأمان ← خدمات الموقع ← Safari (أو UniGuard) ← فعّل «الموقع الدقيق».\n\nثم أعد المحاولة.';
const GEO_OFF_MSG = 'تعذر تحديد موقعك — شغّل خدمة الموقع (GPS) من شريط الهاتف العلوي، ثم أعد المحاولة.';
/* أدق موقع خلال maxMs بلا انتظار زائد: أول قراءة غالبًا من الشبكة ثم تتحسن مع GPS.
   تُقبل فورًا عند ±30 م، وبعد 4 ثوانٍ عند ±60 م، وبعد 8 ثوانٍ عند حد القبول (±150 م).
   الموقع التقريبي (±1 كم فأكثر) يُعاد بعد 6 ثوانٍ لأنه لن يتحسن، والموقع المغلق يُبلَّغ بعد 6 ثوانٍ لا 20 */
function locatePhone(maxMs){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation) return reject(new Error('هذا الهاتف لا يدعم تحديد الموقع — تواصل مع الإدارة'));
    const t0 = Date.now();
    let best = null, done = false, watch = null, unavailable = false;
    const finish = err => {
      if(done) return; done = true; clearInterval(tick);
      if(watch !== null) navigator.geolocation.clearWatch(watch);
      if(best && (!err || err.soft)) resolve(best); else reject(err);
    };
    const check = () => {
      const t = Date.now() - t0;
      if(best && (best.acc <= 30 || (t >= 4000 && best.acc <= 60) || (t >= 8000 && best.acc <= GEO_MAX_ACCURACY) || (t >= 6000 && best.acc >= GEO_APPROX))) return finish();
      if(!best && unavailable && t >= 6000) return finish(new Error(GEO_OFF_MSG));
      if(t >= maxMs) finish(Object.assign(new Error(GEO_OFF_MSG), { soft: true })); // المهلة: أفضل قراءة إن وُجدت
    };
    const tick = setInterval(check, 500);
    watch = navigator.geolocation.watchPosition(p => {
      const c = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) };
      if(!best || c.acc < best.acc) best = c;
      check();
    }, e => {
      if(e.code === 1) finish(new Error('لم يُسمح للتطبيق بالوصول لموقعك، وتسجيل الحضور يتطلبه.\n\nاسمح به: الإعدادات ← التطبيقات ← UniGuard (أو المتصفح) ← الموقع ← سماح، ثم أعد المحاولة.'));
      else if(e.code === 2) unavailable = true; // خدمة الموقع مغلقة غالبًا (أو لا إشارة بعد): يُنتظر قليلًا ثم يُبلَّغ
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs });
  });
}
// true = يمكن فتح الكاميرا (وفي _checkinLoc موقع الهاتف إن طلبته الإدارة)
async function checkinRulesOk(){
  _checkinLoc = null;
  const r = checkinRules();
  if(r.time){
    const p = riyadhParts(), now = p.hour + ':' + p.minute;
    if(!inTimeWindow(now, r.time.from, r.time.to)){
      alert('تسجيل الحضور متاح فقط من الساعة ' + r.time.from + ' إلى ' + r.time.to + '\n\nالساعة الآن ' + now);
      return false;
    }
  }
  if(!r.geo) return true;
  const btn = $id('checkinBtn'), sub = $id('checkinSub'), prev = sub.textContent;
  btn.disabled = true; sub.textContent = 'جاري تحديد موقعك...';
  let loc;
  try{ loc = await locatePhone(20000); }
  catch(e){ alert(e.message); return false; }
  finally{ btn.disabled = false; sub.textContent = prev; }
  if(loc.acc >= GEO_APPROX){ alert(PRECISE_MSG); return false; }
  if(loc.acc > GEO_MAX_ACCURACY){
    alert('دقة تحديد موقعك ضعيفة (±' + loc.acc + ' م).\n\nشغّل GPS واخرج لمكان مكشوف، ثم أعد المحاولة.');
    return false;
  }
  const dist = Math.round(distanceM(loc, r.geo));
  if(dist > r.geo.radius + Math.min(loc.acc, GEO_ACC_GRACE)){
    alert('أنت خارج موقع العمل' + (r.geo.label ? ' «' + r.geo.label + '»' : '') + '.\n\nتبعد عنه ' + dist + ' م، والمسموح ' + r.geo.radius + ' م.');
    return false;
  }
  _checkinLoc = loc;
  return true;
}

/* سمحت الإدارة بإعادة تسجيل وجه العامل (تغيّر مظهره كثيرًا، أو لا بصمة له): تسجيل كامل قبل الحضور.
 * faceV غير موجود = الخادم لم يُحدَّث بعد (لا يعرف نظام الوجه الحالي) */
const needsFaceUpdate = () => !!currentWorker && currentWorker.faceV !== undefined && !!currentWorker.faceReset;
// لا بصمة SFace (حساب قديم، أو بصمة النظام السابق الملغى): يلزم أن تلتقط الإدارة وجهه أو تسمح بإعادة تسجيله
const NO_FACE_MSG = 'لا توجد بصمة وجه لهذا الحساب — اطلب من الإدارة التقاط وجهك أو السماح بإعادة تسجيله';
const lacksFace = () => !!currentWorker && currentWorker.faceV !== undefined && currentWorker.faceV !== FACE_MODEL && !currentWorker.faceReset;
function setFaceModalMode(update, thenCheckin){
  $id('faceModalTitle').textContent = !update ? 'تسجيل الحضور' : 'إعادة تسجيل بصمة الوجه';
  $id('faceModalSub').textContent = !update ? 'انظر إلى الكاميرا مباشرة'
    : 'انظر للكاميرا، ثم أدر رأسك قليلًا يمينًا ويسارًا' + (thenCheckin ? ' — ويُسجَّل حضورك بعدها مباشرة' : '');
}

/* إعادة تسجيل الوجه عند فتح الحساب (لا عند الحضور): نافذة الكاميرا تظهر من نفسها لمن سمحت له الإدارة بإعادة
   التسجيل — وتعود عند كل فتح للتطبيق حتى يُكملها (إغلاقها يؤجلها 10 دقائق) */
let _faceAskAt = 0;
const FACE_ASK_AGAIN = 10 * 60e3;
async function offerFaceUpdate(){
  if(!needsFaceUpdate() || Date.now() - _faceAskAt < FACE_ASK_AGAIN || visibleScreen() !== 'screen-worker') return false;
  if((currentWorker.status || 'active') !== 'active') return false;
  _faceAskAt = Date.now();
  camReset();
  setFaceModalMode(true, false);
  setModal('faceModal', true);
  const status = $id('checkCamStatus');
  status.textContent = 'جاري تشغيل الكاميرا...';
  checkStream = await startCamera($id('checkVideo'), status, 'انظر للكاميرا ووجهك داخل الدائرة');
  if(checkStream) faceUpdateLoop(false);
  return true;
}

/* فحص حيوية سريع في بعض مرات الحضور: بعد اللقطتين يُطلب إدارة الرأس قليلًا لأحد الجانبين (ثانية أو اثنتان) —
   صورة مطبوعة أو على شاشة هاتف آخر لا تستطيع ذلك. يُقرَّر عشوائيًا عند فتح النافذة ويبقى مطلوبًا حتى ينجح
   (إغلاق النافذة وإعادة فتحها لا يُسقطه)، فلا يمكن تجاوزه بتكرار المحاولة حتى تأتي مرة بلا فحص */
const LIVENESS_RATE = 0.3, LIVE_KEY = 'hudurak_live_check', LIVE_MAX_MS = 10000;
let _liveNeeded = false;
function livenessDue(){
  try{
    if(localStorage.getItem(LIVE_KEY) === '1') return true;
    if(Math.random() < LIVENESS_RATE){ localStorage.setItem(LIVE_KEY, '1'); return true; }
  }catch(e){}
  return false;
}
function livenessPassed(){ _liveNeeded = false; try{ localStorage.removeItem(LIVE_KEY); }catch(e){} }
// الرأس يدور عن زاوية اللقطتين الأماميتين، والوجه المائل يطابقهما (نفس الشخص لا صورة أخرى)
async function turnChallenge(video, status, frames, yaw0, alive){
  status.textContent = 'تحقق سريع: أدر رأسك قليلًا إلى أحد الجانبين ↔';
  video.closest('.cam-wrap').classList.add('face-on');
  const ref = meanFace(frames), t0 = Date.now();
  while(alive()){
    if(Date.now() - t0 > LIVE_MAX_MS){
      status.textContent = 'لم يكتمل التحقق — اضغط «تحقق من الوجه» وأدر رأسك قليلًا عندما يُطلب منك';
      camFeedback('bad'); return false;
    }
    let r = null, d = null;
    try{ r = await analyzeFace(video, false); }catch(e){}
    if(!alive()) return false;
    if(r && Math.abs(r.yaw - yaw0) >= TURN_MIN && Math.abs(r.yaw) <= TURN_MAX){
      try{ d = await faceEmbed(r.frame, r.mesh); }catch(e){}
      if(d && faceSim(ref, d) >= FACE_SIM_TURN){ livenessPassed(); return true; }
    }
    await sleep(100);
  }
  return false;
}

async function openFaceModal(){
  if(!await checkinRulesOk()) return;
  camReset();
  const update = needsFaceUpdate();
  _liveNeeded = !update && livenessDue(); // تحديث البصمة فيه إدارة الرأس أصلًا
  setFaceModalMode(update, true);
  setModal('faceModal', true);
  const status = $id('checkCamStatus');
  if(currentWorker && currentWorker.faceV === undefined){
    status.textContent = 'نظام التعرف على الوجه في الخادم لم يُحدَّث بعد — تواصل مع الإدارة';
    return;
  }
  if(lacksFace()){ status.textContent = NO_FACE_MSG; return; }
  // (لا طلب «تدفئة» للخادم هنا: الحضور يُقبل على الهاتف بالتحقق المحلي، وكل طلب إضافي حمل على خادم Google)
  _localFaceFails = 0;
  status.textContent = 'جاري تشغيل الكاميرا...';
  checkStream = await startCamera(
    $id('checkVideo'), status,
    update ? 'انظر للكاميرا ووجهك داخل الدائرة' : 'ضع وجهك داخل الدائرة — سيتم التحقق تلقائيًا');
  if(checkStream) update ? faceUpdateLoop() : autoCheckinLoop();
}

function closeFaceModal(){
  _autoLoopId++;
  stopStream(checkStream);
  checkStream = null;
  $id('checkVideo').srcObject = null;
  setModal('faceModal', false);
  camReset();
}

// التقاط تلقائي: يحلل الكاميرا باستمرار ويرسل البصمة بمجرد ظهور وجه واضح، دون انتظار الضغط على زر.
// سريع عمدًا (عكس التسجيل): لقطتان متتاليتان واضحتان لنفس الوجه تكفيان، بلا طلب تحريك الرأس.
// (2.20) بصمة اللقطة تُحسب في الخيط الخلفي أثناء كشف الوجه في اللقطة التالية — لا انتظار بينهما
async function autoCheckinLoop(){
  const my = ++_autoLoopId;
  const video = $id('checkVideo');
  const status = $id('checkCamStatus');
  const alive = () => my === _autoLoopId && !!checkStream;
  let prev = null; // آخر لقطة واضحة: { p: بصمتها (قيد الحساب)، yaw }
  while(alive()){
    if(!modelsReady){
      ensureFaceModels(); status.textContent = faceLoadingMsg();
    }else if(video.readyState >= 2 && video.videoWidth && !_checkinBusy){
      let r = null;
      try{ r = await analyzeFace(video, false); }catch(e){}
      if(!alive()) return;
      const bad = r && faceQuality(r, video);
      if(r && !bad && r.score >= AUTO_MIN_SCORE){
        // البصمة فقط للقطة الصالحة (تُنسخ اللقطة لحظة الطلب، فالكشف التالي يبدأ فورًا)
        const cur = { p: faceEmbed(r.frame, r.mesh).catch(() => null), yaw: r.yaw };
        video.closest('.cam-wrap').classList.add('face-on'); // دائرة خضراء متصلة أثناء التثبيت
        if(!prev){ prev = cur; status.textContent = 'ثبّت وجهك لحظة...'; continue; } // اللقطة التالية فورًا لتأكيد الثبات
        const [d1, d2] = await Promise.all([prev.p, cur.p]);
        if(!alive()) return;
        // لقطة لا تشبه السابقة (تغيّر الشخص أو اهتزاز شديد): تبدأ من اللقطة الجديدة
        if(!d1 || !d2 || faceSim(d1, d2) < FACE_SIM_STEADY){ prev = d2 ? cur : null; continue; }
        const shots = [d1, d2], yaw0 = (prev.yaw + cur.yaw) / 2;
        if(_liveNeeded && !await turnChallenge(video, status, shots, yaw0, alive)) return;
        await submitCheckin(shots, true); return;
      }
      prev = null;
      video.closest('.cam-wrap').classList.remove('face-on');
      status.textContent = bad || (!r && lightCheck(video, null).msg) || 'ضع وجهك داخل الدائرة — سيتم التحقق تلقائيًا';
    }
    await sleep(120);
  }
}

/* إعادة تسجيل بصمة الوجه بإذن الإدارة: نفس التقاط التسجيل الكامل، ثم لقطتان جديدتان للحضور مباشرة
 * (الخادم يرفض إرسال لقطات التسجيل نفسها كحضور: تطابقها الحرفي مع البصمة المحفوظة = إعادة إرسال) */
async function faceUpdateLoop(thenCheckin = true){
  const my = ++_autoLoopId;
  const video = $id('checkVideo'), status = $id('checkCamStatus'), btn = $id('checkCaptureBtn');
  const alive = () => my === _autoLoopId && !!checkStream;
  const cap = await captureEnrollment(video, status, alive);
  if(!cap || !alive()) return;
  if(cap.error){ status.textContent = cap.error + ' — اضغط «تحقق من الوجه» للمحاولة مجددًا'; camFeedback('bad'); return; }
  _checkinBusy = true; btn.disabled = true;
  let res;
  try{
    status.textContent = 'جاري حفظ بصمة الوجه الجديدة...';
    res = await apiCall('upgradeFace', workerAuth({ descriptors: cap.descriptors, fm: FACE_MODEL }));
  }catch(error){
    if(isLockedError(error)){ closeFaceModal(); lockApp(); return; }
    status.textContent = error.message + ' — اضغط «تحقق من الوجه» للمحاولة مجددًا';
    camFeedback('bad');
    return;
  }finally{ _checkinBusy = false; btn.disabled = false; }
  rememberFace(cap.descriptors, true);
  if(res.worker) currentWorker = res.worker;
  _liveNeeded = false;
  setFaceModalMode(false);
  if(!thenCheckin){ // من نافذة التأكيد عند فتح الحساب: تُغلق بعد ✓
    camFeedback('ok'); toast('تم تسجيل بصمة الوجه الجديدة ✓');
    await sleep(CAM_OK_MS); if(alive()) closeFaceModal();
    return;
  }
  toast('تم تحديث بصمة الوجه ✓');
  if(alive()){ status.textContent = 'تم تحديث البصمة ✓ — ثبّت وجهك لتسجيل الحضور'; autoCheckinLoop(); }
}

// زر "تحقق من الوجه" يبقى متاحًا كبديل يدوي (وبعد رفض الخادم لا نعيد المحاولة تلقائيًا حتى لا تتكرر الطلبات)
async function captureCheckin(){
  const status = $id('checkCamStatus');
  if(!checkStream){ await openFaceModal(); return; }
  if(_checkinBusy) return;
  if(needsFaceUpdate()){ faceUpdateLoop(); return; }
  if(_liveNeeded){ autoCheckinLoop(); return; } // اللقطتان ثم إدارة الرأس
  if(lacksFace()){ status.textContent = NO_FACE_MSG; return; }
  if(!modelsReady){ status.textContent = faceLoadingMsg(); return; }
  _autoLoopId++; // يوقف الحلقة التلقائية أثناء المحاولة اليدوية
  const btn = $id('checkCaptureBtn');
  btn.disabled = true;
  status.textContent = 'جاري التحقق من الوجه...';
  const video = $id('checkVideo'), descs = []; // لقطتان للتأكيد
  for(let i = 0; i < 8 && descs.length < AUTO_STABLE_FRAMES; i++){
    let r = null;
    try{ if(video.readyState >= 2 && video.videoWidth) r = await analyzeFace(video); }catch(e){ console.error('تعذر تحليل صورة الوجه', e); }
    if(r) descs.push(r.descriptor); else await sleep(150);
  }
  btn.disabled = false;
  if(!descs.length){ status.textContent = 'لم يتم العثور على وجه، اقترب من الكاميرا وتأكد من الإضاءة'; return; }
  await submitCheckin(descs, false);
}

let _localFaceFails = 0;
async function submitCheckin(descs, auto){
  const status = $id('checkCamStatus');
  const btn = $id('checkCaptureBtn');
  // 1) التحقق المحلي أولًا: غير مطابق = رد فوري ومحاولة جديدة بلا انتظار الخادم. بعد عدة مرات يُرسل
  //    للخادم رغم ذلك (هو الحكم: قد يكون مرجع الهاتف قديمًا — تغيّر المظهر أو الإضاءة)
  const local = localFaceCheck(descs);
  if(local === false && ++_localFaceFails < LOCAL_FACE_TRIES){
    status.textContent = 'الوجه غير مطابق — ' + (_lastLightHint || 'ثبّت وجهك أمام الكاميرا في إضاءة جيدة');
    camFeedback('bad');
    if(auto) setTimeout(() => { if(checkStream && !_checkinBusy) autoCheckinLoop(); }, 800);
    return;
  }
  _checkinBusy = true; btn.disabled = true;
  // 2) مطابق محليًا: قبول فوري على الشاشة، والخادم يؤكد في الخلفية
  if(local){
    camFeedback('ok'); await sleep(CAM_OK_MS); // ✓ داخل الكاميرا لحظة، ثم تُغلق وينبثق زر الحضور الأخضر
    closeFaceModal(); showLocalCheckin('pending'); toast('تم تسجيل حضورك ✓ بانتظار موافقة الإدارة');
  }
  else status.textContent = 'تم التقاط الوجه ✓ جاري التحقق وتسجيل الحضور...';
  let res;
  try{
    res = await sendReliable('checkin', workerAuth(Object.assign({ descriptors: descs, fm: FACE_MODEL }, _checkinLoc ? { loc: _checkinLoc } : {})), { optimistic: !!local });
  }catch(error){
    if(isLockedError(error)){ closeFaceModal(); lockApp(); return; }
    // الخادم يطلب تحديث بصمة الوجه (بيانات الهاتف أقدم من ذلك): المحاولة التالية تبدأ التحديث
    if(/تحديث بصمة الوجه/.test(error.message) && currentWorker) currentWorker = Object.assign({}, currentWorker, { faceUpdate: true });
    // رفض الخادم (الوجه غير مطابق مثلًا): تنبيه على الهاتف يطلب إعادة المحاولة
    checkinAlert('لم يُسجَّل حضورك ✗', error.message + ' — اضغط هنا لإعادة المحاولة', true);
    if(local){ _workerPrefetch = null; renderWorkerStats(); return; }
    status.textContent = error.message + (_lastLightHint && /غير مطابق/.test(error.message) ? ' — ' + _lastLightHint : '')
      + (auto ? ' — اضغط "تحقق من الوجه" للمحاولة مجددًا' : '');
    camFeedback('bad');
    return;
  }finally{ _checkinBusy = false; btn.disabled = false; }
  _localFaceFails = 0;
  if(res.queued){ // لا اتصال: يُرسل تلقائيًا فور عودته (نفس اليوم)
    if(!local){ closeFaceModal(); showLocalCheckin('queued'); }
    checkinAlert('لم يصل حضورك للخادم بعد ⚠', 'لا يوجد اتصال — سيُرسل تلقائيًا فور عودة الاتصال وأنت داخل التطبيق. إن لم يصل أعد المحاولة');
    return;
  }
  // المرجع المحلي = لقطات التسجيل فقط (الخادم يرفض إعادة إرسالها حرفيًا). رفضه المحلي وقبول الخادم = مرجع قديم
  // (تغيّر المظهر): يُحذف، فيتحقق الخادم وحده من الآن بلا محاولات محلية فاشلة قبله
  if(local === false) forgetLocalFace();
  if(!local){
    if(!$id('faceModal').classList.contains('hidden')){ camFeedback('ok'); await sleep(CAM_OK_MS); }
    toast(res.alreadyCheckedIn ? 'تم تسجيل حضورك اليوم بالفعل' : 'تم تسجيل حضورك، بانتظار موافقة الإدارة'); closeFaceModal();
  }
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

let _hasPasskey = false;          // هذا الجهاز مفعّل عليه القفل
let _pkOpts = null, _pkOffered = false;
function updateExitButton(){
  const b = $id('workerExitBtn');
  if(b){ const l = _hasPasskey ? 'قفل التطبيق' : 'تسجيل الخروج'; b.innerHTML = icon(_hasPasskey ? 'lock' : 'log-out'); b.title = l; b.setAttribute('aria-label', l); }
  updatePasskeyStatus();
}
// حالة القفل في "إدارة الحساب": مفعّل، أو سبب عدم توفره بوضوح، أو زر تفعيل
async function updatePasskeyStatus(){
  renderNotifRows();
  const st = $id('pkStatus'), btn = $id('pkEnableBtn'), off = $id('pkDisableBtn');
  if(!st) return;
  const row = st.closest('.pk-row');
  const set = (text, showBtn, on) => { row.classList.remove('hidden'); st.textContent = text; st.classList.toggle('on', !!on);
    btn.classList.toggle('hidden', !showBtn); if(off) off.classList.toggle('hidden', !on); };
  if(_hasPasskey) return set('مفعّل ✓ — يُطلب قفل هاتفك عند كل فتح للتطبيق', false, true);
  if(!window.isSecureContext) return set('يعمل فقط من رابط التطبيق الرسمي (https)', false);
  if(!await passkeySupported()) return set('غير متاح: فعّل قفل الشاشة في إعدادات هاتفك (بصمة، رمز، نمط أو كلمة سر)، ثم أعد فتح التطبيق', false);
  set('غير مفعّل (اختياري) — فعّله ليفتح التطبيق بقفل هاتفك: البصمة أو الرمز أو النمط أو كلمة السر', true);
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
  setModal('passkeyModal', false); setModal('gpsModal', false); _gpsCheckedAt = 0; // يُفحص الموقع من جديد بعد الفتح
  setModal('settleModal', false); _settleShown = ''; // تعود بعد الفتح (حالتها في الخادم)
  showLockScreen(currentWorker || (readLocalCache(CACHE_W) || {}).worker, auto);
}
function showLockScreen(worker, auto){
  _hasPasskey = true;
  const first = worker && worker.name ? String(worker.name).split(' ')[0] : '';
  $id('lockName').textContent = first ? 'مرحبًا ' + first : 'مرحبًا';
  $id('lockHint').textContent = 'افتح التطبيق بقفل هاتفك: البصمة أو الوجه أو الرمز أو النمط أو كلمة السر';
  $id('lockHelp').classList.toggle('hidden', _unlockFails < 2);
  if(visibleScreen() !== 'screen-lock') showScreen('screen-lock');
  // التحدي يُجلب مسبقًا: الضغط على الزر يفتح نافذة البصمة فورًا (وآيفون يشترط ذلك)
  prefetchUnlock().then(o => { if(o && auto && !_unlocking) unlockApp(false); });
}
// معرّف مفتاح القفل على هذا الهاتف (ليس سرًا — المفتاح نفسه في شريحة الأمان): يلزم للفتح بلا إنترنت
const PK_CRED = 'hudurak_pk_cred';
function savePkCred(credId){ if(credId && currentPhone) try{ localStorage.setItem(PK_CRED, JSON.stringify({ phone: currentPhone, credId })); }catch(e){} }
function pkCredId(){
  for(const k of [PK_CRED, PK_NEXT]){
    try{ const x = JSON.parse(localStorage.getItem(k) || 'null'); if(x && x.phone === currentPhone && x.credId) return x.credId; }catch(e){}
  }
  return '';
}
async function prefetchUnlock(){
  if(_lockOpts && Date.now() - _lockOptsAt < (_lockOpts.local ? LOCAL_OPTS_MS : 8 * 60000)) return _lockOpts;
  const n = peekNext(PK_NEXT, x => x.phone === currentPhone && x.credId);
  if(n){ _lockOpts = { challenge: n.c, credId: n.credId, hasPasskey: true, fromNext: true }; _lockOptsAt = Date.now(); return _lockOpts; }
  try{
    const o = await apiCall('passkeyOptions', workerAuth(), { silent:true });
    if(!o.hasPasskey){ _hasPasskey = false; resumeWorkerSession(currentPhone, true); return null; } // أعادت الإدارة ضبط القفل
    savePkCred(o.credId);
    _lockOpts = o; _lockOptsAt = Date.now();
    return o;
  }catch(error){
    // بلا اتصال: فتح بالبصمة على الهاتف نفسه ليرى العامل آخر بياناته المحفوظة (الخادم يتحقق عند عودة الاتصال)
    const c = readLocalCache(CACHE_W), credId = pkCredId();
    if(error.net && credId && c && c.phone === currentPhone && c.worker && (c.worker.status || 'active') === 'active'){
      $id('lockHint').textContent = 'لا يوجد اتصال — افتح ببصمتك لعرض آخر بياناتك المحفوظة';
      _lockOpts = { local: true, challenge: localChallenge(), credId }; _lockOptsAt = Date.now();
      return _lockOpts;
    }
    // الجهاز لم يعد معتمدًا أو الحساب حُذف: المسار العادي يحدد الشاشة الصحيحة
    if(/الجلسة غير صالحة/.test(error.message)) resumeWorkerSession(currentPhone, true);
    else $id('lockHint').textContent = navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : error.message;
    return null;
  }
}
// فُتح بلا إنترنت (بصمة على الهاتف فقط) وعاد الاتصال: شاشة القفل ونافذة البصمة ليتحقق الخادم ويعطي الجلسة،
// ثم تُرسل العمليات المحفوظة (الحضور) وتُحدَّث البيانات
async function workerReconnect(){
  if(_checkinBusy || !$id('faceModal').classList.contains('hidden')) return; // لا نقاطع تسجيل الحضور
  let o = null;
  try{ o = await apiCall('passkeyOptions', workerAuth(), { silent:true }); }
  catch(e){ if(e.net) return; } // لا يزال بلا اتصال
  if(!_pendingUnlock || !_pendingUnlock.local) return; // قُفل أو خرج أثناء الانتظار
  _pendingUnlock = null;
  if(o && o.hasPasskey){ savePkCred(o.credId); _lockOpts = o; _lockOptsAt = Date.now(); }
  lockApp(true);
  $id('lockHint').textContent = 'عاد الاتصال — افتح ببصمتك مرة أخرى لإرسال بياناتك وتحديثها';
}
function unlockApp(userTap){
  return passkeyUnlockFlow(userTap, {
    prefetch: prefetchUnlock,
    allow: o => [o.credId],
    nextKey: PK_NEXT,
    showCached: o => {
      const c = readLocalCache(CACHE_W);
      if(!(c && c.phone === currentPhone && c.worker && (c.worker.status || 'active') === 'active')) return false;
      _workerPrefetch = { worker: c.worker, log: c.log || [], advances: c.advances || [], at: Date.now() };
      if(o.local) _pendingUnlock = { local: true, tried: Date.now(), reconnect: workerReconnect }; // قبل عرض اللوحة: لا تحديث بلا جلسة
      openWorkerDashboard(c.worker);
      return true;
    },
    action: 'passkeyUnlock',
    request: assertion => workerAuth(assertion),
    done: (res, cred) => {
      setWorkerSession(res.session);
      saveNext(PK_NEXT, { phone: currentPhone, credId: cred.id, c: res.next });
      savePkCred(cred.id);
      _unlockFails = 0;
      handleWorkerResponse(res);
    },
    relock: () => showLockScreen(currentWorker)
  });
}

// قفل الهاتف اختياري: نافذة التفعيل تُعرض للعامل (إن كان هاتفه يدعمه — قفل شاشة مفعّل بأي طريقة)، و«لاحقًا» يؤجلها
// 30 يومًا. يفعّله أو يلغيه متى شاء من «حسابي». بلا اتصال: تُعرض عند عودته (محاولة كل دقيقة على الأكثر)
const PK_LATER_MS = 30 * 864e5;
function pkDeclined(){ try{ return Date.now() - Number(localStorage.getItem(PK_LATER) || 0) < PK_LATER_MS; }catch(e){ return false; } }
let _pkFailAt = 0;
async function offerPasskey(manual){
  if(_hasPasskey || _pkOffered || !currentPhone) return;
  if(!manual && Date.now() - _pkFailAt < 60000) return;
  if(!await passkeySupported()) return;
  _pkOffered = true;
  try{ _pkOpts = await apiCall('passkeyOptions', workerAuth(), { silent:true }); }
  catch(e){ _pkFailAt = Date.now(); if(manual) toast(e.message); updatePasskeyStatus(); return; }
  finally{ _pkOffered = false; }
  if(_pkOpts.hasPasskey){ _hasPasskey = true; updateExitButton(); return; }
  if(!['screen-worker','screen-pending'].includes(visibleScreen()) || (!manual && !canPrompt())) return;
  setModal('passkeyModal', true);
}
function passkeyLater(){
  try{ localStorage.setItem(PK_LATER, String(Date.now())); }catch(e){}
  setModal('passkeyModal', false);
  toast('يمكنك تفعيله في أي وقت من «حسابي»');
}
// إلغاء الفتح بقفل الهاتف (من «حسابي»، والتطبيق مفتوح بالقفل): يفتح التطبيق بعدها مباشرة بلا قفل
async function disablePasskey(){
  if(!confirm('إلغاء فتح التطبيق بقفل الهاتف؟\nسيُفتح التطبيق بعدها مباشرة دون طلب بصمتك أو رمزك، ويمكنك تفعيله من جديد في أي وقت.')) return;
  const btn = $id('pkDisableBtn'); if(btn) btn.disabled = true;
  try{ await apiCall('passkeyRemove', workerAuth()); }
  catch(e){ if(isLockedError(e)){ lockApp(); return; } toast(e.message); return; }
  finally{ if(btn) btn.disabled = false; }
  _hasPasskey = false; setWorkerSession('');
  clearNext(PK_NEXT); clearNext(PK_CRED);
  try{ localStorage.setItem(PK_LATER, String(Date.now())); }catch(e){} // لا تعود نافذة التفعيل من نفسها
  const c = readLocalCache(CACHE_W); if(c){ c.passkey = false; saveLocalCache(CACHE_W, c); }
  updateExitButton();
  toast('أُلغي القفل — يُفتح التطبيق الآن بلا قفل الهاتف');
}
async function enablePasskey(){
  const btn = $id('passkeyYes');
  btn.disabled = true;
  try{
    const o = _pkOpts || await apiCall('passkeyOptions', workerAuth());
    _pkOpts = null;
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: b64ToBytes(o.challenge), rp: { name: APP_NAME_AR },
      user: { id: b64ToBytes(o.userId), name: o.userName, displayName: o.displayName },
      pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
      // platform = قفل هذا الهاتف نفسه (لا مفتاح خارجي ولا رمز QR). userVerification: required يقبله النظام بأي طريقة
      // فتح مفعّلة في الهاتف: بصمة الإصبع أو الوجه، أو الرمز أو النمط أو كلمة السر
      authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'preferred' },
      hints: ['client-device'], attestation: 'none', timeout: 120000 } });
    const r = cred.response;
    if(!r.getPublicKey || !r.getAuthenticatorData || !r.getPublicKey()) throw new Error('المتصفح قديم ولا يدعم القفل — حدّث المتصفح ثم حاول');
    const res = await apiCall('passkeyRegister', workerAuth({ credId: cred.id, clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.getAuthenticatorData()), publicKey: bufToB64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm() }));
    setWorkerSession(res.session);
    saveNext(PK_NEXT, { phone: currentPhone, credId: res.credId || cred.id, c: res.next });
    savePkCred(res.credId || cred.id);
    _hasPasskey = true; updateExitButton();
    const c = readLocalCache(CACHE_W); if(c){ c.passkey = true; saveLocalCache(CACHE_W, c); }
    setModal('passkeyModal', false);
    toast('تم التفعيل ✓ سيُفتح التطبيق من الآن بقفل هاتفك');
  }catch(e){
    toast(passkeyErrorText(e, 'التفعيل'));
    apiCall('passkeyOptions', workerAuth(), { silent:true }).then(o => { _pkOpts = o; }).catch(()=>{});
  }finally{ btn.disabled = false; }
}
let _workerVer = '', _workerFullAt = 0, _workerHash = '', _workerWv = '';

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
  account: { icon:'party-popper', label:'الحساب',       cls:'acct' },
  device:  { icon:'smartphone', label:'الجهاز',       cls:'acct' },
  'att-ok':{ icon:'circle-check', label:'حضور معتمد',   cls:'ok' },
  'att-no':{ icon:'circle-alert', label:'حضور مرفوض',   cls:'no' },
  adv:     { icon:'banknote', label:'سلفة',         cls:'money' },
  settle:  { icon:'receipt', label:'تصفية الحساب', cls:'money' },
  wage:    { icon:'coins', label:'اليومية',      cls:'money' },
  msg:     { icon:'message-square-text', label:'رسالة الإدارة', cls:'acct' },
  checkin: { icon:'triangle-alert', label:'حالة الحضور',  cls:'no' },
  info:    { icon:'info', label:'تنبيه',        cls:'' }
};
// تنبيه حالة الحضور: في مركز الإشعارات + رسالة داخل التطبيق + إشعار على الهاتف (يظهر خارج التطبيق أيضًا).
// نفس الوسم (checkin): التنبيه الأحدث يحل محل السابق. retry: الضغط عليه يفتح تسجيل الحضور مباشرة
function checkinAlert(title, body, retry){
  inboxAdd('checkin', title, body);
  toast(body);
  systemNotify(title, body, 'checkin', retry ? { checkin: 1 } : null);
}
// الضغط على «أعد المحاولة» في إشعار الهاتف (sw.js): يفتح الحضور فور ظهور لوحة العامل (بعد فتح القفل إن لزم)
let _retryCheckin = /#checkin\b/.test(location.hash);
if(_retryCheckin) try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){}
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'checkin'){ _retryCheckin = true; retryCheckinIfAsked(); } });
function retryCheckinIfAsked(){
  if(!_retryCheckin || visibleScreen() !== 'screen-worker' || !$id('faceModal').classList.contains('hidden')) return;
  _retryCheckin = false;
  const today = ((readLocalCache(CACHE_W) || {}).log || []).find(r => r.date === todayStr() && r.status !== 'rejected');
  if(today && today.status !== 'queued' && !today.local) return toast('تم تسجيل حضورك اليوم بالفعل');
  if(outboxLoad().some(i => i.action === 'checkin')) return toast('حضورك محفوظ ويُرسل تلقائيًا فور عودة الاتصال');
  openFaceModal();
}
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
  if(_wTab === 'inbox') renderInbox(); // قسم الإشعارات مفتوح: يظهر الجديد فورًا
}
function updateInboxBadge(){
  const n = inboxLoad().filter(x => !x.read).length;
  const b = $id('inboxBadge');
  if(b){
    // إشعار جديد: الجرس يهتز مرة والعدد ينبثق (لا عند أول رسم)
    if(b.dataset.n !== undefined && n > Number(b.dataset.n)) replayAnim($id('wTabInbox'), 'ring');
    b.dataset.n = n;
    b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
  }
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
      <div class="inbox-ico ${t.cls}">${icon(t.icon)}</div>
      <div class="inbox-body"><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p>
        <div class="inbox-meta"><span class="inbox-type">${t.label}</span><span dir="ltr">${escapeHtml(when.time)}</span></div></div>
      <button class="inbox-del" onclick="event.stopPropagation();inboxDelete('${n.id}')" aria-label="حذف الإشعار" title="حذف">${icon('x')}</button>
    </div>`;
  }).join('');
}
// الإشعارات قسم في الشريط السفلي (لا نافذة)
function openInbox(){ wTab('inbox'); }
function closeInbox(){ wTab('home'); }
function setInboxFilter(f){ _inboxFilter = f; renderInbox(); }
function inboxRead(id){ const l = inboxLoad(); const n = l.find(x => x.id === id); if(n && !n.read){ n.read = true; inboxSave(l); renderInbox(); } }
function inboxDelete(id){ inboxSave(inboxLoad().filter(x => x.id !== id)); renderInbox(); }
function inboxMarkAllRead(){ const l = inboxLoad(); if(!l.some(n => !n.read)) return toast('كل الإشعارات مقروءة'); l.forEach(n => n.read = true); inboxSave(l); renderInbox(); }
function inboxClear(){
  if(!inboxLoad().length) return toast('لا توجد إشعارات');
  if(!confirm('حذف كل الإشعارات؟')) return;
  inboxSave([]); renderInbox();
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
    if(!res.exists){ forgetLocalFace(); outboxSave([]); clearRememberedPhone(); clearLocalCaches(CACHE_W); currentPhone = null; showScreen('screen-landing'); toast('لم يعد هذا الحساب موجودًا'); return; }
    if(!res.deviceOk){ _lastDeviceStatus = res.deviceStatus; setDevicePendingText(res.deviceStatus, res.switchFrom); showScreen('screen-device-pending'); return; }
    handleWorkerResponse(res); // نفس الشاشة غالبًا: تتحدث البيانات فقط دون وميض (أو شاشة القفل)
    return;
  }
}

// أول فتح بلا حساب: صفحة الدخول تظهر بعد التأكد من الاتصال فقط. كانت تنتظر تنزيل نظام الوجه كاملًا (~35MB،
// دقائق على اتصال بطيء) قبل أن يكتب العامل رقمه — الآن يُنزَّل في الخلفية أثناء كتابة الرقم والاسم، ونسبته تظهر
// في صفحة الدخول وفي نافذة الكاميرا حتى يكتمل
async function prepareFirstOpen(){
  Splash.set(8, 'جاري تجهيز التطبيق...');
  ensureFaceModels();
  Splash.set(60, 'جاري الاتصال بالخادم...');
  const serverOk = await pingServer(10000);
  if(serverOk || navigator.onLine !== false){ Splash.hide(); return; }
  Splash.error('لا يوجد اتصال بالإنترنت. اتصل بالإنترنت ثم اضغط «إعادة المحاولة».');
}

// الخروج يحدث هنا فقط (بضغطة المستخدم): يمسح الرقم المحفوظ، وإلا يعيد التطبيق إدخاله تلقائيًا عند الفتح التالي.
// حضور لم يُرسل يخص العامل الذي خرج (قد يدخل غيره من الهاتف) فيُحذف. (تطبيق الإدارة على نفس الجهاز لا يتأثر)
function logout(){
  forgetLocalFace(); outboxSave([]);
  currentWorker = null; currentPhone = null; _pendingUnlock = null;
  setWorkerSession(''); _hasPasskey = false; _lockOpts = null; _pkOpts = null; _pkOffered = false;
  setModal('settleModal', false); _settleShown = '';
  clearRememberedPhone(); clearLocalCaches(CACHE_W); clearNext(PK_NEXT); clearNext(PK_CRED);
  pushUnsubscribe();
  _workerVer = ''; _workerFullAt = 0; _workerHash = ''; _workerWv = ''; _pendingVer = ''; _lastDeviceStatus = '';
  showScreen('screen-landing');
  ensureFaceModels();
}

/* ---------- خطافات core.js ---------- */
function roleOnResponse(res, action){
  if(res.session && (action === 'getWorkerData' || action === 'checkin')) setWorkerSession(res.session); // تجديد صامت للجلسة
  if(res.rules && typeof res.rules === 'object') storeCheckinRules(res.rules); // شروط الحضور (الوقت والموقع) من الإدارة
  // بيانات لوحة العامل مرفقة بالرد: تُغني عن طلب ثانٍ
  if(res.worker && Array.isArray(res.log)) _workerPrefetch = { worker: res.worker, log: res.log, advances: res.advances || [], version: res.version,
    hash: res.hash, wv: res.wv, passkey: res.passkey, settlement: res.settlement || null, messages: res.messages, at: Date.now() };
}
function roleOutboxAuth(){ return currentPhone ? workerAuth() : null; }
// حضور وصل للخادم متأخرًا (بعد عودة الاتصال) أو رُفض
function roleOutboxDone(it, res, err){
  if(it.action !== 'checkin') return;
  if(res){
    // يحل محل تنبيه «لم يصل بعد» على الهاتف (نفس الوسم)
    checkinAlert('وصل حضورك للخادم ✓', 'سُجّل حضورك بعد عودة الاتصال، بانتظار موافقة الإدارة');
  }else{
    checkinAlert('لم يُسجَّل حضورك ✗', (err === 'expired' ? 'انقطع الاتصال حتى انتهى اليوم فلم يصل الحضور للخادم' : err) + ' — اضغط هنا لإعادة المحاولة', true);
    _workerPrefetch = null;
  }
  if(visibleScreen() === 'screen-worker') renderWorkerStats();
}
function roleShowScreen(id){
  if(id !== 'screen-register'){ stopStream(regStream); regStream = null; _regLoopId++; } // لا نترك الكاميرا مفتوحة
  // صفحة الدخول في متصفح الهاتف دون تثبيت: تظهر نافذة التثبيت فوقها (مثلًا بعد تسجيل الخروج)
  if(id === 'screen-landing' && window.InstallGate && InstallGate.required()) InstallGate.show();
}
async function roleSync(scr){
  if(scr === 'screen-worker' && currentPhone) await syncWorker();
  else if(scr === 'screen-pending') await refreshPendingStatus(true);
  else if(scr === 'screen-device-pending') await refreshDeviceStatus(true);
}
function roleForceRefresh(){ _workerHash = ''; _workerVer = ''; _workerWv = ''; }
function roleRelock(){ if(_hasPasskey && ['screen-worker','screen-pending'].includes(visibleScreen())) lockApp(true); }
function roleNotify(tag, title, body){ if(tag && !/^adm/.test(tag)) inboxAdd(tag, title, body); }
async function roleInit(handoff, updated){
  if(handoff && handoff.ws) setWorkerSession(handoff.ws);
  // في متصفح الهاتف والتطبيق غير مثبّت: نافذة التثبيت الكبيرة بدل أي صفحة حتى يثبّته.
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
