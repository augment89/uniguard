/* =========================================================================
   محرك الوجه المشترك (js/face.js): كاشف Human + بصمة SFace، الكاميرا، جودة اللقطة والإضاءة، والتقاط
   البصمة المرجعية الكاملة. يحمّله تطبيق العمال مع الصفحة (قبل worker.js)، وتطبيق الإدارة عند فتح كاميرا
   الوجه (فتح حساب عامل، أو الحضور الجماعي). يعتمد على core.js (Splash، loadScript، $id، sleep...)
   ========================================================================= */
const AUTO_MIN_SCORE = 0.6;       // ثقة كشف الوجه المطلوبة للالتقاط التلقائي
const AUTO_STABLE_FRAMES = 2;     // الوجه يجب أن يظهر في لقطتين متتاليتين (يتجنب لقطة مهزوزة أثناء الحركة)
/* =========================================================================
   محرك التعرف على الوجه (2.18): كاشف Human + بصمة SFace
   - Human (BlazeFace + شبكة 468 نقطة): يجد الوجه ويحدد زاويته ونقاط العينين والأنف والفم (لم يفُته وجه واحد
     في اختبار المقارنة، في الشمس والزوايا)
   - SFace (OpenCV Zoo، رخصة Apache-2.0): الوجه يُعدَّل (تدوير وتكبير) على قالب قياسي 112×112 من 5 نقاط، ثم بصمة
     من 128 رقمًا بطول 1. التشابه = جيب التمام (1 = متطابق تمامًا، أشخاص مختلفون عادةً ≤ 0.25)
   - نموذج البصمة FACE_MODEL يُرسل مع كل بصمة: الخادم لا يقارن بصمة نظام ببصمة نظام آخر أبدًا
   ========================================================================= */
const FACE_MODEL = 'sf1';
let modelsReady = false;
let _human = null, _sface = null;

// يكتمل حين يصبح التعرف على الوجه جاهزًا فعلًا (النماذج + التجهيز المسبق)، أو يفشل (false)
let _faceReadyDone;
const faceReady = new Promise(r => { _faceReadyDone = r; });
// المصادر التي حُمِّل منها فعلًا (المحلية عادةً) — ensureFaceOffline يحفظها على الجهاز
const _faceSrc = { human: HUMAN_SRC, humanModels: HUMAN_MODELS, ort: ORT_DIR, sface: SFACE_URL };

const HUMAN_CONFIG = {
  backend: 'webgl', debug: false, cacheModels: false, warmup: 'none',
  cacheSensitivity: 0, // كل لقطة تُحلَّل من جديد (لا يعيد نتيجة لقطة سابقة تشبهها)
  face: { enabled: true, detector: { rotation: true, maxDetected: 1, minConfidence: 0.3, return: false }, mesh: { enabled: true },
    iris: { enabled: false }, description: { enabled: false }, emotion: { enabled: false }, antispoof: { enabled: false },
    liveness: { enabled: false }, attention: { enabled: false } },
  body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false }
};
async function createHuman(src, models){
  const mod = await import(src), H = mod.Human || mod.default;
  const h = new H(Object.assign({}, HUMAN_CONFIG, { modelBasePath: models }));
  await h.load();
  return h;
}
/* أول تنزيل على الجهاز (~30MB: محرك البصمة + نموذجها، أغلب حجم نظام الوجه) يُعدّ بالبايت: يرى العامل نسبة مئوية
 * بدل «انتظر لحظة» بلا نهاية. بعدها يُفتح من ذاكرة الهاتف خلال ثوانٍ */
const _dl = { got: 0, total: 0 };
async function fetchProgress(url, mb){
  const res = await fetch(url);
  if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const size = Number(res.headers.get('content-length')) || mb * 1048576;
  _dl.total += size;
  if(!res.body || !res.body.getReader){ const buf = new Uint8Array(await res.arrayBuffer()); _dl.got += size; return buf; }
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  for(;;){
    const { done, value } = await reader.read();
    if(done) break;
    parts.push(value); n += value.length; _dl.got += value.length;
  }
  _dl.total += n - size; // الحجم الفعلي (الخادم قد يرسله مضغوطًا أو بلا حجم)
  const out = new Uint8Array(n);
  let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}
// رسالة الكاميرا أثناء تجهيز نظام الوجه
function faceLoadingMsg(){
  if(_faceFailAt) return 'تعذر تنزيل نظام التعرف على الوجه — تحقق من الاتصال بالإنترنت، ستُعاد المحاولة تلقائيًا...';
  const p = _dl.total ? Math.floor(_dl.got / _dl.total * 100) : 0;
  return p > 0 && p < 100 ? 'جاري تنزيل نظام التعرف على الوجه ' + p + '% — مرة واحدة فقط على هذا الجهاز'
    : 'جاري تجهيز نظام التعرف على الوجه، انتظر لحظة...';
}
/* محرك البصمة في خيط خلفي (proxy، 2.19.1): تجهيزه (~0.5 ثانية على الهاتف) وكل بصمة كانا يجمّدان الشاشة — اللمس
 * والكاميرا والحركة — عند كل فتح للتطبيق وأثناء التقاط الوجه. الآن الشاشة لا تتوقف لحظة، والبصمة نفسها بلا أي تغيير.
 * هاتف لا يدعم ذلك: على الخيط الرئيسي كما كان */
async function createSface(dir, url){
  // المحرك (wasm) والنموذج يُنزَّلان معًا بالتوازي مع مكتبة onnxruntime (المحرك هنا للنسبة المئوية وحفظه على الجهاز،
  // والخيط الخلفي يقرؤه بعدها من ذاكرة الجهاز)
  let [, wasm, model] = await Promise.all([
    loadScript(dir + 'ort.wasm.min.js', () => typeof ort !== 'undefined', 'ortLib'),
    fetchProgress(dir + 'ort-wasm-simd-threaded.wasm', ORT_WASM_MB),
    fetchProgress(url, SFACE_MB)
  ]);
  ort.env.wasm.wasmPaths = dir;
  ort.env.logLevel = 'error'; // تحذيرات تحسين داخلية لا تهم (تملأ سجل الأخطاء)
  ort.env.wasm.numThreads = 1; // GitHub Pages بلا عزل المصادر (SharedArrayBuffer): خيط واحد
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  if(typeof Worker !== 'undefined'){
    ort.env.wasm.proxy = true;
    try{ return await ort.InferenceSession.create(model, opts); }
    catch(e){ console.warn('محرك البصمة في خيط خلفي غير متاح — الخيط الرئيسي', e); }
    ort.env.wasm.proxy = false;
    if(!model.byteLength) model = await fetchProgress(url, SFACE_MB); // نُقل للخيط الخلفي: يُقرأ من ذاكرة الجهاز
  }
  ort.env.wasm.wasmBinary = wasm;
  return ort.InferenceSession.create(model, opts);
}
// محلي أولًا، والمصدر الخارجي الأصلي احتياطًا (لم تُرفع الملفات المحلية)
async function localOrCdn(local, cdn, what){
  try{ return await local(); }
  catch(e){ console.warn(what + ' المحلي غير متاح — المصدر الخارجي', e); return cdn(); }
}

let _faceLoading = null, _faceFailAt = 0;
function loadFaceModels(){
  return _faceLoading || (_faceLoading = (async () => {
    const statusEl = $id('modelsStatus'), statusP = statusEl && statusEl.querySelector('p');
    _faceFailAt = 0; _dl.got = _dl.total = 0;
    await registerModelCacheSW();
    Splash.set(15, 'جاري تحميل نظام التعرف على الوجه...');
    let pct = 15;
    const step = p => p.then(r => { Splash.set(pct += 30); return r; });
    // صفحة الدخول تظهر فورًا (لا تنتظر التنزيل): نسبته تظهر تحت العنوان حتى يكتمل
    const tick = statusP ? setInterval(() => { if(!modelsReady) statusP.textContent = faceLoadingMsg(); }, 500) : 0;
    try{
      [_human, _sface] = await Promise.all([
        step(localOrCdn(() => createHuman(HUMAN_SRC, HUMAN_MODELS),
          () => { _faceSrc.human = HUMAN_CDN; _faceSrc.humanModels = HUMAN_MODELS_CDN; return createHuman(HUMAN_CDN, HUMAN_MODELS_CDN); }, 'كاشف الوجه')),
        step(localOrCdn(() => createSface(ORT_DIR, SFACE_URL),
          () => { _faceSrc.ort = ORT_CDN; _faceSrc.sface = SFACE_CDN; _dl.got = _dl.total = 0; return createSface(ORT_CDN, SFACE_CDN); }, 'نموذج البصمة'))
      ]);
      modelsReady = true;
      statusEl?.classList.add('done');
      Splash.set(80, 'جاري تجهيز الكاميرا والتحقق من الوجه...');
      await sleep(50); // يسمح برسم الشاشة قبل العمل الثقيل
      await warmUpFaceNets();
      Splash.set(92);
      _faceReadyDone(true);
    }catch(e){
      _faceLoading = null; _faceFailAt = Date.now(); // يُعاد التنزيل تلقائيًا (ensureFaceModels) بعد FACE_RETRY_MS
      console.error('فشل تحميل نماذج التعرف على الوجه', e);
      _faceReadyDone(false);
    }finally{
      clearInterval(tick);
      if(statusP && !modelsReady) statusP.textContent = faceLoadingMsg();
    }
  })());
}
const FACE_RETRY_MS = 10000;
// أول تحليل على الهاتف أبطأ بثوانٍ (تجهيز برامج المعالج الرسومي ومحرك البصمة). يُجرى مرة في الخلفية فور
// تحميل النماذج، فيكون أول تحقق حقيقي سريعًا. (نداءات متعددة تشترك في نفس التجهيز)
let _warmPromise = null;
function warmUpFaceNets(){
  if(!modelsReady) return Promise.resolve();
  return _warmPromise || (_warmPromise = (async () => {
    try{
      await _human.warmup({ warmup: 'face' }); // صورة وجه مدمجة في المكتبة: كاشف + شبكة النقاط
      await _sface.run({ [_sface.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 112 * 112), [1, 3, 112, 112]) });
    }catch(e){ console.warn('تعذر تجهيز شبكات الوجه مسبقًا', e); }
  })());
}

// النماذج (~55MB، تُحفظ على الجهاز): تطبيق العمال يحمّلها عند الفتح، والإدارة عند فتح الكاميرا
// (بعد فشل التنزيل — انقطاع الاتصال — لا تُعاد المحاولة قبل FACE_RETRY_MS: نوافذ الكاميرا تستدعيها باستمرار)
function ensureFaceModels(){ if(!modelsReady && Date.now() - _faceFailAt >= FACE_RETRY_MS) loadFaceModels(); }
// الحضور بلا إنترنت يحتاج المكتبات والنماذج محفوظة على الجهاز: في أول فتح قد تُحمَّل قبل أن يتحكم ملف الخدمة
// بالصفحة فلا تُحفظ — بعد جاهزيتها يُجلب ما ينقص عبره فيُحفظ (انظر whenControlled في core.js)
async function ensureFaceOffline(){
  const s = _faceSrc, urls = [s.human, s.sface, s.ort + 'ort.wasm.min.js', s.ort + 'ort-wasm-simd-threaded.mjs', s.ort + 'ort-wasm-simd-threaded.wasm'];
  for(const m of ['blazeface', 'facemesh']) urls.push(s.humanModels + m + '.json', s.humanModels + m + '.bin');
  await cacheForOffline(urls);
}
faceReady.then(ok => { if(ok) whenControlled(ensureFaceOffline); });

/* ---------- تحليل لقطة ---------- */
// اللقطة تُنسخ من الكاميرا إلى لوحة (أقصى بُعد 640): الكاشف والبصمة يعملان على نفس الصورة بالضبط
function grabFrame(video, keep){
  const W = video.videoWidth, H = video.videoHeight, s = Math.min(1, 640 / Math.max(W, H));
  const c = (!keep && grabFrame._c) || document.createElement('canvas');
  if(!keep) grabFrame._c = c;
  c.width = Math.round(W * s); c.height = Math.round(H * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c;
}
/* الوجه في لقطة من الكاميرا (أو صورة): الإطار بإحداثيات الكاميرا، الثقة، الزاوية (يمين/يسار yaw وأعلى/أسفل pitch
 * بالدرجات)، والبصمة (withDesc). keep: نسخة مستقلة من اللقطة (frame) تبقى بعد اللقطة التالية. null = لا وجه */
// عدد الوجوه في كل تحليل: واحد (التسجيل والحضور) أو عدة (الحضور الجماعي بكاميرا الإدارة) — يُمرَّر مع كل تحليل
// لأن Human يحفظ آخر إعداد مُمرَّر
const ONE_FACE = { face: { detector: { maxDetected: 1 } } }, MANY_FACES = n => ({ face: { detector: { maxDetected: n } } });
// box: إطار الكاشف (أوسع من الوجه — لفحص الحجم والموضع)، tight: حدود نقاط الوجه نفسها (للرسم فوق الصورة)
const faceOut_ = (f, c, k) => { const ang = (f.rotation && f.rotation.angle) || {};
  const xs = f.mesh.map(p => p[0]), ys = f.mesh.map(p => p[1]), x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
  return { score: f.score || f.boxScore || 0, box: { x: f.box[0] * k, y: f.box[1] * k, width: f.box[2] * k, height: f.box[3] * k },
    tight: { x: x0 * k, y: y0 * k, width: (Math.max.apply(null, xs) - x0) * k, height: (Math.max.apply(null, ys) - y0) * k },
    yaw: (ang.yaw || 0) * 57.3, pitch: (ang.pitch || 0) * 57.3, frame: c, mesh: f.mesh }; };
async function analyzeFace(src, withDesc = true, keep = false){
  const c = src.tagName === 'VIDEO' ? grabFrame(src, keep) : src;
  const r = await _human.detect(c, ONE_FACE), f = r && r.face && r.face[0];
  if(!f || !f.mesh || f.mesh.length < 468) return null;
  const out = faceOut_(f, c, src.videoWidth ? src.videoWidth / c.width : 1);
  if(withDesc) out.descriptor = await faceEmbed(c, f.mesh);
  return out;
}
/* كل الوجوه في لقطة (حتى max) — الحضور الجماعي، على مرحلتين:
   1) أين الوجوه: كشف عدة وجوه في لقطة بدقة أعلى (أقصى بُعد 960؛ الوجوه أصغر وأبعد عن الكاميرا)
   2) كل وجه وحده: قصّ مربع حوله ثم تحليله كوجه واحد (نقاط الوجه بنفس دقة الحضور العادي — في الكشف الجماعي
      قد يتسع إطار وجه ويأخذ ما حوله فتضعف بصمته)
   لكل وجه لوحته (frame) فتُحسب بصمته بعد ذلك (faceEmbed). box و tight بإحداثيات الكاميرا */
let _groupCanvas = null;
const _cropPool = [];
async function analyzeFaces(video, max = 6){
  const W = video.videoWidth, H = video.videoHeight, s = Math.min(1, 960 / Math.max(W, H));
  const c = _groupCanvas || (_groupCanvas = document.createElement('canvas'));
  c.width = Math.round(W * s); c.height = Math.round(H * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const r = await _human.detect(c, MANY_FACES(max)), found = ((r && r.face) || []).slice(0, max), out = [];
  for(let i = 0; i < found.length; i++){
    const f = found[i], b = f.box, cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    const side = Math.min(Math.max(b[2], b[3]) * 1.5, Math.max(c.width, c.height)), x0 = cx - side / 2, y0 = cy - side / 2;
    const crop = _cropPool[i] || (_cropPool[i] = document.createElement('canvas')), CS = 320; // مربع ثابت: نفس دقة الوجه الواحد تقريبًا
    crop.width = crop.height = CS;
    const g = crop.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, CS, CS);
    g.drawImage(c, x0, y0, side, side, 0, 0, CS, CS);
    const one = await _human.detect(crop, ONE_FACE), ff = one && one.face && one.face[0];
    if(!ff || !ff.mesh || ff.mesh.length < 468) continue;
    const o = faceOut_(ff, crop, 1), k = side / CS, toCam = q => ({ x: (x0 + q.x * k) / s, y: (y0 + q.y * k) / s, width: q.width * k / s, height: q.height * k / s });
    o.box = toCam(o.box); o.tight = toCam(o.tight);
    out.push(o);
  }
  return out;
}
// محاذاة SFace: تحويل تشابه (تدوير + تكبير + إزاحة) يضع العينين وطرف الأنف وزاويتي الفم على قالب ArcFace القياسي
const FACE_TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
function fivePoints(mesh){
  const mid = (a, b) => [(mesh[a][0] + mesh[b][0]) / 2, (mesh[a][1] + mesh[b][1]) / 2];
  const eyes = [mid(33, 133), mid(362, 263)].sort((p, q) => p[0] - q[0]);
  const mouth = [mesh[61], mesh[291]].map(p => [p[0], p[1]]).sort((p, q) => p[0] - q[0]);
  return [eyes[0], eyes[1], [mesh[1][0], mesh[1][1]], mouth[0], mouth[1]];
}
let _face112 = null;
function alignFace(src, pts){
  const T = FACE_TEMPLATE, n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const tx0 = T.reduce((s, p) => s + p[0], 0) / n, ty0 = T.reduce((s, p) => s + p[1], 0) / n;
  let na = 0, nb = 0, den = 0;
  pts.forEach((p, i) => { const x = p[0] - mx, y = p[1] - my, u = T[i][0] - tx0, v = T[i][1] - ty0;
    na += x * u + y * v; nb += x * v - y * u; den += x * x + y * y; });
  const a = na / den, b = nb / den, tx = tx0 - (a * mx - b * my), ty = ty0 - (b * mx + a * my);
  const c = _face112 || (_face112 = document.createElement('canvas'));
  c.width = c.height = 112;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 112, 112);
  g.setTransform(a, b, -b, a, tx, ty); g.drawImage(src, 0, 0);
  return g.getImageData(0, 0, 112, 112).data;
}
async function faceEmbed(src, mesh){
  const d = alignFace(src, fivePoints(mesh)), plane = 112 * 112, x = new Float32Array(3 * plane);
  for(let i = 0; i < plane; i++){ x[i] = d[i * 4]; x[plane + i] = d[i * 4 + 1]; x[2 * plane + i] = d[i * 4 + 2]; } // RGB، 0–255 (كما درّبته OpenCV)
  const out = await _sface.run({ [_sface.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, 112, 112]) });
  const v = Array.from(out[_sface.outputNames[0]].data), len = Math.hypot.apply(null, v) || 1;
  return v.map(e => e / len);
}
// تشابه بصمتين بطول 1 (جيب التمام)
const faceSim = (a, b) => { let s = 0; for(let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const meanFace = descs => { const m = descs[0].map((_, i) => descs.reduce((s, d) => s + d[i], 0)), len = Math.hypot.apply(null, m) || 1; return m.map(e => e / len); };

// تشغيل الكاميرا — مشترك بين التسجيل والحضور وكاميرا الإدارة. facing: الأمامية (افتراضي) أو الخلفية environment
async function startCamera(videoEl, statusEl, readyMsg, facing, hd){
  ensureFaceModels();
  stopStream(videoEl.srcObject); // يمنع تسريب بث سابق
  try{
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
      statusEl.textContent = 'الكاميرا لا تعمل عند فتح الملف مباشرة من الجهاز. ارفع الصفحة على رابط HTTPS (مثل GitHub Pages أو Netlify) وافتحها منه';
      return null;
    }
    // hd: دقة أعلى للحضور الجماعي (وجوه صغيرة بعيدة)؛ غير ذلك الدقة الافتراضية للمتصفح (أسرع)
    const stream = await navigator.mediaDevices.getUserMedia({ video: Object.assign({ facingMode: facing || 'user' }, hd ? { width: { ideal: 1280 }, height: { ideal: 720 } } : {}) });
    videoEl.classList.toggle('cam-rear', facing === 'environment'); // الخلفية بلا انعكاس المرآة
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

// جودة اللقطة قبل الاعتماد عليها: وجه صغير (بعيد) أو على طرف الصورة يعطي بصمة أضعف
// (حدود مرنة: كانت أشد فيصعب التسجيل بهواتف كاميرتها واسعة أو في إضاءة متوسطة)
const FACE_MIN_WIDTH = 0.15; // عرض الوجه من عرض الصورة
function faceQuality(r, video){
  const b = r.box, W = video.videoWidth || 1, H = video.videoHeight || 1;
  if(b.width / W < FACE_MIN_WIDTH) return 'قرّب وجهك من الكاميرا';
  const cx = (b.x + b.width / 2) / W, cy = (b.y + b.height / 2) / H;
  if(cx < 0.15 || cx > 0.85 || cy < 0.1 || cy > 0.9) return 'ضع وجهك في منتصف الدائرة';
  const light = lightCheck(video, b);
  return light.block ? light.msg : '';
}

/* ---------- الإضاءة (الحضور تحت الشمس) ----------
   سطوع الوجه مقارنة بالصورة كلها ونصفيه (صورة مصغّرة 64 بكسل — سريع في كل لقطة):
   الشمس خلف العامل (وجه مظلم وخلفية ساطعة)، سطوع يمحو ملامح الوجه، أو ظل على نصفه — كلها تُبعد البصمة
   عن بصمة التسجيل فيُرفض صاحب الحساب. الإرشاد يظهر للعامل، ويمنع اللقطة فقط في الحالات الشديدة
   (بصمتها ستُرفض على أي حال، وكل رفض يُحسب من محاولات الإيقاف المؤقت) */
let _lightCanvas = null, _lastLightHint = '';
function lightCheck(video, box){
  const none = { msg: '', block: false };
  try{
    const W = video.videoWidth, H = video.videoHeight;
    if(!W || !H) return none;
    const cw = 64, ch = Math.max(1, Math.round(64 * H / W)), s = cw / W;
    const c = _lightCanvas || (_lightCanvas = document.createElement('canvas'));
    c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, cw, ch);
    const px = g.getImageData(0, 0, cw, ch).data;
    // منطقة الوجه (أو وسط الصورة حيث الدائرة، حين لا يُكتشف وجه)
    const x0 = Math.max(0, Math.floor(box ? box.x * s : cw * 0.3)), y0 = Math.max(0, Math.floor(box ? box.y * s : ch * 0.25));
    const x1 = Math.min(cw, Math.ceil(box ? (box.x + box.width) * s : cw * 0.7)), y1 = Math.min(ch, Math.ceil(box ? (box.y + box.height) * s : ch * 0.75));
    const mid = (x0 + x1) / 2;
    let all = 0, face = 0, nf = 0, left = 0, nl = 0, right = 0, nr = 0;
    for(let y = 0; y < ch; y++) for(let x = 0; x < cw; x++){
      const i = (y * cw + x) * 4, l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      all += l;
      if(x >= x0 && x < x1 && y >= y0 && y < y1){ face += l; nf++; if(x < mid){ left += l; nl++; } else { right += l; nr++; } }
    }
    if(!nf) return none;
    const fm = face / nf, am = all / (cw * ch), side = nl && nr ? Math.abs(left / nl - right / nr) : 0;
    let r = none;
    if(fm > 225) r = { msg: 'ضوء الشمس قوي جدًا على وجهك — قف في الظل أو ظلّل وجهك بيدك', block: fm > 242 };
    else if(fm < 70 && am - fm > 35) r = { msg: 'الشمس خلفك — استدر ليكون الضوء على وجهك', block: fm < 35 };
    else if(fm < 50) r = { msg: 'الإضاءة ضعيفة — اتجه نحو الضوء', block: fm < 25 };
    else if(side > 60) r = { msg: 'ظل قوي على نصف وجهك — اجعل الشمس أمامك أو قف في الظل', block: false };
    _lastLightHint = r.msg;
    return r;
  }catch(e){ return none; }
}
/* ---------- حدود المطابقة (تشابه SFace؛ نفسها في الخادم Code.gs) ----------
   مقاسة على صور اختبار (8 أشخاص): أضعف مطابقة لنفس الشخص 0.51، وأقرب شخصين مختلفين 0.37.
   الحضور: متوسط اللقطتين ≥ 0.45 ولا لقطة أقل من 0.40 — مع هامش واضح من الجهتين */
const FACE_SIM_AVG = 0.45, FACE_SIM_MIN = 0.40;
const FACE_SIM_SAME = 0.40;   // لقطات التسجيل الأمامية: كلها لنفس الوجه
const FACE_SIM_TURN = 0.36;   // لقطة الرأس المائل مقارنة بالأمامية (الزاوية تُنزل التشابه قليلًا)
const FACE_SIM_STEADY = 0.5;  // لقطتا الحضور المتتاليتان لنفس الوجه (وإلا تغيّر الشخص أو اهتزت الصورة)
function stopStream(stream){
  if(stream){ stream.getTracks().forEach(t=>t.stop()); }
}

/* ---------- بصمة مرجعية كاملة: تسجيل حساب جديد، أو تحديث بصمة عامل ----------
   أشد من الحضور، لأنها المرجع الذي يُقارن به كل حضور لاحق:
   1) ثلاث لقطات أمامية واضحة (حجم الوجه وموضعه والإضاءة والنظر للكاميرا) متطابقة فيما بينها
   2) لقطة والرأس مائل قليلًا لأحد الجانبين، ثم للجانب الآخر — كل واحدة تطابق اللقطات الأمامية:
      تثبت أن أمام الكاميرا وجهًا حيًا يتحرك (لا صورة ثابتة)، وتعطي بصمات من زوايا مختلفة فيُقبل الحضور بسهولة
   النتيجة: 5 بصمات (الخادم يضيف متوسط الأمامية)، ونسخ اللقطات الأمامية (لتحديث بصمة عامل قديم) */
/* السرعة (2.19.1): لا انتظار ثابت بين اللقطات (التحليل نفسه يحدد الإيقاع)، والرأس يكفي أن يدور 12° (كانت 15°:
 * يدير العامل رأسه «قليلًا» كما يُطلب منه فلا تكفي)، وبعد اللقطات الأمامية لا يُعاد الالتقاط من البداية لتأخر الدوران —
 * يبقى الإرشاد حتى يدير رأسه. الدقة كما هي: نفس شروط اللقطات ونفس حدود التشابه */
const ENROLL_FRONT = 3, FRONT_MAX_YAW = 15, FRONT_MAX_PITCH = 20, TURN_MIN = 12, TURN_MAX = 45;
const ENROLL_FRONT_MS = 45000;  // اللقطات الأمامية لم تكتمل خلال هذا: رسالة السبب ثم محاولة جديدة
/* (2.20) بصمة كل لقطة صالحة تُحسب في الخيط الخلفي أثناء كشف الوجه في اللقطة التالية (pend)، وتُعالَج بعده بنفس
 * الترتيب والشروط — لا انتظار بين اللقطات */
async function captureEnrollment(video, status, alive){
  const front = [], yaws = [], turns = [];
  let frontYaw = 0, side = 0, misses = 0, odd = 0, turnOdd = 0, t0 = Date.now(), turnAt = 0;
  let pend = null; // لقطة صالحة بصمتها قيد الحساب: { p، yaw، وللدوران: turn و dy }
  const say = m => { status.textContent = m; };
  const turnMsg = () => turnAt && Date.now() - turnAt > 12000
    ? 'أدر رأسك ببطء نحو ' + (side ? 'الجانب الآخر' : 'اليمين أو اليسار') + ' ووجهك داخل الدائرة'
    : side ? '✓ الآن أدر رأسك قليلًا إلى الجانب الآخر' : '✓ ممتاز — الآن أدر رأسك قليلًا إلى أحد الجانبين ↔';
  // بصمة اللقطة السابقة (جاهزة غالبًا: حُسبت أثناء كشف الحالية) — تُعالَج قبل الحكم على اللقطة الحالية،
  // لأنها قد تغيّر المرحلة (اكتمال الأمامية، أو جانب الدوران). يعيد النتيجة النهائية حين يكتمل الالتقاط
  const settle = async () => {
    if(!pend) return null;
    const x = pend; pend = null;
    const d = await x.p;
    if(!d) return null;
    if(!x.turn){
      if(front.length >= ENROLL_FRONT) return null;
      // لقطة لا تشبه ما قبلها (اهتزاز) تُتجاهل؛ لقطتان متتاليتان لا تشبهان = الأولى هي السيئة فتُستبدل
      if(front.some(s => faceSim(s, d) < FACE_SIM_SAME)){
        if(++odd >= 2){ front.splice(0, front.length, d); yaws.splice(0, yaws.length, x.yaw); odd = 0; }
        return null;
      }
      odd = 0; front.push(d); yaws.push(x.yaw);
      if(front.length === ENROLL_FRONT){ frontYaw = yaws.reduce((s, y) => s + y, 0) / yaws.length; turnAt = Date.now(); say(turnMsg()); }
      else say(`جاري الالتقاط (${front.length + 1}/${ENROLL_FRONT})... ثبّت وجهك وانظر للكاميرا`);
      return null;
    }
    if(side && Math.sign(x.dy) === side) return null; // الجانب نفسه التُقط بلقطة سبقتها
    if(faceSim(meanFace(front), d) < FACE_SIM_TURN){
      // وجه مختلف عن اللقطات الأمامية: إن تكرر يُعاد التسجيل من البداية (تبدّل الشخص أمام الكاميرا)
      if(++turnOdd >= 6) return { error: 'الوجه تغيّر أثناء الالتقاط' };
      say('أدر رأسك ببطء ووجهك داخل الدائرة'); return null;
    }
    turns.push(d); side = Math.sign(x.dy); turnAt = Date.now();
    if(turns.length === 2) return { descriptors: front.concat(turns) };
    say(turnMsg()); return null;
  };
  while(alive()){
    await sleep(30); // يسمح للمتصفح برسم الشاشة والرسائل بين اللقطات
    if(!modelsReady || video.readyState < 2 || !video.videoWidth){ ensureFaceModels(); say(faceLoadingMsg()); t0 = Date.now(); await sleep(250); continue; }
    if(front.length < ENROLL_FRONT && Date.now() - t0 > ENROLL_FRONT_MS)
      return { error: 'تعذر الالتقاط — ' + (_lastLightHint || 'ثبّت الهاتف ووجهك في إضاءة جيدة') };
    let r = null;
    try{ r = await analyzeFace(video, false); }catch(e){}
    if(!alive()) return null;
    const done = await settle();
    if(done || !alive()) return done;
    const bad = !r ? (lightCheck(video, null).msg || 'ضع وجهك داخل الدائرة') : r.score < AUTO_MIN_SCORE ? 'ثبّت وجهك داخل الدائرة' : faceQuality(r, video);
    if(bad){ if(++misses >= 3) say(bad); continue; }
    misses = 0;
    if(front.length < ENROLL_FRONT){
      if(Math.abs(r.yaw) > FRONT_MAX_YAW || Math.abs(r.pitch) > FRONT_MAX_PITCH){ say('انظر إلى الكاميرا مباشرة'); continue; }
      pend = { p: faceEmbed(r.frame, r.mesh).catch(() => null), yaw: r.yaw }; // اللقطة تُنسخ لحظة الطلب
      continue;
    }
    const dy = r.yaw - frontYaw;
    if(Math.abs(dy) < TURN_MIN || Math.abs(r.yaw) > TURN_MAX || (side && Math.sign(dy) === side)){
      say(Math.abs(r.yaw) > TURN_MAX ? 'أدر رأسك أقل قليلًا' : turnMsg()); continue;
    }
    pend = { p: faceEmbed(r.frame, r.mesh).catch(() => null), turn: true, dy };
  }
  return null;
}
