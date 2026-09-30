/*************************************************************************
 * حضور الحماية العالمية (UniGuard Attendance) — الخادم الخلفي (Google Apps Script)
 * كل بيانات العمال والحضور والسلف والتصفيات تُقرأ وتُكتب من هذا الشيت فقط — هو المصدر الوحيد.
 * التطبيق يحفظ نسخة محلية من آخر بيانات وصلته للفتح السريع فقط، ويحدّثها من هنا.
 *
 * أعمدة كل ورقة بالعربية للقراءة البشرية، لكن الكود يتعامل معها بترتيبها
 * (لا بنص العنوان)، فلا تحذف عمودًا ولا تُبدّل ترتيب الأعمدة يدويًا.
 * ورقة "العمال" لا تحتوي على أي بيانات جهاز إطلاقًا — كل ما يخص الأجهزة
 * (الموافقة/الرفض/الربط برقم الهاتف) موجود حصرًا في ورقة "بصمة الجهاز".
 *
 * الإعداد:
 * 1) أنشئ Google Sheet جديد فارغ.
 * 2) من القائمة: Extensions > Apps Script، احذف الكود الافتراضي والصق هذا الملف كاملًا.
 * 3) Project Settings > Script Properties، أضف:
 *      ADMIN_PASSWORD = كلمة مرور مؤقتة لأول دخول فقط: بها تُنشئ حساب الإدارة الأساسي (اسم مستخدم +
 *                       كلمة مرور جديدة)، ثم تُحذف تلقائيًا. صفحة الإدارة: admin.html
 *      API_KEY        = نص عشوائي طويل من اختيارك
 *      أو: ADMIN_USER + ADMIN_PASSWORD معًا = تعيين اسم المستخدم وكلمة المرور مباشرة.
 *    نسيت كلمة المرور؟ ضع ADMIN_USER و ADMIN_PASSWORD من جديد، أو شغّل resetAdminAccess.
 * 4) شغّل دالة setupSheets مرة واحدة يدويًا من المحرر (اختر الدالة من القائمة
 *    العلوية ثم Run) لإنشاء كل الأوراق والعناوين العربية فورًا.
 *    إن كان لديك بيانات قديمة: شغّل migrateData مرة واحدة وراجع السجل (Execution log).
 * 5) Deploy > New deployment > Web app — Execute as: Me — Who has access: Anyone.
 *    انسخ رابط /exec وضعه في app.html في WEB_APP_URL، ونفس API_KEY في SHEET_API_KEY.
 * 6) عند أي تعديل لاحق على هذا الكود: Deploy > Manage deployments > ✏️ > New version > Deploy
 *    (رابط /exec يبقى كما هو، لا تنشئ Deployment جديدًا من الصفر).
 * 7) شغّل setupAutoReport مرة واحدة: ورقة "تقرير الشهر (مباشر)" تتحدّث تلقائيًا كل 10 دقائق،
 *    ويظهر في الشيت قائمة "UniGuard — الحماية العالمية ← تحديث التقرير الشهري الآن" للتحديث الفوري.
 * 8) (اختياري ومستحسن) في Script Properties أضف ALLOWED_ORIGINS = رابط موقع التطبيق بدون مسار،
 *    مثل https://username.github.io — فلا يعمل "الفتح بقفل الهاتف" إلا من التطبيق الرسمي.
 * 9) بعد تعديل API_KEY أو ALLOWED_ORIGINS في Script Properties شغّل refreshConfig مرة (تُحفظ مؤقتًا 6 ساعات).
 *************************************************************************/

// إصدار الخادم: يظهر في "حول التطبيق" بجانب إصدار الواجهة (APP_VERSION في app.html) — ارفعهما معًا
const SERVER_VERSION = '2.9.4';
const SERVER_BUILD = '2026-09-30'; // تاريخ هذا الإصدار — يظهر في «حول التطبيق» بلوحة الإدارة

/* اسم كل ورقة بالعربية، وترتيب الحقول الداخلي الثابت (لا علاقة له بنص العنوان) */
const SHEETS = {
  // reviewNote (2.9.4): تنبيه للإدارة على طلب التسجيل (وجه مطابق لعامل مسجل) — يُمسح عند القبول
  Workers:     { name: 'العمال',       fields: ['id','name','profession','phone','wage','status','descriptor','createdAt','lastSettledAt','reviewNote'],
                 labels: ['المعرف','الاسم','المهنة','رقم الهاتف','الأجر اليومي','الحالة','بصمة الوجه (لا تُعدَّل يدويًا)','تاريخ التسجيل','آخر تصفية (طابع زمني)','تنبيه للإدارة'] },
  Log:         { name: 'الدوام',       fields: ['id','workerId','workerName','wage','date','time','timestamp','status'],
                 labels: ['المعرف','معرف العامل','اسم العامل','الأجر اليومي وقت التسجيل','التاريخ','الوقت','الطابع الزمني','الحالة'] },
  Advances:    { name: 'السلف',        fields: ['id','workerId','workerName','amount','note','date','timestamp'],
                 labels: ['المعرف','معرف العامل','اسم العامل','المبلغ','ملاحظة','التاريخ','الطابع الزمني'] },
  // الأعمدة الخمسة الأخيرة أُضيفت لاحقًا: تفاصيل التصفية التي تظهر للعامل، ولحظة ضغطه "تم" (اطّلع عليها)
  Settlements: { name: 'التصفيات',     fields: ['id','workerId','workerName','amount','date','timestamp','month','earned','advances','carried','days','ackAt'],
                 labels: ['المعرف','معرف العامل','اسم العامل','الصافي المدفوع','التاريخ','الطابع الزمني','الشهر (إن كانت تصفية شهرية)',
                          'المستحق','السلف','رصيد سالب مرحّل','أيام العمل المعتمدة','اطّلع العامل عليها (طابع زمني)'] },
  // الأعمدة الأربعة الأخيرة أُضيفت لاحقًا (في النهاية حتى لا يختل ترتيب البيانات القديمة)
  Archives:    { name: 'الأرشيف الشهري', fields: ['id','month','monthLabel','closedAt','totalWorkers','totalNet','numDays','accountsJson','matrixJson','totalCost','totalAdvances','totalCarried','reportSheet','signature'],
                 labels: ['المعرف','الشهر','اسم الشهر','تاريخ الإقفال','عدد العمال','إجمالي الصافي المدفوع','عدد أيام الشهر','بيانات الحسابات (JSON) — للأرشيف القديم','بيانات كشف الدوام (JSON) — للأرشيف القديم','التكلفة التشغيلية الإجمالية','إجمالي السلف','إجمالي الرصيد السالب المرحّل','ملف التقرير (رابط)','توقيع الخادم (لا يُعدَّل)'] },
  // التقرير الشهري الكامل (JSON) مقسّم على عدة صفوف — خلية الشيت لا تتسع لأكثر من 50,000 حرف
  ArchiveData: { name: 'بيانات الأرشيف', fields: ['id','archiveId','part','chunk'],
                 labels: ['المعرف','معرف الأرشيف','رقم الجزء','البيانات (JSON مجزأ — لا تُعدَّل يدويًا)'] },
  // أعمدة pk* (مفتاح قفل الهاتف) أُضيفت لاحقًا في النهاية: المفتاح مرتبط بالجهاز المعتمد نفسه،
  // فاعتماد جهاز جديد يُسقط مفتاح الجهاز القديم تلقائيًا. model/os/browser (2.9.2): معلومات الهاتف المربوط —
  // الطراز ثابت لنفس الجهاز: تغيّره مع نفس معرّف الجهاز = الحساب يُفتح من هاتف آخر ← موافقة الإدارة من جديد
  Devices:     { name: 'بصمة الجهاز',  fields: ['id','phone','workerName','deviceId','userAgent','status','createdAt','decidedAt','pkId','pkKey','pkAlg','pkRp','pkCount','model','os','browser'],
                 labels: ['المعرف','رقم الهاتف','اسم العامل','معرف الجهاز','معلومات الجهاز/المتصفح','الحالة (pending/approved/rejected/replaced)','تاريخ الطلب','تاريخ الربط/القرار',
                          'قفل الهاتف: معرّف المفتاح','قفل الهاتف: المفتاح العام (لا يُعدَّل)','قفل الهاتف: نوع المفتاح','قفل الهاتف: نطاق التطبيق','قفل الهاتف: عداد الاستخدام',
                          'طراز الهاتف','نظام التشغيل','المتصفح'] },
  DeviceLogs:  { name: 'Logs',        fields: ['id','phone','workerName','deviceId','userAgent','event','timestamp'],
                 labels: ['المعرف','رقم الهاتف','اسم العامل','معرف الجهاز','معلومات الجهاز/المتصفح','الحدث','الطابع الزمني'] }
};

/* كل الحقول تُحفظ كنص حرفيًا ما عدا الحقول الرقمية أدناه — وإلا يحوّلها الشيت تلقائيًا:
 *  "0501234567" → 501234567 (يضيع الصفر وتفشل المطابقة فيتكرر إنشاء الحساب وطلبات الجهاز)
 *  "2026-09-29" → كائن Date (تفشل مقارنة التاريخ فيُسمح بأكثر من حضور في اليوم،
 *                 ويتعطل إقفال الشهر بخطأ r.date.indexOf is not a function)
 *  "08:30" → Date سنة 1899، و "2026-09" → Date */
const NUMBER_FIELDS = { wage:1, amount:1, timestamp:1, lastSettledAt:1, totalWorkers:1, totalNet:1, numDays:1,
  totalCost:1, totalAdvances:1, totalCarried:1, part:1, pkAlg:1, pkCount:1,
  earned:1, advances:1, carried:1, days:1, ackAt:1 };
const TZ = 'Asia/Riyadh';

/* ---------------------------- أدوات التطبيع ---------------------------- */
// مفتاح مقارنة للهاتف: أرقام فقط بدون أصفار بادئة. يطابق "0501234567" مع 501234567
// المخزّن رقميًا في البيانات القديمة، ومع "+966..." المخزّن كرقم 966...
function phoneKey_(v){
  return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, '');
}
function samePhone_(a, b){ const ka = phoneKey_(a); return ka !== '' && ka === phoneKey_(b); }
function dateStr_(v){
  if(v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v == null ? '' : v);
}
function timeStr_(v){
  if(v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  return String(v == null ? '' : v);
}
function monthStr_(v){
  if(v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM');
  return String(v == null ? '' : v);
}
function isoStr_(v){ return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }
function cellValue_(field, v){
  if(v === undefined || v === null || v === '') return '';
  if(NUMBER_FIELDS[field]) return Number(v) || 0;
  if(v instanceof Date){
    // صفوف قديمة حوّل الشيت تاريخها إلى Date: تُعاد بصيغتها النصية الأصلية لا بصيغة ISO
    if(field === 'date') return dateStr_(v);
    if(field === 'time') return timeStr_(v);
    if(field === 'month') return monthStr_(v);
    return v.toISOString();
  }
  return String(v);
}
function formatsRow_(key){ return SHEETS[key].fields.map(f => NUMBER_FIELDS[f] ? '0.##' : '@'); }
// يضبط تنسيق النص قبل الكتابة، فلا يحوّل الشيت أي قيمة إلى رقم أو تاريخ
function writeRows_(key, startRow, rows){
  const sh = sheet_(key);
  const n = SHEETS[key].fields.length;
  const fmt = formatsRow_(key);
  // الورقة الجديدة 1000 صف فقط: الكتابة بعدها تفشل ("خارج حدود الورقة") فيتوقف تسجيل الحضور
  const need = startRow + rows.length - 1, max = sh.getMaxRows();
  if(need > max) sh.insertRowsAfter(max, need - max + 500);
  const range = sh.getRange(startRow, 1, rows.length, n);
  range.setNumberFormats(rows.map(() => fmt));
  range.setValues(rows);
}

/* ---------------------------- أدوات الشيت ---------------------------- */
let _ss = null;
function ss_(){ return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet()); }

// تُعاد تهيئتها في بداية كل تنفيذ (كل doPost تنفيذ مستقل)
let _sheetHandles = {};
let _sheetDataCache = {};

// تجهيز كسول: ورقة واحدة عند الحاجة فقط بدل فحص 7 أوراق في كل طلب
function sheet_(key){
  if(_sheetHandles[key]) return _sheetHandles[key];
  const def = SHEETS[key];
  const ss = ss_();
  let sh = ss.getSheetByName(def.name);
  if(!sh){
    sh = ss.insertSheet(def.name);
    sh.appendRow(def.labels);
    sh.setFrozenRows(1);
    formatTextColumns_(sh, key);
  }
  _sheetHandles[key] = sh;
  return sh;
}
function formatTextColumns_(sh, key){
  SHEETS[key].fields.forEach((f, i) => {
    sh.getRange(1, i+1, sh.getMaxRows(), 1).setNumberFormat(NUMBER_FIELDS[f] ? '0.##' : '@');
  });
}

// يقرأ الورقة مرة واحدة لكل تنفيذ. rowNum = رقم الصف في الشيت (لتحديث/حذف بدون إعادة قراءة)
function readAll_(key){
  if(_sheetDataCache[key]) return _sheetDataCache[key];
  const sh = sheet_(key);
  const fields = SHEETS[key].fields;
  const rows = [];
  // نداء واحد (getDataRange) بدل getLastRow ثم getValues
  const values = sh.getDataRange().getValues();
  for(let i = 1; i < values.length; i++){
    const row = values[i];
    if(row[0] === '' || row[0] == null) continue;
    const o = { _row: i+1 };
    fields.forEach((f, j) => o[f] = row[j] === undefined ? '' : row[j]);
    rows.push(o);
  }
  _sheetDataCache[key] = rows;
  _lastRow[key] = values.length;
  return rows;
}
let _lastRow = {}; // آخر صف مستخدم في كل ورقة (يُعرف من القراءة، فلا حاجة لـ getLastRow قبل الإضافة)
function invalidate_(key){ delete _sheetDataCache[key]; delete _lastRow[key]; }
function invalidateAll_(){ _sheetDataCache = {}; _lastRow = {}; }

const cache_ = () => CacheService.getScriptCache();
const props_ = () => PropertiesService.getScriptProperties();
const CACHE_TTL = 21600; // 6 ساعات: أقصى مدة للذاكرة المؤقتة في Apps Script
/* إعدادات تُقرأ مع كل طلب (API_KEY، ALLOWED_ORIGINS، مفتاح الجلسات): من الذاكرة المؤقتة، ومن Script Properties
 * مرة كل 6 ساعات فقط. لخدمة الإعدادات حصة قراءة يومية؛ قراءتها مع كل طلب (كل هاتف يسأل كل 20 ثانية) كانت
 * تستنفدها فيرد Google بصفحة خطأ بدل البيانات لكل الطلبات: «رد غير صالح من الخادم» وانقطاع التحديث.
 * بعد تعديل هذه القيم في Script Properties شغّل refreshConfig من المحرر ليُطبَّق التعديل فورًا. */
function cfg_(name){
  const c = cache_(), k = 'cfg_' + name;
  let v = c.get(k);
  if(v === null){ v = props_().getProperty(name) || ''; try{ c.put(k, v || '~', CACHE_TTL); }catch(e){} }
  return v === '~' ? '' : v;
}
function refreshConfig(){ cache_().removeAll(['cfg_API_KEY', 'cfg_ALLOWED_ORIGINS', 'cfg_WS_SECRET']); Logger.log('تم تحديث الإعدادات ✓'); }

// رقم إصدار البيانات: يتغير مع كل كتابة. التحديث الخلفي في التطبيق يرسل آخر إصدار لديه، فإن لم يتغير
// يُرد فورًا بـ {unchanged:true} دون قراءة أي ورقة (استعلام كل 20 ثانية يبقى خفيفًا على الخادم)
// يُغيَّر الإصدار مرة واحدة بعد اكتمال العملية كلها (لا بعد أول كتابة)، وإلا قد يقرأ التحديث الخلفي
// نصف عملية متعددة الخطوات (مثل إقفال الشهر) بالإصدار الجديد فلا يرى بقيتها أبدًا.
// ولكل عامل إصدار خاص (wv_<id>) يتغير فقط حين تتغير بياناته هو: هاتف العامل لا يعيد قراءة الشيت
// لأن عاملًا آخر سجّل حضوره (وقت الذروة الصباحي كان يعني قراءة كل الأوراق لكل هاتف مع كل حضور)
/* سجل التغييرات (لكل إصدار جديد: الصفوف التي تغيّرت أو حُذفت + الإصدار السابق): لوحة الإدارة تطلب «ما تغيّر
 * منذ إصداري» فيصلها ما تغيّر فقط بدل كل البيانات. السلسلة من الإصدار الحالي حتى إصدار اللوحة يجب أن تكون
 * متصلة (في الذاكرة المؤقتة 6 ساعات)؛ أي انقطاع (تعديل يدوي في الشيت، انتهاء المدة، تغيير ضخم) = نسخة كاملة */
const JOURNAL_SHEETS = { Workers:1, Log:1, Advances:1, Archives:1, Devices:1 };
let _dirtyWrite = false, _touched = { ids:{}, phones:{} }, _journal = { c:{}, r:{} };
function bumpDataVersion_(){ _dirtyWrite = true; }
// العمال الذين تغيّرت بياناتهم في هذا التنفيذ (من الصفوف المكتوبة نفسها — لا حاجة لتذكّر ذلك في كل عملية)
// removed: صفوف حُذفت (deleteWhere_) — تُسجَّل في سجل التغييرات كمحذوفة
function touchRows_(key, rows, removed){
  if(key === 'Workers') rows.forEach(r => _touched.ids[String(r.id)] = 1);
  else if(key === 'Log' || key === 'Advances' || key === 'Settlements') rows.forEach(r => _touched.ids[String(r.workerId)] = 1);
  else if(key === 'Devices') rows.forEach(r => { const k = phoneKey_(r.phone); if(k) _touched.phones[k] = 1; });
  if(JOURNAL_SHEETS[key]){
    const b = removed ? _journal.r : _journal.c, m = b[key] || (b[key] = {});
    rows.forEach(r => { if(r && r.id !== '' && r.id != null) m[String(r.id)] = 1; });
  }
}
// يعيد الإصدار الجديد (أو '' إن لم تحدث كتابة)
function commitDataVersion_(){
  const t = _touched, j = _journal; _touched = { ids:{}, phones:{} }; _journal = { c:{}, r:{} };
  if(!_dirtyWrite) return '';
  _dirtyWrite = false;
  const c = cache_(), prev = c.get('data_ver') || '', v = newId_(), put = { data_ver: v };
  if(Object.keys(t.phones).length) readAll_('Workers').forEach(w => { if(t.phones[phoneKey_(w.phone)]) t.ids[String(w.id)] = 1; });
  Object.keys(t.ids).forEach(id => put['wv_' + id] = v);
  const ids = k => Object.keys(j.c[k] || {}), gone = k => Object.keys(j.r[k] || {});
  const rec = { p: prev, w: Object.keys(t.ids), l: ids('Log'), a: ids('Advances'), rw: gone('Workers'), rl: gone('Log'), ra: gone('Advances'),
    ar: j.c.Archives || j.r.Archives ? 1 : 0, d: j.c.Devices || j.r.Devices ? 1 : 0 };
  let s = JSON.stringify(rec);
  if(s.length > 90000) s = JSON.stringify({ p: prev, full: 1 }); // تغيير ضخم (إقفال شهر لعمال كثيرين): نسخة كاملة
  put['chg_' + v] = s;
  try{ c.putAll(put, CACHE_TTL); }catch(e){}
  return v;
}
// التغييرات منذ إصدار (since) حتى الإصدار الحالي، أو null إن انقطعت السلسلة (يلزم نسخة كاملة)
function changesSince_(since, version){
  const c = cache_(), acc = { w:{}, l:{}, a:{}, rw:{}, rl:{}, ra:{}, ar:0, d:0 };
  for(let v = version, i = 0; i < 120; i++){
    if(v === since) return acc;
    let r = null; try{ r = JSON.parse(c.get('chg_' + v) || 'null'); }catch(e){}
    if(!r || r.full || !r.p) return null;
    ['w','l','a','rw','rl','ra'].forEach(k => (r[k] || []).forEach(id => acc[k][id] = 1));
    if(r.ar) acc.ar = 1;
    if(r.d) acc.d = 1;
    v = r.p;
  }
  return null;
}
function dataVersion_(){
  const c = cache_();
  let v = c.get('data_ver');
  if(!v){ v = newId_(); c.put('data_ver', v, CACHE_TTL); }
  return v;
}
// إصدار بيانات عامل واحد (wv_epoch يتغير مع أي تعديل يدوي في الشيت فيشمل الجميع).
// القيمة المفقودة (انتهت مدتها أو حُذفت من الذاكرة) تُنشأ عشوائية لا ثابتة: لو عادت '0' بعد حذفها
// لطابقت ما لدى الهاتف رغم حدوث كتابة بينهما، فيفوته التغيير
function workerVersion_(id){
  const c = cache_(), k = 'wv_' + id, g = c.getAll(['wv_epoch', k]), put = {};
  if(!g.wv_epoch) put.wv_epoch = g.wv_epoch = newId_();
  if(!g[k]) put[k] = g[k] = newId_();
  if(Object.keys(put).length) try{ c.putAll(put, CACHE_TTL); }catch(e){}
  return g.wv_epoch + ':' + g[k];
}

// أي تغيير في هذه الأوراق يعني أن التقرير المباشر يحتاج إعادة بناء (يتم في المشغّل الدوري، لا هنا)
const REPORT_SOURCES = { Workers:1, Log:1, Advances:1 };
let _reportDirtyMarked = false;
function markReportDirty_(key, rows){
  bumpDataVersion_();
  if(rows) touchRows_(key, rows);
  if(!REPORT_SOURCES[key] || _reportDirtyMarked) return;
  _reportDirtyMarked = true;
  try{ cache_().put('report_dirty', '1', CACHE_TTL); }catch(e){}
}

function rowOf_(key, obj){ return SHEETS[key].fields.map(f => cellValue_(f, obj[f])); }
// نسخة الكائن كما سيقرؤها الشيت بعد الكتابة — لتحديث الذاكرة المؤقتة بدل إعادة قراءة الورقة
function cachedOf_(key, obj, rowNum){
  const o = { _row: rowNum };
  SHEETS[key].fields.forEach(f => o[f] = cellValue_(f, obj[f]));
  return o;
}

// كتابة عدة صفوف دفعة واحدة (نداء واحد بدل appendRow لكل صف)
function appendMany_(key, objs){
  if(!objs.length) return;
  const start = (_lastRow[key] != null ? _lastRow[key] : sheet_(key).getLastRow()) + 1;
  writeRows_(key, start, objs.map(o => rowOf_(key, o)));
  const cache = _sheetDataCache[key];
  if(cache) objs.forEach((o, i) => cache.push(cachedOf_(key, o, start + i)));
  _lastRow[key] = start + objs.length - 1;
  markReportDirty_(key, objs);
}
function appendObj_(key, obj){ appendMany_(key, [obj]); }

// تحديث عدة صفوف معروفة (من readAll_) — لا يعيد قراءة الشيت
// الصفوف المتجاورة تُكتب في نداء واحد (إقفال شهر لـ 100 عامل = نداء واحد بدل 100)
function updateRows_(key, patches /* [{row, patch}] */){
  if(!patches.length) return;
  const sorted = patches.slice().sort((a, b) => a.row._row - b.row._row);
  let start = 0;
  for(let i = 1; i <= sorted.length; i++){
    if(i < sorted.length && sorted[i].row._row === sorted[i-1].row._row + 1) continue;
    const run = sorted.slice(start, i);
    writeRows_(key, run[0].row._row, run.map(p => rowOf_(key, Object.assign({}, p.row, p.patch))));
    start = i;
  }
  markReportDirty_(key, patches.map(p => Object.assign({}, p.row, p.patch)));
  // تحديث الصفوف في الذاكرة مباشرة (هي نفس كائنات readAll_) بدل إعادة قراءة الورقة كاملة
  const cache = _sheetDataCache[key];
  if(!cache) return;
  const byRow = {}; cache.forEach(r => byRow[r._row] = r);
  patches.forEach(p => { const r = byRow[p.row._row]; if(r) Object.assign(r, cachedOf_(key, Object.assign({}, r, p.patch), r._row)); });
}
function updateById_(key, id, patch){
  const row = readAll_(key).find(r => String(r.id) === String(id));
  if(!row) return null;
  updateRows_(key, [{ row, patch }]);
  return Object.assign({}, row, patch);
}

// حذف بالشرط: إعادة كتابة الورقة مرة واحدة بدل deleteRow لكل صف (أسرع بكثير).
// الكتابة فوق البيانات أولًا ثم مسح الذيل: لو انقطع التنفيذ بينهما تبقى صفوف مكررة لا مفقودة
function deleteWhere_(key, predicate){
  const rows = readAll_(key);
  const keep = rows.filter(r => !predicate(r));
  if(keep.length === rows.length) return 0;
  touchRows_(key, rows.filter(predicate), true);
  const sh = sheet_(key);
  const n = SHEETS[key].fields.length;
  const lastRow = sh.getLastRow();
  if(keep.length) writeRows_(key, 2, keep.map(r => rowOf_(key, r)));
  const tail = keep.length + 2;
  if(lastRow >= tail) sh.getRange(tail, 1, lastRow - tail + 1, n).clearContent();
  invalidate_(key);
  markReportDirty_(key);
  return rows.length - keep.length;
}

function newId_(){ return Utilities.getUuid(); }

// رسائل أخطاء مشتركة
const ERR_WORKER = 'العامل غير موجود', ERR_KEY = 'مفتاح غير صالح', ERR_CLIENT_DATA = 'بيانات التحقق غير صالحة',
      ERR_KEY_ORIGIN = 'المفتاح لا يخص رابط هذا التطبيق', ERR_SESSION = 'الجلسة غير صالحة',
      ERR_DELETED = 'حساب هذا العامل محذوف';
function workerById_(id){ return readAll_('Workers').find(w => String(w.id) === String(id)) || null; }

/* ---------------------------- تنقية المدخلات قبل كتابتها في الشيت ----------------------------
 * أي نص يأتي من الهاتف يُكتب في ورقة يفتحها المالك: بلا رموز تحكم، وبلا = + - @ في أوله
 * (لا يُفسَّر كمعادلة عند فتح الشيت أو تصديره). رقم الهاتف ومعرّف الجهاز بصيغة صارمة. */
function safeText_(v, max){ return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/^[\s=+\-@'"]+/, '').trim().slice(0, max); }
function cleanPhone_(v){ const p = String(v == null ? '' : v).trim(); return /^\+?\d{8,15}$/.test(p) ? p : ''; }
// معلومات الهاتف التي ترسلها الواجهة (الطراز، النظام، المتصفح) — نصوص قصيرة منقّاة
function deviceInfo_(data){
  const d = data && data.device && typeof data.device === 'object' ? data.device : {};
  return { model: safeText_(d.model, 40), os: safeText_(d.os, 40), browser: safeText_(d.browser, 40) };
}
// مقارنة متسامحة للطراز: نفس الهاتف قد يُعرَّف بـ "SAMSUNG SM-A546E" (نص المتصفح) أو "SM-A546E" (تلميحات المتصفح)
const normModel_ = v => String(v || '').toLowerCase().replace(/samsung|build\/.*$/g, '').replace(/[^a-z0-9]/g, '');
function sameModel_(a, b){
  const x = normModel_(a), y = normModel_(b);
  return x === y || (!!x && !!y && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}
const validDeviceId_ = id => /^[A-Za-z0-9_-]{1,100}$/.test(String(id || ''));

/* قفل عام: كل عمليات الكتابة تمر به لمنع تسابق طلبين متزامنين */
function withLock_(fn){
  const lock = LockService.getScriptLock();
  if(!lock.tryLock(20000)) throw new Error('الخادم مشغول حاليًا، حاول بعد ثوانٍ');
  try{
    invalidateAll_(); // قراءة طازجة إلزامية بعد الحصول على القفل
    const result = fn();
    commitNotifications_(); // نصوص الإشعارات تُكتب داخل القفل مع العملية نفسها
    return result;
  } finally { _outbox = []; commitDataVersion_(); lock.releaseLock(); }
}

/* ---------------------------- تحويل الأنواع للعميل ---------------------------- */
// بصمة الوجه لا تُرسل للمتصفح إطلاقًا — المقارنة تتم في الخادم فقط (hasFace يكفي للواجهة)
function workerOut_(w){
  return {
    id: String(w.id), name: w.name, profession: w.profession, phone: String(w.phone),
    wage: Number(w.wage)||0, status: w.status || 'active',
    createdAt: isoStr_(w.createdAt), lastSettledAt: Number(w.lastSettledAt)||0,
    hasFace: storedDescriptors_(w).length > 0
  };
}
function parseDescriptor_(v){
  const d = Array.isArray(v) ? v.map(Number) : [];
  return d.length === 128 && d.every(x => isFinite(x)) ? d : null;
}
// بصمات الوجه المرجعية للعامل: عدة لقطات من التسجيل (الحسابات القديمة: بصمة واحدة)
function storedDescriptors_(w){
  let d; try{ d = JSON.parse(w.descriptor || '[]'); }catch(e){ return []; }
  if(!Array.isArray(d) || !d.length) return [];
  return (typeof d[0] === 'number' ? [d] : d).map(parseDescriptor_).filter(Boolean);
}
// لقطات الوجه المرسلة من الواجهة (حتى 5 لقطات)
function probeList_(data){
  return (Array.isArray(data.descriptors) ? data.descriptors.slice(0, 5) : []).map(parseDescriptor_).filter(Boolean);
}
/* معايرة المطابقة (مقاسة على صور حقيقية): نفس الشخص 0.40–0.56، أشخاص مختلفون 0.82 فأكثر.
 * القرار يعتمد على لقطتين عند الحضور، كل واحدة تُقارن بأقرب بصمة مرجعية:
 * المتوسط ≤ 0.55 ولا لقطة تتجاوز 0.6 — أدق من حد لقطة واحدة 0.6، ولا يرفض صاحب الحساب بسبب لقطة واحدة ضعيفة */
const FACE_MATCH_THRESHOLD = 0.55;
const FACE_MAX_DISTANCE = 0.6;
const FACE_DUPLICATE = 0.45;       // وجه جديد بهذا القرب من عامل مسجل = نفس الشخص (حساب ثانٍ)
const FACE_CONSISTENT = 0.6;       // لقطات التسجيل يجب أن تكون لنفس الوجه
const FACE_MAX_FAILS = 8;          // محاولات حضور بوجه غير مطابق في الساعة قبل الإيقاف المؤقت
function faceDistance_(a, b){
  let s = 0; for(let i = 0; i < a.length; i++){ const d = a[i] - b[i]; s += d*d; } return Math.sqrt(s);
}
function bestDistance_(probe, refs){ return Math.min.apply(null, refs.map(r => faceDistance_(probe, r))); }
const roundDesc_ = d => d.map(x => Math.round(x * 1e5) / 1e5);
// اسم العامل لا يُكرر في كل سجل: الواجهة تأخذه من قائمة العمال بالمعرّف
function logOut_(r){
  return { id:String(r.id), workerId:String(r.workerId), wage:Number(r.wage)||0,
    date:dateStr_(r.date), time:timeStr_(r.time), timestamp:Number(r.timestamp)||0, status:r.status };
}
function advanceOut_(a){
  return { id:String(a.id), workerId:String(a.workerId), amount:Number(a.amount)||0, note:a.note||'',
    date:dateStr_(a.date), timestamp:Number(a.timestamp)||0 };
}
// ملخص خفيف لقائمة الأرشيف (التقرير الكامل يُجلب عند الطلب عبر getArchive)
function archiveOut_(a){
  return { id:String(a.id), month:monthStr_(a.month), monthLabel:a.monthLabel, closedAt:isoStr_(a.closedAt),
    totalWorkers:Number(a.totalWorkers)||0, totalNet:Number(a.totalNet)||0, numDays:Number(a.numDays)||0,
    totalCost:Number(a.totalCost)||0, totalAdvances:Number(a.totalAdvances)||0, totalCarried:Number(a.totalCarried)||0,
    reportSheet:String(a.reportSheet||'') };
}

/* ---------------------------- منطق الحسابات المالية (مطابق للواجهة) ---------------------------- */
// الأجر المحفوظ لحظة تسجيل الحضور هو المعتمد (لا يتأثر بتغيير اليومية لاحقًا)؛
// وإن كان فارغًا أو صفرًا (بيانات قديمة/تالفة) نرجع لأجر العامل الحالي
function recordWage_(r, w){ const v = Number(r.wage); return v > 0 ? v : (w ? Number(w.wage)||0 : 0); }
function computeAccount_(worker, log, advances, untilTs){
  untilTs = untilTs == null ? Infinity : untilTs;
  const since = Number(worker.lastSettledAt)||0;
  const id = String(worker.id);
  const earned = log.filter(r=>String(r.workerId)===id && r.status==='approved' && Number(r.timestamp)>since && Number(r.timestamp)<=untilTs)
    .reduce((s,r)=> s + recordWage_(r, worker), 0);
  const advanced = advances.filter(a=>String(a.workerId)===id && Number(a.timestamp)>since && Number(a.timestamp)<=untilTs)
    .reduce((s,a)=> s + (Number(a.amount)||0), 0);
  return { earned: money_(earned), advanced: money_(advanced), net: money_(earned - advanced) };
}
function countPending_(worker, log, untilTs){
  untilTs = untilTs == null ? Infinity : untilTs;
  const since = Number(worker.lastSettledAt)||0;
  const id = String(worker.id);
  return log.filter(r=>String(r.workerId)===id && r.status==='pending' && Number(r.timestamp)>since && Number(r.timestamp)<=untilTs).length;
}
function riyadhTodayParts_(){
  const now = new Date();
  return {
    date: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    time: Utilities.formatDate(now, TZ, 'HH:mm'),
    month: Utilities.formatDate(now, TZ, 'yyyy-MM')
  };
}
function monthEndTs_(month){
  const y = Number(month.slice(0,4)), m = Number(month.slice(5,7));
  return Date.UTC(y, m, 1) - 3*3600*1000 - 1; // نهاية آخر يوم بتوقيت الرياض UTC+3
}
function daysInMonth_(month){
  const y = Number(month.slice(0,4)), m = Number(month.slice(5,7));
  return new Date(y, m, 0).getDate();
}
// تقريب مالي لخانتين لتفادي أخطاء الفاصلة العائمة (0.1+0.2)
function money_(v){ return Math.round((Number(v)||0) * 100) / 100; }
function monthLabel_(m){
  const names=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const y=Number(m.slice(0,4)), mm=Number(m.slice(5,7));
  return names[mm-1]+' '+y;
}

/* ---------------------------- العمال والأجهزة ---------------------------- */
// الحساب الحي (غير المحذوف) لرقم الهاتف. find() القديم كان يعيد أول صف ولو كان
// محذوفًا، فيُعامل الرقم كغير مسجل ويُطلب من العامل التسجيل مجددًا → حسابات مكررة
function liveWorker_(phone){
  return readAll_('Workers').find(w => w.status !== 'deleted' && samePhone_(w.phone, phone)) || null;
}
function approvedDeviceRow_(phone){
  const list = readAll_('Devices').filter(d => d.status === 'approved' && samePhone_(d.phone, phone));
  return list.length ? list[list.length-1] : null; // الأحدث
}
function isDeviceApproved_(phone, deviceId){
  const dev = approvedDeviceRow_(phone);
  return !!dev && deviceId !== '' && String(dev.deviceId) === deviceId;
}
// صفحة العامل تعرض الفترة الحالية فقط (منذ آخر تصفية): بعد التصفية تبدأ من جديد بلا بيانات سابقة.
// (السجل الكامل يبقى محفوظًا في الشيت ولدى الإدارة؛ وسجل اليوم يُرسل دائمًا ليعرف العامل حالة حضوره اليوم)
function workerLog_(w){
  const id = String(w.id), since = Number(w.lastSettledAt) || 0, today = riyadhTodayParts_().date;
  return readAll_('Log').filter(r => String(r.workerId) === id && (Number(r.timestamp) > since || dateStr_(r.date) === today)).map(logOut_);
}
function workerAdvances_(w){
  const id = String(w.id), since = Number(w.lastSettledAt) || 0;
  return readAll_('Advances').filter(a => String(a.workerId) === id && Number(a.timestamp) > since).map(advanceOut_);
}
function workerPayload_(w, dev){
  return { worker: workerOut_(w), log: workerLog_(w), advances: workerAdvances_(w), passkey: !!(dev && dev.pkKey), settlement: unseenSettlement_(w) };
}
// آخر تصفية لم يضغط العامل "تم" عليها بعد — تبقى نافذتها أمامه حتى يطّلع عليها (ولو فتح التطبيق من جهاز آخر).
// تصفيات النسخ السابقة (بلا تفاصيل) لا تُعرض.
function unseenSettlement_(w){
  const id = String(w.id);
  const list = readAll_('Settlements').filter(s => String(s.workerId) === id && s.earned !== '' && !Number(s.ackAt));
  if(!list.length) return null;
  const s = list.reduce((a, b) => Number(b.timestamp) > Number(a.timestamp) ? b : a);
  const month = s.month ? monthStr_(s.month) : '';
  return { id:String(s.id), date:dateStr_(s.date), month, monthLabel: month ? monthLabel_(month) : '',
    days:Number(s.days)||0, earned:money_(s.earned), advances:money_(s.advances), paid:money_(s.amount), carried:money_(s.carried),
    wage:Number(w.wage)||0 };
}
// العامل ضغط "تم": تُعلَّم كل تصفياته غير المقروءة (داخل القفل عبر handle_)
function actionAckSettlement_(data){
  const w = requireWorkerSession_(data), id = String(w.id), now = Date.now();
  const rows = readAll_('Settlements').filter(s => String(s.workerId) === id && s.earned !== '' && !Number(s.ackAt));
  updateRows_('Settlements', rows.map(row => ({ row, patch:{ ackAt: now } })));
  return workerPayload_(w, approvedDeviceRow_(w.phone));
}
// صف الجهاز المعتمد حاليًا لهذا الرقم إن كان هو هذا الجهاز
function deviceRowFor_(phone, deviceId){
  const d = approvedDeviceRow_(phone);
  return d && deviceId !== '' && String(d.deviceId) === deviceId ? d : null;
}
// الجهاز المعتمد فقط (بدون قفل الهاتف): للإشعارات التي يجلبها الهاتف والتطبيق مغلق
function requireWorkerDevice_(data){
  const phone = String(data.phone||''), deviceId = String(data.deviceId||'');
  if(!validDeviceId_(deviceId)) throw new Error(ERR_SESSION); // طلب عشوائي: يُرفض قبل قراءة أي ورقة
  const w = liveWorker_(phone), dev = w && deviceRowFor_(phone, deviceId);
  if(!dev) throw new Error(ERR_SESSION);
  return { w, dev };
}
// بيانات العامل وعملياته: الجهاز المعتمد + (إن فُعّل قفل الهاتف) جلسة فُتحت ببصمة/رمز الهاتف
const LOCKED_MSG = 'التطبيق مقفل — افتحه بقفل الهاتف';
function requireWorkerSession_(data){
  const { w, dev } = requireWorkerDevice_(data);
  if(dev.pkKey && !isWorkerSession_(data.session, dev)) throw new Error(LOCKED_MSG);
  return w;
}
function lockedOut_(w){ // الجهاز معروف لكنه مقفل: الاسم فقط لشاشة القفل، بلا أي بيانات
  return { exists:true, deviceOk:true, locked:true, passkey:true, worker:{ id:String(w.id), name:w.name, profession:w.profession, status:w.status||'active' } };
}
// نقل جهاز إلى حساب آخر بموافقة الإدارة (اعتماد الجهاز، أو قبول حساب جديد سُجّل منه): يُلغى ربطه بأي حساب
// آخر كان معتمدًا عليه — جهاز واحد لعامل واحد. صاحبه السابق يستطيع طلب جهاز جديد لحسابه كالمعتاد
function releaseDeviceFromOthers_(dev, now){
  const others = readAll_('Devices').filter(d => d.status === 'approved' && String(d.deviceId) === String(dev.deviceId) && !samePhone_(d.phone, dev.phone));
  if(!others.length) return;
  const names = others.map(d => String(d.workerName || d.phone));
  updateRows_('Devices', others.map(row => ({ row, patch:{ status:'replaced', decidedAt:now } })));
  appendObj_('DeviceLogs', { id:newId_(), phone:dev.phone, workerName:dev.workerName, deviceId:dev.deviceId, userAgent:dev.userAgent,
    event:'نقلت الإدارة الجهاز من حساب «' + names.join('، ') + '» إلى هذا الحساب', timestamp:Date.now() });
  others.forEach(d => notifyWorker_(d, 'أُلغي ربط جهازك', 'وافقت الإدارة على نقل هذا الجهاز إلى حساب آخر. لاستخدام حسابك أرسل طلب جهاز من هاتفك', 'device'));
}
// العامل الحي المرتبط بهذا الجهاز (غير صاحب هذا الرقم) — كل جهاز لعامل واحد فقط
function deviceOwner_(deviceId, exceptPhone){
  if(!deviceId) return null;
  const devs = readAll_('Devices').filter(d => d.status === 'approved' && String(d.deviceId) === deviceId && !samePhone_(d.phone, exceptPhone));
  for(let i = 0; i < devs.length; i++){
    const w = liveWorker_(devs[i].phone);
    if(w && isDeviceApproved_(devs[i].phone, deviceId)) return w;
  }
  return null;
}

/* ---------------------------- تأمين التسجيل ---------------------------- */
const PROFESSIONS = ['مليس', 'دهان', 'عامل'];
function cleanName_(v){ return String(v||'').replace(/\s+/g, ' ').trim().slice(0, 60); }
// للمقارنة فقط: بلا تشكيل، والهمزات/التاء المربوطة/الألف المقصورة موحّدة — "أحمد" = "احمد"
function normName_(v){
  return cleanName_(v).replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').toLowerCase();
}
// اسم ثنائي على الأقل، حروف عربية أو لاتينية فقط
function validName_(name){
  return /^[ء-يٮ-ۓً-ٰٟa-zA-Z ]{5,60}$/.test(name)
    && name.split(' ').filter(p => p.length >= 2).length >= 2;
}

/* ---------------------------- الفتح بقفل الهاتف (Passkey / WebAuthn) ----------------------------
 * عند التفعيل ينشئ الهاتف مفتاحًا سريًا داخل شريحة الأمان، ولا يستخدمه إلا بعد بصمة الإصبع/الوجه أو رمز الهاتف.
 * الخادم يحفظ المفتاح العام فقط، ويتحقق رياضيًا من توقيع كل فتح (ES256 أو RS256) — لا يرى رمز الهاتف ولا البصمة.
 * بعد الفتح تُصدر جلسة (6 ساعات تتجدد مع الاستخدام) تُرسل مع كل طلب بيانات. */
/* جلسة العامل بعد الفتح بقفل الهاتف: رمز موقّع (HMAC) يحمل الجهاز ومفتاح القفل ومدة الصلاحية — لا يُخزَّن في
 * أي مكان. (كانت في الذاكرة المؤقتة لـ Google التي قد تمحوها في أي وقت، فيُقفل التطبيق فجأة «بلا سبب».)
 * يبقى في ذاكرة التطبيق فقط (إغلاقه = قفل). إعادة ضبط القفل أو تغيير الجهاز تُبطله (sessionKey_ مختلف). */
const WS_TTL = 21600, WS_DAYS = 7;
function sessionKey_(dev){ return phoneKey_(dev.phone) + '|' + dev.deviceId + '|' + dev.pkId; }
function wsSecret_(){
  let s = cfg_('WS_SECRET');
  if(!s){ s = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('WS_SECRET', s); cache_().put('cfg_WS_SECRET', s, CACHE_TTL); }
  return s;
}
const wsSign_ = body => b64url_(hmac_(utf8Bytes_(wsSecret_()), utf8Bytes_(body)));
const wsHash_ = dev => b64url_(sha256Text_(sessionKey_(dev))).slice(0, 22);
function issueWorkerSession_(dev){
  const body = b64url_(utf8Bytes_(JSON.stringify({ k: wsHash_(dev), e: Date.now() + WS_DAYS * 864e5 })));
  return body + '.' + wsSign_(body);
}
function isWorkerSession_(token, dev){
  token = String(token || '');
  if(!token) return false;
  const i = token.indexOf('.');
  if(i < 0){ // جلسة من الإصدار السابق (في الذاكرة المؤقتة) — تُقبل حتى تنتهي
    const c = cache_(), v = c.get('ws_' + token);
    return v === sessionKey_(dev);
  }
  const body = token.slice(0, i);
  if(!safeEq_(token.slice(i + 1), wsSign_(body))) return false;
  let p; try{ p = JSON.parse(bytesToText_(b64urlDecode_(body))); }catch(e){ return false; }
  return !!p && p.k === wsHash_(dev) && Number(p.e) > Date.now();
}
// تجديد صامت: جلسة صالحة تقترب من نهايتها (أقل من يومين) — أو من الإصدار السابق (الذاكرة المؤقتة) — تُستبدل
// بجديدة في الرد نفسه، فلا يُطلب من العامل فتح القفل من جديد ما دام التطبيق مفتوحًا
function renewedSession_(token, dev){
  token = String(token || '');
  if(!dev || !dev.pkKey || !token || !isWorkerSession_(token, dev)) return '';
  const i = token.indexOf('.');
  if(i < 0) return issueWorkerSession_(dev);
  let p = null; try{ p = JSON.parse(bytesToText_(b64urlDecode_(token.slice(0, i)))); }catch(e){}
  return p && Number(p.e) - Date.now() < 2 * 864e5 ? issueWorkerSession_(dev) : '';
}
const b64urlDecode_ = s => { s = String(s||'').replace(/=+$/, ''); return u8_(Utilities.base64DecodeWebSafe(s + '='.repeat((4 - s.length % 4) % 4))); };
const sha256Bytes_ = bytes => u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s8_(bytes)));
const sha256Text_ = t => u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, t, Utilities.Charset.UTF_8));
const bytesToText_ = bytes => decodeURIComponent(bytes.map(b => '%' + (b < 16 ? '0' : '') + b.toString(16)).join(''));
const hostOf_ = origin => String(origin).replace(/^https?:\/\//, '').replace(/[:/].*$/, '').toLowerCase();
// ALLOWED_ORIGINS (اختياري في Script Properties): مثل https://user.github.io — يحصر القفل في رابط التطبيق الرسمي
function allowedOrigin_(origin){
  const list = cfg_('ALLOWED_ORIGINS').split(/[\s,]+/).filter(Boolean);
  if(list.length) return list.indexOf(origin) >= 0;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
/* تحديات WebAuthn (مشتركة بين قفل العامل والإدارة): قائمة قصيرة في الذاكرة المؤقتة لكل «مالك»
 * (جهاز عامل أو الإدارة)، وكل تحدٍّ يُستخدم مرة واحدة فقط */
const WCH = { keep: 3, ttl: 600, expired: 'انتهت صلاحية طلب القفل، حاول مجددًا' };     // جهاز العامل
const ACH = { key: 'ach', keep: 20, ttl: 300, expired: 'انتهت صلاحية طلب الدخول، حاول مجددًا' }; // الإدارة
const workerChKey_ = dev => 'wch_' + phoneKey_(dev.phone) + '_' + dev.deviceId;
function challengeList_(c, key){ try{ return JSON.parse(c.get(key) || '[]'); }catch(e){ return []; } }
function newChallenge_(key, keep, ttl){
  const ch = b64url_(sha256Text_(Utilities.getUuid() + Utilities.getUuid() + Date.now())), c = cache_();
  c.put(key, JSON.stringify(challengeList_(c, key).concat([ch]).slice(-keep)), ttl);
  return ch;
}
function consumeChallenge_(key, ch, ttl){
  const c = cache_(), list = challengeList_(c, key), i = list.indexOf(ch);
  if(!ch || i < 0) return false;
  list.splice(i, 1); c.put(key, JSON.stringify(list), ttl);
  return true;
}
/* «التحدي التالي» للفتح السريع: مع كل فتح ناجح (أو تفعيل) يُصدر الخادم تحديًا واحدًا للفتح القادم، محفوظًا
 * في Script Properties (الذاكرة المؤقتة لا تتجاوز 6 ساعات) لمدة NEXT_CH_DAYS. الهاتف يحفظه، فتظهر نافذة البصمة
 * فور فتح التطبيق بلا انتظار طلب تحدٍّ من Google. يبقى لمرة واحدة، والتوقيع يتطلب بصمة/رمز الهاتف كالعادة. */
const NEXT_CH_DAYS = 14;
const nextChKey_ = owner => 'nch_' + b64url_(sha256Text_(owner)).slice(0, 24);
function issueNextChallenge_(owner){
  const c = b64url_(sha256Text_(Utilities.getUuid() + Utilities.getUuid() + Date.now()));
  props_().setProperty(nextChKey_(owner), JSON.stringify({ c, e: Date.now() + NEXT_CH_DAYS * 864e5 }));
  return c;
}
function consumeNextChallenge_(owner, ch){
  if(!owner || !ch) return false;
  const p = props_(), k = nextChKey_(owner);
  let v = null; try{ v = JSON.parse(p.getProperty(k) || 'null'); }catch(e){}
  if(!v || v.c !== ch || Number(v.e) < Date.now()) return false;
  p.deleteProperty(k);
  return true;
}
const dropNextChallenge_ = owner => { try{ props_().deleteProperty(nextChKey_(owner)); }catch(e){} };
// بيانات المتصفح (clientDataJSON): النوع، رابط التطبيق المسموح، والتحدي (يُستهلك مرة واحدة):
// من قائمة الذاكرة المؤقتة، أو «التحدي التالي» المحفوظ لهذا المالك (nextOwner)
function checkClientData_(data, type, key, conf, nextOwner){
  let cd; try{ cd = JSON.parse(bytesToText_(b64urlDecode_(data.clientDataJSON))); }catch(e){ throw new Error(ERR_CLIENT_DATA); }
  if(cd.type !== type) throw new Error(ERR_CLIENT_DATA);
  if(!allowedOrigin_(String(cd.origin || ''))) throw new Error('رابط التطبيق غير مسموح له');
  const ch = String(cd.challenge || '');
  if(!consumeChallenge_(key, ch, conf.ttl) && !consumeNextChallenge_(nextOwner, ch)) throw new Error(conf.expired);
  return cd;
}
// تسجيل مفتاح جديد (WebAuthn create): المفتاح العام بعد التحقق من صيغته → {credId, key, alg, rp, count}
function parseRegistration_(data, cd){
  if(!data.authenticatorData || !data.publicKey) throw new Error('بيانات بصمة الجهاز ناقصة — حدّث المتصفح (Chrome أو Safari) ثم حاول');
  const rp = hostOf_(cd.origin);
  let auth, alg, spki;
  try{
    auth = parseAuthData_(b64urlDecode_(data.authenticatorData), rp);
    alg = Number(data.alg); spki = b64urlDecode_(data.publicKey);
    parsePublicKey_(spki, alg);
  }catch(e){ throw e instanceof TypeError ? new Error('تعذر قراءة بيانات بصمة الجهاز (' + e.message + ')') : e; }
  const credId = String(data.credId || '');
  if(!/^[A-Za-z0-9_-]{16,1400}$/.test(credId)) throw new Error(ERR_KEY);
  return { credId, key: b64url_(spki), alg, rp, count: auth.count };
}
// توقيع فتح (WebAuthn get) بمفتاح محفوظ {key, alg, rp, count}: الرابط، التحقق الفعلي بقفل الهاتف (UV)،
// التوقيع، وعداد الاستخدام (رقم لا يزيد = نسخة مستنسخة من المفتاح). msgs: {sig, clone}
function verifyAssertion_(k, data, cd, msgs){
  if(hostOf_(cd.origin) !== String(k.rp)) throw new Error(ERR_KEY_ORIGIN);
  const authBytes = b64urlDecode_(data.authenticatorData), auth = parseAuthData_(authBytes, String(k.rp));
  if(!verifySignature_(b64urlDecode_(k.key), Number(k.alg), authBytes.concat(sha256Bytes_(b64urlDecode_(data.clientDataJSON))), b64urlDecode_(data.signature)))
    throw new Error(msgs.sig);
  const stored = Number(k.count) || 0;
  if(auth.count && stored && auth.count <= stored) throw new Error(msgs.clone);
  return auth;
}
function parseAuthData_(bytes, rpId){
  if(bytes.length < 37) throw new Error(ERR_CLIENT_DATA);
  const h = sha256Text_(rpId);
  for(let i = 0; i < 32; i++) if(bytes[i] !== h[i]) throw new Error(ERR_KEY_ORIGIN);
  // UP (المستخدم حاضر) + UV (تحقق فعلًا ببصمة أو رمز الهاتف)
  if(!(bytes[32] & 1) || !(bytes[32] & 4)) throw new Error('يلزم التحقق ببصمة الهاتف أو رمزه');
  return { count: bytes[33] * 16777216 + bytes[34] * 65536 + bytes[35] * 256 + bytes[36] };
}
// قارئ DER بسيط: {tag, start, end} للعنصر عند pos
function der_(b, pos){
  let len = b[pos + 1], p = pos + 2;
  if(len & 0x80){ const n = len & 0x7f; len = 0; for(let i = 0; i < n; i++) len = len * 256 + b[p++]; }
  if(p + len > b.length) throw new Error(ERR_KEY);
  return { tag: b[pos], start: p, end: p + len };
}
// SubjectPublicKeyInfo → مفتاح P-256 (x,y) أو RSA (n,e)
function parsePublicKey_(spki, alg){
  const seq = der_(spki, 0), algo = der_(spki, seq.start), bits = der_(spki, algo.end);
  if(seq.tag !== 0x30 || bits.tag !== 0x03) throw new Error(ERR_KEY);
  const key = spki.slice(bits.start + 1, bits.end);
  if(alg === -7){
    if(key.length !== 65 || key[0] !== 4) throw new Error(ERR_KEY);
    const x = bytesToBig_(key.slice(1, 33)), y = bytesToBig_(key.slice(33));
    if(!P256.onCurve(x, y)) throw new Error(ERR_KEY);
    return { x, y };
  }
  if(alg === -257){
    const rsa = der_(key, 0), nI = der_(key, rsa.start), eI = der_(key, nI.end);
    const n = bytesToBig_(key.slice(nI.start, nI.end)), e = bytesToBig_(key.slice(eI.start, eI.end));
    const bytes = Math.ceil(n.toString(16).length / 2);
    if(bytes < 256) throw new Error('مفتاح RSA ضعيف');
    return { n, e, bytes };
  }
  throw new Error('نوع مفتاح غير مدعوم');
}
function verifySignature_(spki, alg, message, sig){
  const k = parsePublicKey_(spki, alg), h = sha256Bytes_(message);
  if(alg === -7){
    const s0 = der_(sig, 0), rI = der_(sig, s0.start), sI = der_(sig, rI.end), n = P256.n;
    const r = bytesToBig_(sig.slice(rI.start, rI.end)), s = bytesToBig_(sig.slice(sI.start, sI.end));
    if(r <= N0 || r >= n || s <= N0 || s >= n) return false;
    const w = P256.inv(s, n), X = P256.mulAdd(bytesToBig_(h) % n * w % n, r * w % n, k.x, k.y);
    return X !== null && X % n === r;
  }
  // RS256 (PKCS#1 v1.5 + SHA-256)
  const em = bigToBytes_(P256.pow(bytesToBig_(sig), k.e, k.n), k.bytes);
  const info = [0x30,0x31,0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00,0x04,0x20];
  const want = [0, 1].concat(new Array(k.bytes - 3 - info.length - 32).fill(255), [0], info, h);
  return em.length === want.length && em.every((b, i) => b === want[i]);
}

// تحدٍّ عشوائي للتفعيل أو الفتح (صالح 10 دقائق، لمرة واحدة)
function actionPasskeyOptions_(data){
  const { w, dev } = requireWorkerDevice_(data);
  rateLimit_('pko_' + phoneKey_(dev.phone), 40, 600, 'محاولات كثيرة، انتظر دقائق ثم حاول');
  const out = { challenge: newChallenge_(workerChKey_(dev), WCH.keep, WCH.ttl), hasPasskey: !!dev.pkKey };
  if(dev.pkKey) out.credId = String(dev.pkId);
  else Object.assign(out, { userId: b64url_(sha256Text_('uniguard:' + w.id).slice(0, 16)), userName: String(w.phone), displayName: String(w.name) });
  return out;
}
// تفعيل القفل على الجهاز المعتمد (داخل القفل عبر handle_)
function actionPasskeyRegister_(data){
  const { w, dev } = requireWorkerDevice_(data);
  // استبدال قفل قائم يتطلب فتح التطبيق به أولًا (وإلا تُطلب إعادة الضبط من الإدارة)
  if(dev.pkKey && !isWorkerSession_(data.session, dev)) throw new Error(LOCKED_MSG);
  const k = parseRegistration_(data, checkClientData_(data, 'webauthn.create', workerChKey_(dev), WCH));
  ensureHeader_('Devices');
  const patch = { pkId:k.credId, pkKey:k.key, pkAlg:k.alg, pkRp:k.rp, pkCount:k.count };
  updateRows_('Devices', [{ row:dev, patch }]);
  appendObj_('DeviceLogs', { id:newId_(), phone:dev.phone, workerName:w.name, deviceId:dev.deviceId, userAgent:dev.userAgent, event:'فعّل العامل فتح التطبيق بقفل الهاتف', timestamp:Date.now() });
  const d2 = Object.assign({}, dev, patch);
  return Object.assign({ session: issueWorkerSession_(d2), next: issueNextChallenge_(workerNextOwner_(d2)), credId: k.credId }, workerPayload_(w, d2));
}
// مالك «التحدي التالي» للعامل: الجهاز + مفتاح القفل الحالي (إعادة ضبط القفل أو مفتاح جديد تُبطله تلقائيًا)
const workerNextOwner_ = dev => workerChKey_(dev) + '|' + dev.pkId;
// فتح التطبيق: توقيع من مفتاح الهاتف بعد البصمة/الرمز
function actionPasskeyUnlock_(data){
  const { w, dev } = requireWorkerDevice_(data);
  if(!dev.pkKey) return Object.assign({ exists:true, deviceOk:true, session:'' }, workerPayload_(w, dev)); // أُعيد ضبط القفل
  if(String(data.credId||'') !== String(dev.pkId)) throw new Error('مفتاح القفل لا يخص هذا الحساب — اطلب من الإدارة إعادة ضبط القفل');
  const cd = checkClientData_(data, 'webauthn.get', workerChKey_(dev), WCH, workerNextOwner_(dev));
  const auth = verifyAssertion_({ key: dev.pkKey, alg: dev.pkAlg, rp: dev.pkRp, count: dev.pkCount }, data, cd,
    { sig: 'فشل التحقق من قفل الهاتف', clone: 'تعذر التحقق من مفتاح القفل — اطلب من الإدارة إعادة ضبط القفل' });
  if(auth.count > (Number(dev.pkCount) || 0)) withLock_(() => {
    const d = deviceRowFor_(dev.phone, String(dev.deviceId));
    if(d && String(d.pkId) === String(dev.pkId)) updateRows_('Devices', [{ row:d, patch:{ pkCount:auth.count } }]);
  });
  return Object.assign({ exists:true, deviceOk:true, session: issueWorkerSession_(dev), next: issueNextChallenge_(workerNextOwner_(dev)) }, workerPayload_(w, dev));
}
// الإدارة: عامل غيّر قفل هاتفه أو حُذف المفتاح — يُمسح القفل فيفعّله من جديد عند الفتح التالي
function actionResetDeviceLock_(data){
  const w = workerById_(data.workerId);
  if(!w) throw new Error(ERR_WORKER);
  const dev = approvedDeviceRow_(w.phone);
  if(!dev || !dev.pkKey) return {};
  dropNextChallenge_(workerNextOwner_(dev));
  updateRows_('Devices', [{ row:dev, patch:{ pkId:'', pkKey:'', pkAlg:'', pkRp:'', pkCount:'' } }]);
  appendObj_('DeviceLogs', { id:newId_(), phone:w.phone, workerName:w.name, deviceId:dev.deviceId, userAgent:dev.userAgent, event:'أعادت الإدارة ضبط قفل التطبيق', timestamp:Date.now() });
  notifyWorker_(w, 'أُعيد ضبط قفل التطبيق', 'افتح التطبيق وفعّل الفتح بقفل الهاتف من جديد', 'device');
  return {};
}

/* ---------------------------- الجلسات (Admin token) ---------------------------- */
// الجلسة لا تنتهي إلا بزر "تسجيل الخروج" أو بعد 30 يومًا بلا أي استخدام (تتجدد تلقائيًا مع الاستخدام).
// تُحفظ في Script Properties (دائمة) مع الجهاز الذي فُتحت منه، وCacheService (6 ساعات) مجرد نسخة سريعة.
// جلسات النسخ القديمة (قبل حساب الإدارة وبصمة الجهاز) قيمتها رقم فقط، فلا تُقبل: يلزم دخول جديد آمن.
const ADMIN_SESSION_MS = 30 * 864e5, ADMIN_CACHE_ON = '2';
function adminSession_(token){
  if(!token) return null;
  try{ const s = JSON.parse(props_().getProperty('adm_' + token) || 'null'); return s && typeof s === 'object' ? s : null; }
  catch(e){ return null; }
}
function issueAdminToken_(keyId, ua){
  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = props_(), now = Date.now();
  if(!cache_().get('adm_gc')) try{ // تنظيف الجلسات المنتهية وجلسات النسخ القديمة (مرة في اليوم تكفي: يسرّع الدخول)
    const all = props.getProperties();
    Object.keys(all).forEach(k => {
      if(k.indexOf('adm_') !== 0) return;
      let s = null; try{ s = JSON.parse(all[k]); }catch(e){}
      if(!s || typeof s !== 'object' || Number(s.e) < now) props.deleteProperty(k);
    });
    cache_().put('adm_gc', '1', CACHE_TTL);
  }catch(e){}
  props.setProperty('adm_' + token, JSON.stringify({ e: now + ADMIN_SESSION_MS, k: String(keyId || ''), u: String(ua || '').slice(0, 120), a: now }));
  cache_().put('admin_' + token, ADMIN_CACHE_ON, CACHE_TTL);
  return token;
}
function isAdminToken_(token){
  if(!token) return false;
  const cache = cache_();
  if(cache.get('admin_' + token) === ADMIN_CACHE_ON) return true;
  const s = adminSession_(token), now = Date.now();
  if(!s || Number(s.e) < now) return false;
  if(Number(s.e) - now < ADMIN_SESSION_MS - 864e5){ s.e = now + ADMIN_SESSION_MS; props_().setProperty('adm_' + token, JSON.stringify(s)); } // تجديد يومي
  cache.put('admin_' + token, ADMIN_CACHE_ON, CACHE_TTL);
  return true;
}
// إنهاء جلسات (كلها، أو جلسات جهاز معيّن) مع حذف نسختها السريعة فورًا
function revokeAdminSessions_(filter){
  const props = props_(), all = props.getProperties(), cacheKeys = [];
  Object.keys(all).forEach(k => {
    if(k.indexOf('adm_') !== 0) return;
    let s = null; try{ s = JSON.parse(all[k]); }catch(e){}
    if(filter && !filter(k.slice(4), s || {})) return;
    props.deleteProperty(k); cacheKeys.push('admin_' + k.slice(4));
  });
  if(cacheKeys.length) cache_().removeAll(cacheKeys);
  return cacheKeys.length;
}
function actionAdminLogout_(data){
  const token = String(data.token||'');
  if(token){ props_().deleteProperty('adm_'+token); cache_().remove('admin_'+token); }
  return {};
}
function requireAdmin_(token){ if(!isAdminToken_(token)) throw new Error('غير مصرح — يلزم تسجيل دخول الإدارة'); }

/* ---------------------------- حساب الإدارة الأساسي + الفتح بقفل الهاتف ----------------------------
 * حساب أساسي دائم واحد: اسم مستخدم + كلمة مرور مشفّرة (HMAC متكرر بملح عشوائي).
 * الدخول: اسم المستخدم وكلمة المرور (5 محاولات خاطئة لكل جهاز و30 إجمالًا كل 15 دقيقة).
 * الفتح بقفل الهاتف اختياري: يفعّله المدير من داخل اللوحة فيُحفظ المفتاح العام لبصمة جهازه (Passkey)،
 * ثم يُفتح التطبيق على ذلك الجهاز ببصمته وحدها (توقيع يتحقق منه الخادم).
 * أول مرة: كلمة المرور القديمة ADMIN_PASSWORD تُنشئ الحساب الأساسي ثم تُحذف. نسيان كلمة المرور: resetAdminAccess.
 * كل ذلك في Script Properties — لا يراه من يفتح الشيت. */
const ADMIN_ACCOUNT_KEY = 'ADMIN_ACCOUNT', ADMIN_KEYS_KEY = 'ADMIN_KEYS', PW_ITER = 300, MAX_ADMIN_KEYS = 10;
const PW_RULE = 'كلمة المرور الجديدة: 10 أحرف على الأقل وفيها حروف وأرقام';
const BAD_LOGIN = 'اسم المستخدم أو كلمة المرور غير صحيحة';
function adminAccount_(){ try{ return JSON.parse(props_().getProperty(ADMIN_ACCOUNT_KEY) || 'null'); }catch(e){ return null; } }
function saveAdminAccount_(a){ props_().setProperty(ADMIN_ACCOUNT_KEY, JSON.stringify(a)); }
function adminKeys_(){ try{ return JSON.parse(props_().getProperty(ADMIN_KEYS_KEY) || '[]'); }catch(e){ return []; } }
function saveAdminKeys_(k){ props_().setProperty(ADMIN_KEYS_KEY, JSON.stringify(k)); }
const toHex_ = bytes => bytes.map(b => ((b & 255) < 16 ? '0' : '') + (b & 255).toString(16)).join('');
function hashPassword_(pw, salt, iter){
  const key = utf8Bytes_(salt);
  let h = hmac_(key, utf8Bytes_(pw));
  for(let i = 1; i < iter; i++) h = hmac_(key, h);
  return toHex_(h);
}
function safeEq_(a, b){ a = String(a); b = String(b); let d = a.length ^ b.length; for(let i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function passwordRecord_(pw){ const salt = Utilities.getUuid() + Utilities.getUuid(); return { salt, iter: PW_ITER, hash: hashPassword_(pw, salt, PW_ITER) }; }
function adminCredsOk_(acc, user, pw){
  if(!acc) return false;
  const passOk = safeEq_(hashPassword_(String(pw || ''), acc.salt, acc.iter || PW_ITER), acc.hash); // يُحسب دائمًا (زمن ثابت)
  return passOk && String(user || '').trim().toLowerCase() === String(acc.user).toLowerCase();
}
const validAdminUser_ = u => /^[A-Za-z0-9_.ء-ي]{3,30}$/.test(u);
const strongPassword_ = pw => pw.length >= 10 && pw.length <= 128 && /[A-Za-zء-ي]/.test(pw) && /\d/.test(pw);

/* تعيين حساب الإدارة من Script Properties: أضف ADMIN_USER و ADMIN_PASSWORD معًا فيصبحان اسم المستخدم وكلمة المرور،
 * وتُحذف أجهزة الفتح بقفل الهاتف السابقة وتُنهى كل الجلسات. تُحذف ADMIN_PASSWORD فورًا
 * بعد تشفيرها، ويبقى ADMIN_USER ظاهرًا للتذكير. (ADMIN_PASSWORD وحدها بلا ADMIN_USER = الإعداد الأول من صفحة الإدارة.) */
function bootstrapAdminFromProps_(){
  const props = props_();
  const user = String(props.getProperty('ADMIN_USER') || '').trim(), pw = props.getProperty('ADMIN_PASSWORD');
  if(!user || !pw) return;
  if(!validAdminUser_(user)) throw new Error('ADMIN_USER في إعدادات السكربت غير صالح: 3-30 حرفًا أو رقمًا بلا مسافات');
  const prev = adminAccount_();
  saveAdminAccount_(Object.assign({ user, primary: true, createdAt: prev && prev.createdAt || Date.now(), passChangedAt: Date.now(), mustChange: false }, passwordRecord_(pw)));
  props.deleteProperty('ADMIN_PASSWORD');
  saveAdminKeys_([]);
  revokeAdminSessions_();
}
// حالة الدخول + تحدٍّ جديد لبصمة الجهاز (للفتح بقفل الهاتف) — لا يكشف أي معلومة عن الحساب
function actionAdminOptions_(data){
  rateLimit_('ao_' + String(data.deviceId || '').slice(0, 80), 60, 600, 'محاولات كثيرة، انتظر دقائق ثم حاول');
  bootstrapAdminFromProps_();
  const acc = adminAccount_(), keys = adminKeys_();
  const out = { mode: acc ? 'login' : 'create', challenge: newChallenge_(ACH.key, ACH.keep, ACH.ttl), allow: keys.map(k => k.id) };
  if(acc && acc.mustChange) out.mustChange = true;
  return out;
}
// محاولات كلمة المرور الخاطئة: حد لكل جهاز (5) وحد عام (30) خلال 15 دقيقة
function pwGuard_(deviceId){
  const c = cache_(), dk = 'adm_pw_d_' + String(deviceId || '-').slice(0, 80);
  const nd = Number(c.get(dk) || 0), ng = Number(c.get('adm_pw_fails') || 0);
  if(nd >= 5 || ng >= 30) throw new Error('محاولات كثيرة خاطئة، حاول بعد 15 دقيقة');
  return { fail: () => { c.put(dk, String(nd + 1), 900); c.put('adm_pw_fails', String(ng + 1), 900); }, ok: () => c.remove(dk) };
}
// توقيع بصمة جهاز إدارة مسجّل (WebAuthn): التحدي، الرابط، التحقق الفعلي بقفل الهاتف (UV)، التوقيع، وعداد النسخ
function verifyAdminAssertion_(a, keys){
  const key = keys.find(k => k.id === String(a.credId || ''));
  if(!key) throw new Error('هذا الجهاز غير مسجّل للإدارة — ادخل باسم المستخدم وكلمة المرور');
  const auth = verifyAssertion_(key, a, checkClientData_(a, 'webauthn.get', ACH.key, ACH, adminNextOwner_(key.id)),
    { sig: 'فشل التحقق من بصمة الجهاز', clone: 'تعذر التحقق من مفتاح الجهاز — احذفه من الأجهزة وأضفه من جديد' });
  return { key, auth };
}
const adminNextOwner_ = keyId => 'adm|' + keyId; // مالك «التحدي التالي» لجهاز إدارة
/* الدخول: اسم المستخدم + كلمة المرور → جلسة. بصمة الجهاز ليست شرطًا للدخول؛ هي «الفتح بقفل الهاتف»
 * الاختياري الذي يفعّله المدير من داخل اللوحة (adminAddKey)، ثم يفتح به بلا كلمة مرور (adminUnlock). */
function actionAdminLogin_(data){
  bootstrapAdminFromProps_();
  const acc = adminAccount_(), props = props_();
  const guard = pwGuard_(data.deviceId);
  let account = acc;
  if(!acc){ // أول مرة: إنشاء الحساب الأساسي الدائم بكلمة المرور الحالية (ADMIN_PASSWORD)
    const legacy = props.getProperty('ADMIN_PASSWORD');
    if(!legacy || !safeEq_(String(data.password || ''), legacy)){ guard.fail(); throw new Error('كلمة مرور الإدارة الحالية غير صحيحة'); }
    const user = String(data.newUser || '').trim(), pw = String(data.newPassword || '');
    if(!validAdminUser_(user)) throw new Error('اسم المستخدم: 3-30 حرفًا أو رقمًا، بلا مسافات');
    if(!strongPassword_(pw) || pw === legacy) throw new Error(PW_RULE + '، ومختلفة عن القديمة');
    account = Object.assign({ user, createdAt: Date.now(), primary: true }, passwordRecord_(pw));
    saveAdminAccount_(account);
    props.deleteProperty('ADMIN_PASSWORD'); // لا تبقى كلمة مرور مكشوفة في الإعدادات
  }else{
    if(!adminCredsOk_(acc, data.user, data.password)){ guard.fail(); throw new Error(BAD_LOGIN); }
    if(acc.mustChange){ // بعد resetAdminAccess: كلمة المرور المؤقتة تُستبدل فورًا
      const pw = String(data.newPassword || '');
      if(!strongPassword_(pw) || safeEq_(pw, data.password)) throw new Error(PW_RULE + '، ومختلفة عن المؤقتة');
      account = Object.assign({}, acc, passwordRecord_(pw), { mustChange: false, passChangedAt: Date.now() });
      saveAdminAccount_(account);
    }
  }
  guard.ok();
  const ua = safeText_(data.ua, 60);
  notifyAdmin_('دخول جديد للإدارة', (ua ? 'من «' + ua + '» — ' : '') + 'إن لم تكن أنت: أنهِ كل الجلسات وغيّر كلمة المرور', 'adm-security');
  return { token: issueAdminToken_('', data.ua), user: account.user }; // بيانات اللوحة تُرفق في handle_ خارج القفل
}
// تفعيل «الفتح بقفل الهاتف» على هذا الجهاز (من داخل اللوحة، بجلسة إدارة): حفظ المفتاح العام لبصمته
function actionAdminAddKey_(data){
  const r = parseRegistration_(data, checkClientData_(data, 'webauthn.create', ACH.key, ACH));
  const keys = adminKeys_().filter(k => k.id !== r.credId);
  if(keys.length >= MAX_ADMIN_KEYS) throw new Error('وصلت للحد الأقصى (' + MAX_ADMIN_KEYS + ' أجهزة) — احذف جهازًا قديمًا أولًا');
  const name = safeText_(String(data.name || '').replace(/\s+/g, ' '), 40) || 'جهاز';
  keys.push({ id: r.credId, key: r.key, alg: r.alg, rp: r.rp, count: r.count, name, at: Date.now(), used: Date.now() });
  saveAdminKeys_(keys);
  // الجلسة الحالية تُنسب لهذا الجهاز (فحذفه لاحقًا من «الأمان» يُنهيها)
  const s = adminSession_(data.token);
  if(s){ s.k = r.credId; props_().setProperty('adm_' + data.token, JSON.stringify(s)); }
  const acc = adminAccount_();
  notifyAdmin_('فُعّل الفتح بقفل الهاتف', 'على «' + name + '» — إن لم تكن أنت: احذفه من «أمان الحساب» فورًا', 'adm-security');
  return { keyId: r.credId, user: acc && acc.user, next: issueNextChallenge_(adminNextOwner_(r.credId)) };
}
/* فتح تطبيق الإدارة بقفل الهاتف (مثل تطبيق العمال): جهاز فُعّل عليه الفتح بقفل الهاتف.
 * مفتاح الجهاز لا يعمل إلا بعد بصمة الإصبع/الوجه أو رمز الهاتف (UV)، والخادم يتحقق من توقيعه.
 * الجلسة في ذاكرة التطبيق فقط (إغلاقه = قفل)، وتُنهى جلسات نفس الجهاز السابقة فلا تتراكم. */
function actionAdminUnlock_(data){
  bootstrapAdminFromProps_();
  const acc = adminAccount_(), keys = adminKeys_(), a = data.assertion || {};
  if(!acc) throw new Error('حساب الإدارة غير موجود — ادخل باسم المستخدم وكلمة المرور');
  rateLimit_('au_' + String(a.credId || '').slice(0, 60), 30, 900, 'محاولات كثيرة، انتظر دقائق ثم حاول');
  const { key, auth } = verifyAdminAssertion_(a, keys);
  key.count = auth.count || key.count || 0; key.used = Date.now();
  saveAdminKeys_(keys);
  revokeAdminSessions_((t, s) => s.k === key.id);
  return { token: issueAdminToken_(key.id, data.ua), user: acc.user, keyId: key.id, // بيانات اللوحة تُرفق في handle_
    next: issueNextChallenge_(adminNextOwner_(key.id)) };
}
function actionAdminSecurity_(data){
  const acc = adminAccount_() || {}, cur = (adminSession_(data.token) || {}).k, now = Date.now();
  const all = props_().getProperties();
  const sessions = Object.keys(all).filter(k => { if(k.indexOf('adm_') !== 0) return false; try{ const s = JSON.parse(all[k]); return s && Number(s.e) > now; }catch(e){ return false; } }).length;
  return { user: acc.user || '', createdAt: acc.createdAt || 0, sessions,
    keys: adminKeys_().map(k => ({ id: k.id, name: k.name, at: k.at, used: k.used, current: k.id === cur })) };
}
function actionAdminRemoveKey_(data){
  const keys = adminKeys_(), id = String(data.keyId || '');
  if(!keys.some(k => k.id === id)) throw new Error('الجهاز غير موجود');
  saveAdminKeys_(keys.filter(k => k.id !== id));
  dropNextChallenge_(adminNextOwner_(id));
  revokeAdminSessions_((t, s) => s.k === id); // جلسات ذلك الجهاز تنتهي فورًا (مثلًا هاتف مفقود)
  return actionAdminSecurity_(data);
}
function actionAdminLogoutOthers_(data){
  const n = revokeAdminSessions_(t => t !== String(data.token || ''));
  return { ended: n };
}
function actionAdminChangePassword_(data){
  const acc = adminAccount_();
  if(!acc) throw new Error('الحساب غير موجود');
  const c = cache_(), n = Number(c.get('adm_cp_fails') || 0);
  if(n >= 5) throw new Error('محاولات كثيرة خاطئة، حاول بعد 15 دقيقة');
  if(!adminCredsOk_(acc, acc.user, data.oldPassword)){ c.put('adm_cp_fails', String(n + 1), 900); throw new Error('كلمة المرور الحالية غير صحيحة'); }
  const pw = String(data.newPassword || '');
  if(!strongPassword_(pw) || safeEq_(pw, data.oldPassword)) throw new Error(PW_RULE + '، ومختلفة عن الحالية');
  saveAdminAccount_(Object.assign({}, acc, passwordRecord_(pw), { mustChange: false, passChangedAt: Date.now() }));
  c.remove('adm_cp_fails');
  const ended = revokeAdminSessions_(t => t !== String(data.token || '')); // تغيير كلمة المرور يُنهي الجلسات الأخرى
  notifyAdmin_('تم تغيير كلمة مرور الإدارة', 'وأُنهيت الجلسات الأخرى', 'adm-security');
  return { ended };
}
// للطوارئ فقط — شغّلها من محرر Apps Script إذا نسيت كلمة المرور:
// تحذف أجهزة الإدارة وتُنهي كل الجلسات، وتضع كلمة مرور مؤقتة تظهر في السجل (Execution log)، واسم المستخدم يبقى كما هو.
function resetAdminAccess(){
  const acc = adminAccount_(), temp = 'Tmp' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  if(acc) saveAdminAccount_(Object.assign({}, acc, passwordRecord_(temp), { mustChange: true }));
  else props_().setProperty('ADMIN_PASSWORD', temp);
  adminKeys_().forEach(k => dropNextChallenge_(adminNextOwner_(k.id)));
  saveAdminKeys_([]);
  revokeAdminSessions_();
  Logger.log('تمت إعادة ضبط دخول الإدارة.\nاسم المستخدم: ' + (acc ? acc.user : '(يُنشأ عند أول دخول)') +
    '\nكلمة المرور المؤقتة: ' + temp + '\nافتح صفحة الإدارة، ادخل بها، ثم اختر كلمة مرور جديدة.');
  return temp;
}

/* ---------------------------- نقطة الدخول ---------------------------- */
// عمليات تكتب في الشيت: تُنفّذ داخل القفل مع منع التكرار عبر requestId.
// القيمة = من يستدعيها: w العامل (أو عامة)، a جلسة إدارة، l دخول الإدارة
const WRITE_ACTIONS = {
  register:'w', checkin:'w', workerDeleteOwnAccount:'w', savePush:'w', removePush:'w', passkeyRegister:'w', ackSettlement:'w',
  approveWorker:'a', rejectWorker:'a', adminDeleteWorker:'a', decideAttendance:'a', approveAllPending:'a',
  addAdvance:'a', settleWorkerAccount:'a', closeMonthForAll:'a', approveDevice:'a', rejectDevice:'a', resetDeviceLock:'a',
  adminAddKey:'a', adminRemoveKey:'a', adminLogoutOthers:'a', adminChangePassword:'a',
  adminLogin:'l', adminUnlock:'l'
};
// عمليات إدارية يُرفق معها ردّ getAdminData المحدّث (يوفر رحلة شبكة كاملة للواجهة).
// الدخول والفتح بقفل الهاتف: since = إصدار النسخة المحفوظة على جهاز المدير (إن لم يتغير شيء يُرد «لم يتغير»)
const ATTACH_ADMIN = {
  approveWorker:1, rejectWorker:1, adminDeleteWorker:1, decideAttendance:1, approveAllPending:1,
  addAdvance:1, settleWorkerAccount:1, closeMonthForAll:1, approveDevice:1, rejectDevice:1, resetDeviceLock:1,
  adminLogin:1, adminUnlock:1
};

// الرد دائمًا JSON — حتى عند خطأ غير متوقع من خدمات Google (حصة، ضغط لحظي): busy = عابر، يعيد التطبيق
// المحاولة تلقائيًا بصمت بدل صفحة خطأ HTML كانت تظهر للمستخدم «رد غير صالح من الخادم»
/* سجل المطوّر: الأخطاء غير المتوقعة والعابرة والطلبات البطيئة تُكتب في سجل Apps Script
 * (المحرر ← Executions ← أي تنفيذ ← السجل) مع اسم العملية والمدة — لا تُكتب أي بيانات شخصية */
const SLOW_MS = 8000;
function doPost(e){
  const t0 = Date.now(), ctx = { action: '' };
  let out;
  try{ out = doPost_(e, ctx); }
  catch(err){
    console.error('UniGuard doPost: خطأ غير متوقع', ctx.action, err && err.stack || err);
    out = jsonOut_({ ok:false, busy:true, error:'الخادم مشغول لحظيًا، حاول بعد ثوانٍ', detail:String(err && err.message || err).slice(0, 200) });
  }
  try{ sendPendingPushes_(); }catch(e2){ console.warn('UniGuard: تعذر إرسال الإشعارات', e2 && e2.message); } // بعد تحرير القفل
  const ms = Date.now() - t0;
  if(ms > SLOW_MS) console.warn('UniGuard: طلب بطيء', ctx.action, ms + 'ms');
  return out;
}
function doPost_(e, ctx){
  let body;
  try{ body = JSON.parse(e.postData.contents); }catch(err){ return jsonOut_({ ok:false, error:'طلب غير صالح' }); }
  ctx.action = String(body.action || '');
  const API_KEY = cfg_('API_KEY');
  if(API_KEY && body.apiKey !== API_KEY){ console.warn('UniGuard: مفتاح API خاطئ', ctx.action); return jsonOut_({ ok:false, error:'غير مصرح' }); }
  try{
    return jsonOut_(Object.assign({ ok:true }, handle_(ctx.action, body.data || {}, props_(), String(body.requestId||''))));
  }catch(err){
    const msg = String(err.message||err);
    // أخطاء خدمات Google العابرة (رسائلها إنجليزية) وازدحام القفل: busy — لا تُعرض للمستخدم كرفض
    if(TRANSIENT_RE.test(msg)){
      console.warn('UniGuard: عطل عابر', ctx.action, msg);
      return jsonOut_({ ok:false, busy:true, error:'الخادم مشغول لحظيًا، حاول بعد ثوانٍ', detail:msg.slice(0, 200) });
    }
    if(!/[؀-ۿ]/.test(msg)){ // رسائلنا عربية؛ غيرها = خلل برمجي: للمطوّر في السجل، وللمستخدم رسالة مفهومة
      console.error('UniGuard: خطأ برمجي', ctx.action, err && err.stack || msg);
      return jsonOut_({ ok:false, error:'حدث خطأ غير متوقع في الخادم — حاول مجددًا', detail:msg.slice(0, 200) });
    }
    return jsonOut_({ ok:false, error:msg });
  }
}
const TRANSIENT_RE = /Service|timed? ?out|temporar|too many|Exceeded|Internal error|unavailable|try again|Rate ?Limit|مشغول/i;
// نبض الخادم (تدفئة من الواجهة، و«حول التطبيق» في لوحة الإدارة): الإصدار وتاريخه
function doGet(){ return jsonOut_({ ok:true, ping:Date.now(), version:SERVER_VERSION, build:SERVER_BUILD }); }
// كل رد يحمل إصدار الخادم (v): الواجهة تكتشف فورًا إن لم يُنشر Code.gs الجديد (New version) فتنبّه الإدارة بوضوح
function jsonOut_(obj){
  obj.v = SERVER_VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(action, data, props, requestId){
  const kind = WRITE_ACTIONS[action];
  const cache = cache_();
  // الفتح بقفل الهاتف (بلا قفل الخادم): رد ضاع في الشبكة ثم أُعيد نفس الطلب = نفس الجلسة
  // (التحدي استُهلك في المحاولة الأولى، فإعادة التنفيذ كانت تفشل وتطلب البصمة من جديد)
  if(action === 'passkeyUnlock' && requestId){
    const k = 'req_' + requestId, prev = cache.get(k);
    if(prev){ try{ return JSON.parse(prev); }catch(e){} }
    const r = dispatch_(action, data, props) || {};
    try{ cache.put(k, JSON.stringify(r), 600); }catch(e){}
    return r;
  }
  if(!kind) return dispatch_(action, data, props);
  // يشمل الدخول: رد ضاع في الشبكة ثم أُعيد الطلب = نفس الجلسة (تحدي بصمة الجهاز استُهلك في المحاولة الأولى)
  const reqKey = requestId ? 'req_'+requestId : '';
  let version = '';
  const result = withLock_(()=>{
    // إن أُعيد إرسال نفس الطلب (إعادة محاولة بعد انقطاع/نقرة مزدوجة) نعيد نتيجته السابقة بدل تنفيذه مرتين
    // النتيجة الكاملة تُحفظ 10 دقائق (إعادة محاولة سريعة)، وعلامة «نُفِّذ» صغيرة 6 ساعات: عملية أُعيد إرسالها من
    // صندوق الإرسال بعد انقطاع طويل لا تُنفَّذ مرتين (سلفة مكررة مثلًا) — يُعاد {} وتُرفق البيانات الحالية
    const doneKey = requestId && kind !== 'l' ? 'reqd_' + requestId : '';
    let result = null;
    if(reqKey){
      const prev = cache.get(reqKey) || (doneKey && cache.get(doneKey) ? '{}' : null);
      if(prev){ try{ result = JSON.parse(prev); }catch(e){} }
      if(result && kind === 'a') requireAdmin_(data.token); // إعادة طلب إداري تتطلب جلسة صالحة أيضًا
    }
    if(!result){
      result = dispatch_(action, data, props) || {};
      // تُحفظ النتيجة قبل إرفاق بيانات الإدارة (الكبيرة)، وإن بقيت كبيرة نحفظ نسخة مختصرة بدون التقرير —
      // المهم أن يبقى أثر "تم التنفيذ" دائمًا، وإلا تُنفَّذ إعادة المحاولة مرتين (سلفة مكررة مثلًا)
      if(reqKey){
        let s = JSON.stringify(result);
        if(s.length >= 90000){ const slim = Object.assign({}, result); delete slim.report; s = JSON.stringify(slim); }
        cache.put(reqKey, s.length < 90000 ? s : '{}', 600);
        if(doneKey) cache.put(doneKey, '1', CACHE_TTL);
      }
    }
    // إصدار البيانات بعد هذه الكتابة يُثبَّت داخل القفل؛ البيانات المرفقة تُقرأ بعده فتكون مثله أو أحدث
    if(ATTACH_ADMIN[action]) version = commitDataVersion_() || dataVersion_();
    return result;
  });
  // بيانات اللوحة تُقرأ بعد تحرير القفل: قراءة كل الأوراق لا تؤخّر تسجيل حضور العمال في نفس اللحظة.
  // (الأوراق التي قُرئت أثناء العملية تبقى في الذاكرة محدّثة بكتاباتها، فلا تُقرأ مرتين)
  // since: إصدار نسخة اللوحة لدى المدير — فيُرفق ما تغيّر منذه فقط (سجل التغييرات) بدل كل البيانات
  if(version && isAdminToken_(result.token || data.token))
    result.admin = actionGetAdminData_(String(data.since || ''), version, !!data.delta);
  // بيانات العامل (الحضور) بعد تحرير القفل أيضًا — وتُقرأ طازجة حتى لرد مكرر من ذاكرة منع التكرار
  if(result && result._payloadPhone){
    const phone = result._payloadPhone, out = Object.assign({}, result);
    delete out._payloadPhone;
    const w = liveWorker_(phone);
    return w ? Object.assign(out, workerPayload_(w, approvedDeviceRow_(phone))) : out;
  }
  return result;
}

function dispatch_(action, data, props){
  const admin = fn => { requireAdmin_(data.token); return fn() || {}; };
  switch(action){
    case 'adminOptions':        return actionAdminOptions_(data);
    case 'adminLogin':          return actionAdminLogin_(data);
    case 'adminUnlock':         return actionAdminUnlock_(data);
    case 'adminLogout':         return actionAdminLogout_(data);
    case 'adminSecurity':       return admin(()=>actionAdminSecurity_(data));
    case 'adminRemoveKey':      return admin(()=>actionAdminRemoveKey_(data));
    case 'adminAddKey':         return admin(()=>actionAdminAddKey_(data));
    case 'adminLogoutOthers':   return admin(()=>actionAdminLogoutOthers_(data));
    case 'adminChangePassword': return admin(()=>actionAdminChangePassword_(data));
    case 'verifyReport':        return actionVerifyReport_(data);
    case 'getPushKey':          return actionGetPushKey_();
    case 'savePush':            return actionSavePush_(data);
    case 'removePush':          return actionRemovePush_(data);
    case 'getNotifications':    return actionGetNotifications_(data);
    case 'checkPhone':          return actionCheckPhone_(data);
    case 'register':            return actionRegister_(data);
    case 'getWorkerData':       return actionGetWorkerData_(data);
    case 'refreshDeviceStatus': return actionRefreshDeviceStatus_(data);
    case 'checkin':             return actionCheckin_(data);
    case 'workerDeleteOwnAccount': return actionWorkerDeleteOwnAccount_(data);
    case 'passkeyOptions':      return actionPasskeyOptions_(data);
    case 'passkeyRegister':     return actionPasskeyRegister_(data);
    case 'passkeyUnlock':       return actionPasskeyUnlock_(data);
    case 'ackSettlement':       return actionAckSettlement_(data);

    case 'getAdminData':        return admin(()=>actionGetAdminData_(String(data.since||''), '', !!data.delta));
    case 'approveWorker':       return admin(()=>actionApproveWorker_(data));
    case 'rejectWorker':        return admin(()=>actionRejectWorker_(data));
    case 'adminDeleteWorker':   return admin(()=>actionAdminDeleteWorker_(data));
    case 'decideAttendance':    return admin(()=>actionDecideAttendance_(data));
    case 'approveAllPending':   return admin(()=>actionApproveAllPending_(data));
    case 'addAdvance':          return admin(()=>actionAddAdvance_(data));
    case 'settleWorkerAccount': return admin(()=>actionSettleWorkerAccount_(data));
    case 'closeMonthForAll':    return admin(()=>actionCloseMonthForAll_(data));
    case 'previewMonthReport':  return admin(()=>actionPreviewMonthReport_(data));
    case 'getArchive':          return admin(()=>actionGetArchive_(data));
    case 'approveDevice':       return admin(()=>actionApproveDevice_(data));
    case 'rejectDevice':        return admin(()=>actionRejectDevice_(data));
    case 'resetDeviceLock':     return admin(()=>actionResetDeviceLock_(data));

    default: throw new Error('إجراء غير معروف: '+action);
  }
}

/* ---------------------------- الدخول برقم الهاتف + الجهاز ---------------------------- */

function actionCheckPhone_(data){
  const phone = String(data.phone||'');
  const deviceId = String(data.deviceId||'');
  const userAgent = safeText_(data.userAgent, 300);
  if(!phoneKey_(phone)) throw new Error('رقم الهاتف غير صالح');
  if(!validDeviceId_(deviceId)) throw new Error('تعذر تحديد الجهاز');

  const w = liveWorker_(phone);
  if(!w){
    // رقم جديد من جهاز مسجل لعامل آخر: الواجهة تنبّه أن الحساب الجديد يحتاج موافقة الإدارة وينقل الجهاز إليه
    // (الواجهات قبل 2.9.4 تمنع التسجيل عند deviceBound)
    const owner = deviceOwner_(deviceId, phone);
    return owner ? { exists:false, deviceBound:true, boundName: String(owner.name).split(' ')[0] } : { exists:false };
  }
  const known = (w2, dev) => dev.pkKey && !isWorkerSession_(data.session, dev) ? lockedOut_(w2)
    : Object.assign({ exists:true, deviceOk:true }, workerPayload_(w2, dev));

  // المسار السريع (بدون قفل): الجهاز معتمد
  const info = deviceInfo_(data);
  const dev0 = deviceRowFor_(phone, deviceId);
  if(dev0){
    // ربط الجهاز: نفس معرّف الجهاز بطراز هاتف مختلف = الحساب يُفتح من هاتف آخر (نُسخت بيانات التطبيق مثلًا)
    // ← يُعلَّق حتى توافق الإدارة من جديد
    if(info.model && dev0.model && !sameModel_(info.model, dev0.model)){
      const r = withLock_(() => rebindDevice_(phone, deviceId, info, userAgent));
      if(r) return r;
    }else if(info.model && (!dev0.model || info.os !== String(dev0.os || '') || info.browser !== String(dev0.browser || ''))){
      // أول فتح بعد التحديث (صف بلا طراز)، أو تحديث النظام/المتصفح: تُسجَّل معلومات الهاتف في الشيت
      withLock_(() => {
        const d = deviceRowFor_(phone, deviceId);
        if(d && (!d.model || sameModel_(d.model, info.model))){ ensureHeader_('Devices'); updateRows_('Devices', [{ row:d, patch:info }]); }
      });
    }
    return known(w, dev0);
  }

  // جهاز غير معروف: إنشاء طلب واحد فقط لكل (رقم + جهاز) — داخل القفل
  return withLock_(()=>{
    const w2 = liveWorker_(phone);
    if(!w2) return { exists:false };
    const dev1 = deviceRowFor_(phone, deviceId);
    if(dev1) return known(w2, dev1);
    // جهاز مرتبط بعامل آخر يريد فتح هذا الحساب: طلب موافقة للإدارة (اعتماده ينقل الجهاز إلى هذا الحساب)
    const owner = deviceOwner_(deviceId, phone);
    const switchFrom = owner ? String(owner.name).split(' ')[0] : '';
    const rows = readAll_('Devices').filter(d => samePhone_(d.phone, phone) && String(d.deviceId) === deviceId);
    let dev = rows.length ? rows[rows.length-1] : null;
    if(!dev){
      // جهاز جديد لرقم مسجل: يلزم الاسم المسجل نفسه (الرقم وحده لا يكفي لفتح طلب)
      const name = cleanName_(data.name);
      if(!name) throw new Error('دخول من جهاز جديد: اكتب اسمك الكامل كما سجلته أول مرة');
      rateLimit_('nm_'+phoneKey_(phone), 6, 3600, 'محاولات كثيرة لهذا الرقم، حاول بعد ساعة');
      if(normName_(name) !== normName_(w2.name)) throw new Error('الاسم لا يطابق الاسم المسجل لهذا الرقم');
      // حماية من الإغراق: من يعرف رقم عامل لا يستطيع ملء الشيت بطلبات أجهزة وهمية
      const pendingForPhone = readAll_('Devices').filter(d => d.status === 'pending' && samePhone_(d.phone, phone)).length;
      if(pendingForPhone >= MAX_PENDING_DEVICES_PER_PHONE)
        throw new Error('يوجد طلب جهاز معلّق لهذا الرقم بالفعل — انتظر قرار الإدارة أو تواصل معها');
      rateLimit_('dev_'+phoneKey_(phone), 5, 3600, 'محاولات كثيرة من أجهزة جديدة لهذا الرقم، حاول بعد ساعة');
      rateLimit_('dev_all', 60, 3600, 'طلبات أجهزة كثيرة حاليًا، حاول لاحقًا');
      dev = Object.assign({ id:newId_(), phone:w2.phone, workerName:w2.name, deviceId, userAgent, status:'pending', createdAt:new Date().toISOString(), decidedAt:'' }, info);
      ensureHeader_('Devices');
      appendObj_('Devices', dev);
      appendObj_('DeviceLogs', { id:newId_(), phone:w2.phone, workerName:w2.name, deviceId, userAgent,
        event: owner ? 'طلب فتح الحساب من جهاز مرتبط بحساب «' + owner.name + '»' : 'محاولة دخول من جهاز غير معروف', timestamp:Date.now() });
      if(owner) notifyAdmin_('طلب فتح حساب آخر', 'جهاز «' + owner.name + '» يطلب فتح حساب ' + w2.name + ' — بانتظار موافقتك', 'adm-devices');
      else notifyAdmin_('طلب جهاز جديد', w2.name + ' يحاول الدخول من جهاز جديد', 'adm-devices');
    }else if(dev.status === 'replaced'){
      // جهاز قديم عاد بعد استبداله: نعيد فتح نفس الطلب بدل إضافة صف جديد
      updateRows_('Devices', [{ row:dev, patch:{ status:'pending', createdAt:new Date().toISOString(), decidedAt:'' } }]);
      dev.status = 'pending';
    }
    return { exists:true, deviceOk:false, deviceStatus: dev.status, switchFrom };
  });
}

// نفس معرّف الجهاز بطراز هاتف آخر: الجهاز يُعلَّق (pending) حتى توافق الإدارة، ويُسجَّل الحدث للإدارة.
// (مفتاح قفل الهاتف يبقى كما هو: إن كان هاتفًا آخر فعلًا فلن يفتح بالقفل إلا بعد إعادة ضبطه من الإدارة)
function rebindDevice_(phone, deviceId, info, userAgent){
  const w = liveWorker_(phone), d = deviceRowFor_(phone, deviceId);
  if(!w || !d || !d.model || sameModel_(d.model, info.model)) return null; // تغيّر أثناء الانتظار: المسار العادي
  ensureHeader_('Devices');
  appendObj_('DeviceLogs', { id:newId_(), phone:w.phone, workerName:w.name, deviceId, userAgent,
    event:'تغيّر طراز الهاتف لنفس الجهاز: كان «' + d.model + '» والآن «' + info.model + '» — عُلّق حتى موافقة الإدارة', timestamp:Date.now() });
  updateRows_('Devices', [{ row:d, patch:Object.assign({ status:'pending', createdAt:new Date().toISOString(), decidedAt:'', userAgent }, info) }]);
  notifyAdmin_('هاتف مختلف لنفس الحساب', w.name + ' يفتح حسابه من هاتف بطراز مختلف (' + info.model + ') — بانتظار موافقتك', 'adm-devices');
  return { exists:true, deviceOk:false, deviceStatus:'pending' };
}
const MAX_PENDING_DEVICES_PER_PHONE = 2;
// عدّاد بسيط في الذاكرة المؤقتة: يرفض بعد max محاولة خلال windowSec ثانية (يُستدعى داخل القفل)
function rateLimit_(name, max, windowSec, msg){
  const cache = cache_(), key = 'rl_'+name;
  const n = Number(cache.get(key)||0);
  if(n >= max) throw new Error(msg);
  cache.put(key, String(n+1), windowSec);
}

function actionRefreshDeviceStatus_(data){
  const phone = String(data.phone||''), deviceId = String(data.deviceId||'');
  const w = liveWorker_(phone);
  if(!w) return { deviceStatus:'deleted' };
  const cur = deviceRowFor_(phone, deviceId);
  if(cur) return Object.assign({ deviceStatus:'approved' }, cur.pkKey && !isWorkerSession_(data.session, cur) ? lockedOut_(w) : workerPayload_(w, cur));
  const rows = readAll_('Devices').filter(d => samePhone_(d.phone, phone) && String(d.deviceId) === deviceId);
  const dev = rows.length ? rows[rows.length-1] : null;
  return { deviceStatus: dev ? (dev.status === 'approved' ? 'replaced' : dev.status) : 'pending' };
}

function actionRegister_(data){
  const phone = cleanPhone_(data.phone);
  const deviceId = String(data.deviceId||'');
  const name = cleanName_(data.name);
  const profession = String(data.profession||'').trim();
  const userAgent = safeText_(data.userAgent, 300);
  if(!data.phone || !deviceId || !name) throw new Error('بيانات ناقصة');
  if(!phone || !/^\d{8,15}$/.test(phoneKey_(phone))) throw new Error('رقم الهاتف غير صالح');
  if(!validDeviceId_(deviceId)) throw new Error('تعذر تحديد الجهاز');
  if(!validName_(name)) throw new Error('اكتب اسمك الثنائي على الأقل (حروف فقط)');
  if(PROFESSIONS.indexOf(profession) < 0) throw new Error('اختر المهنة من القائمة');
  const probes = probeList_(data);
  if(!probes.length) throw new Error('لم تصل بصمة الوجه إلى الخادم، أعد الالتقاط');
  for(let i = 0; i < probes.length; i++) for(let j = i + 1; j < probes.length; j++)
    if(faceDistance_(probes[i], probes[j]) > FACE_CONSISTENT) throw new Error('لقطات الوجه غير متطابقة — أعد الالتقاط وثبّت وجهك في إضاءة جيدة');

  // (يعمل داخل القفل عبر handle_)
  const existing = liveWorker_(phone);
  if(existing){
    // نقرة مزدوجة/إعادة إرسال من نفس الجهاز: نعيد الحساب الموجود بدل الخطأ أو التكرار
    const dev = deviceRowFor_(phone, deviceId);
    if(dev) return workerPayload_(existing, dev);
    throw new Error('هذا الرقم مسجل بالفعل');
  }
  // جهاز مرتبط بعامل آخر، أو وجه مطابق لعامل مسجل: لا رفض — طلب التسجيل يصل للإدارة مع تنبيه واضح وهي تقرر.
  // قبول الحساب ينقل الجهاز إليه (يُلغى ربطه بالحساب السابق)، ورفضه يُبقي كل شيء كما كان
  const owner = deviceOwner_(deviceId, phone);
  const twin = readAll_('Workers').find(w => w.status !== 'deleted' && storedDescriptors_(w).some(r => probes.some(p => faceDistance_(p, r) < FACE_DUPLICATE)));
  if(owner) appendObj_('DeviceLogs', { id:newId_(), phone, workerName:name, deviceId, userAgent, event:'طلب حساب جديد من جهاز مرتبط بحساب «' + owner.name + '»', timestamp:Date.now() });
  if(twin) appendObj_('DeviceLogs', { id:newId_(), phone, workerName:name, deviceId, userAgent, event:'طلب تسجيل بوجه مطابق للعامل «' + twin.name + '»', timestamp:Date.now() });
  const reviewNote = twin ? 'الوجه مطابق للعامل «' + twin.name + '» (' + twin.phone + ') — قد يكون نفس الشخص بحساب ثانٍ' : '';
  // حماية من إغراق طلبات التسجيل بأرقام وهمية (يكفي لتسجيل دفعة عمال كبيرة في اليوم الأول)
  rateLimit_('reg_all', 40, 600, 'طلبات تسجيل كثيرة حاليًا، حاول بعد دقائق');
  if(readAll_('Workers').filter(w => w.status === 'pending').length >= 300)
    throw new Error('طلبات التسجيل المعلّقة كثيرة — تواصل مع الإدارة');
  const now = new Date().toISOString();
  // أي أجهزة معتمدة قديمة لنفس الرقم (من حساب محذوف سابقًا) تفقد صلاحيتها
  const old = readAll_('Devices').filter(d => d.status === 'approved' && samePhone_(d.phone, phone));
  updateRows_('Devices', old.map(row => ({ row, patch:{ status:'replaced', decidedAt:now } })));

  // البصمات المرجعية: متوسط اللقطات (الأكثر استقرارًا) + كل لقطة وحدها (زوايا وإضاءة مختلفة قليلًا)
  const refs = probes.length > 1
    ? [probes[0].map((_, i) => probes.reduce((s, p) => s + p[i], 0) / probes.length)].concat(probes) : probes;
  const worker = {
    id:newId_(), name, profession, phone, wage:0, status:'pending',
    descriptor: JSON.stringify(refs.map(roundDesc_)), createdAt:now, lastSettledAt: Date.now(), reviewNote
  };
  if(reviewNote) ensureHeader_('Workers');
  appendObj_('Workers', worker);
  // أول جهاز يسجّل منه العامل يُعتمد تلقائيًا (هو صاحب الحساب الجديد). إن كان مرتبطًا بعامل آخر يبقى له
  // حتى تقبل الإدارة الحساب الجديد (فيُنقل إليه) — الحساب المعلّق لا يستطيع تسجيل الحضور أصلًا
  ensureHeader_('Devices');
  appendObj_('Devices', Object.assign({ id:newId_(), phone, workerName:name, deviceId, userAgent, status:'approved', createdAt:now, decidedAt:now }, deviceInfo_(data)));
  notifyAdmin_('طلب تسجيل جديد', name + ' (' + profession + ') بانتظار القبول'
    + (owner ? ' — من جهاز مرتبط بحساب «' + owner.name + '»' : '') + (twin ? ' — ⚠ وجه مطابق لـ «' + twin.name + '»' : ''), 'adm-workers');
  return { worker: workerOut_(worker), log: [], advances: [], passkey: false };
}

/* التحديث الخلفي لهاتف العامل — ثلاث طبقات، الأرخص أولًا:
 * 1) لا كتابة إطلاقًا منذ آخر تحديث لديه (version): رد فوري
 * 2) كتابات لعمال آخرين فقط (إصدار هذا العامل wv لم يتغير): رد فوري أيضًا بلا قراءة أي ورقة
 * 3) تغيّر شيء يخصه: قراءة بياناته، وبصمتها (hash) تمنع إرسالها إن جاءت مطابقة لما لديه
 * الإصداران يُقرآن قبل البيانات: كتابة تحدث أثناء القراءة تغيّرهما فتُلتقط في الاستعلام التالي */
function actionGetWorkerData_(data){
  const version = dataVersion_();
  if(data.since && String(data.since) === version) return { unchanged:true, version };
  const wid = String(data.wid || '').slice(0, 60);
  let wv = wid ? workerVersion_(wid) : '';
  if(wv && String(data.wv || '') === wv) return { unchanged:true, version, wv };
  const w = requireWorkerSession_(data);
  if(String(w.id) !== wid) wv = workerVersion_(String(w.id));
  const dev = approvedDeviceRow_(w.phone), session = renewedSession_(data.session, dev);
  const payload = workerPayload_(w, dev);
  const hash = b64url_(sha256Text_(JSON.stringify(payload))).slice(0, 22);
  if(data.hash && String(data.hash) === hash) return Object.assign({ unchanged:true, version, wv, hash }, session ? { session } : {});
  return Object.assign({ version, wv, hash }, payload, session ? { session } : {});
}

/* من سجّل حضوره اليوم: مجموعة في الذاكرة المؤقتة تُبنى من ورقة الدوام مرة واحدة في اليوم (أو بعد مسحها)،
 * ثم تُحدَّث مع كل حضور — فلا تُقرأ ورقة الدوام كاملة (تكبر كل يوم) داخل القفل مع كل حضور وقت الذروة.
 * كانت هذه القراءة تُطيل مدة القفل، فتتكدس طلبات الحضور خلفه حتى تمتلئ حصة Google من التنفيذات المتزامنة
 * فيرد بصفحة «يتعذر فتح الملف» (404) لكل الطلبات. تعديل يدوي في الشيت (onEdit) يمسحها فتُبنى من جديد */
const checkedInKey_ = date => 'cid_' + date;
function checkedInToday_(date){
  const c = cache_();
  let set = null; try{ set = JSON.parse(c.get(checkedInKey_(date)) || 'null'); }catch(e){}
  if(set && typeof set === 'object') return set;
  set = {};
  readAll_('Log').forEach(r => { if(dateStr_(r.date) === date) set[String(r.workerId)] = 1; });
  try{ c.put(checkedInKey_(date), JSON.stringify(set), CACHE_TTL); }catch(e){}
  return set;
}
function actionCheckin_(data){
  const w = requireWorkerSession_(data);
  if(w.status !== 'active') throw new Error('لا يمكن تسجيل الحضور لهذا الحساب');
  const { date, time } = riyadhTodayParts_();
  const id = String(w.id);
  const today = checkedInToday_(date);
  const already = !!today[id];
  if(!already){
    // التحقق من الوجه في الخادم: لا يكفي امتلاك الجهاز المعتمد لتسجيل الحضور
    const refs = storedDescriptors_(w);
    if(!refs.length) throw new Error('لا توجد بصمة وجه محفوظة لهذا الحساب — تواصل مع الإدارة');
    // محاولات وجه غير مطابق متكررة (صور/أشخاص آخرون): إيقاف مؤقت ساعة، وتُسجَّل للإدارة في ورقة Logs
    const cache = cache_(), failKey = 'ff_' + id, fails = Number(cache.get(failKey) || 0);
    if(fails >= FACE_MAX_FAILS) throw new Error('تم إيقاف التحقق مؤقتًا بعد محاولات غير مطابقة متكررة — حاول بعد ساعة أو تواصل مع الإدارة');
    const probes = probeList_(data);
    if(!probes.length) throw new Error('لم تصل بصمة الوجه إلى الخادم، أعد المحاولة');
    const dists = probes.map(p => bestDistance_(p, refs));
    const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
    if(avg > FACE_MATCH_THRESHOLD || Math.max.apply(null, dists) > FACE_MAX_DISTANCE){
      cache.put(failKey, String(fails + 1), 3600);
      if(fails + 1 === FACE_MAX_FAILS) appendObj_('DeviceLogs', { id:newId_(), phone:w.phone, workerName:w.name, deviceId:String(data.deviceId||''), userAgent:'',
        event:'أُوقف تسجيل الحضور ساعة: ' + FACE_MAX_FAILS + ' محاولات بوجه غير مطابق', timestamp:Date.now() });
      throw new Error('الوجه غير مطابق لصاحب الحساب، حاول مرة أخرى');
    }
    cache.remove(failKey);
    appendObj_('Log', { id:newId_(), workerId:w.id, workerName:w.name, wage:w.wage, date, time, timestamp:Date.now(), status:'pending' });
    today[id] = 1;
    try{ cache.put(checkedInKey_(date), JSON.stringify(today), CACHE_TTL); }catch(e){}
    notifyAdmin_('طلب حضور جديد', w.name + ' سجّل حضوره الساعة ' + time, 'adm-log');
  }
  // بيانات العامل تُقرأ بعد تحرير القفل (handle_) — لا تُطيل مدة القفل على الآخرين
  return { alreadyCheckedIn: already, _payloadPhone: String(w.phone) };
}

// حذف ناعم (من العامل نفسه أو من الإدارة): يُلغى الحساب وتُسحب صلاحية أجهزته وتُمسح بصمة وجهه،
// وتبقى سجلات الحضور والسلف والتصفيات (سجلات مالية) ويبقى رصيده ظاهرًا في الحسابات والتقرير.
// أي طلب حضور معلّق لم يعد له صاحب نشط: يُرفض حتى لا يعطّل التصفية وإقفال الشهر
function softDeleteWorker_(w, event){
  const id = String(w.id), now = new Date().toISOString();
  updateRows_('Workers', [{ row:w, patch:{ status:'deleted', descriptor:'' } }]);
  const pendingLog = readAll_('Log').filter(r => String(r.workerId) === id && r.status === 'pending');
  updateRows_('Log', pendingLog.map(row => ({ row, patch:{ status:'rejected' } })));
  const devs = readAll_('Devices').filter(d => samePhone_(d.phone, w.phone) && (d.status === 'approved' || d.status === 'pending'));
  updateRows_('Devices', devs.map(row => ({ row, patch:{ status:'replaced', decidedAt:now } })));
  appendObj_('DeviceLogs', { id:newId_(), phone:w.phone, workerName:w.name, deviceId:'', userAgent:'', event, timestamp:Date.now() });
}
function actionWorkerDeleteOwnAccount_(data){
  softDeleteWorker_(requireWorkerSession_(data), 'حذف العامل حسابه من التطبيق');
  return {};
}

/* ---------------------------- الإدارة ---------------------------- */
/* بيانات لوحة الإدارة. السجلات تُرسل لنافذة محدودة لا منذ البداية (وإلا كبر الرد كل شهر حتى يبطئ
 * الفتح ويتجاوز مساحة التخزين المحلي): الشهر الحالي وما قبله بـ ADMIN_HISTORY_MONTHS - 1، مع كل سجل
 * لم يُصفَّ بعد أو معلّق مهما كان قديمًا (فالحسابات والأرصدة تبقى صحيحة). الأقدم في الأرشيف والشيت.
 * version: إصدار البيانات مقروءًا قبلها — أو المُثبّت داخل القفل بعد كتابة (fixedVersion) */
const ADMIN_HISTORY_MONTHS = 3;
// allowDelta: الواجهة تعلن أنها تفهم «ما تغيّر فقط» (delta:1) — الواجهات الأقدم تستلم النسخة الكاملة دائمًا
// (كانت ستعرض الصفوف المتغيرة وحدها كأنها كل البيانات)
function actionGetAdminData_(since, fixedVersion, allowDelta){
  const version = fixedVersion || dataVersion_();
  if(since && since === version) return { unchanged:true, version };
  const historyFrom = monthsBack_(riyadhTodayParts_().month, ADMIN_HISTORY_MONTHS - 1) + '-01';
  // «ما تغيّر فقط»: السلسلة تصل إصدار اللوحة بالحالي ← الصفوف المتغيرة وحدها (وتُقرأ الأوراق المتغيرة وحدها)
  const ch = since && allowDelta ? changesSince_(since, version) : null;
  if(ch) return adminDelta_(ch, since, version, historyFrom);
  const allWorkers = readAll_('Workers'), settledAt = {};
  allWorkers.forEach(w => settledAt[String(w.id)] = Number(w.lastSettledAt) || 0);
  const workers = adminWorkers_(() => true);
  const inWindow = r => dateStr_(r.date) >= historyFrom || r.status === 'pending' || Number(r.timestamp) > (settledAt[String(r.workerId)] || 0);
  const log = readAll_('Log').filter(inWindow).map(logOut_);
  const advances = readAll_('Advances').filter(inWindow).map(advanceOut_);
  const archives = readAll_('Archives').map(archiveOut_);
  const pendingDevices = pendingDevicesOut_();
  return { workers, log, advances, archives, pendingDevices, historyFrom, version };
}
// العمال كما تعرضهم اللوحة (+ هل فعّل قفل الهاتف على جهازه المعتمد الحالي — آخر اعتماد لكل رقم)
function adminWorkers_(keep){
  const locked = {};
  readAll_('Devices').forEach(d => { if(d.status === 'approved') locked[phoneKey_(d.phone)] = !!d.pkKey; });
  return readAll_('Workers').filter(keep).map(w => {
    const out = Object.assign(workerOut_(w), { passkey: !!locked[phoneKey_(w.phone)] });
    if(w.status === 'pending'){ // تنبيهات طلب التسجيل للإدارة فقط (لا تُرسل للعامل)
      const dev = approvedDeviceRow_(w.phone), owner = dev && deviceOwner_(String(dev.deviceId), w.phone);
      if(owner) out.deviceFrom = String(owner.name);
      if(w.reviewNote) out.reviewNote = String(w.reviewNote);
    }
    return out;
  });
}
// طلبات الأجهزة المعلّقة مع معلومات الهاتف (الطراز، النظام، المتصفح) لقرار الإدارة.
// fromName: العامل المرتبط به هذا الجهاز الآن — اعتماد الطلب ينقل الجهاز منه إلى صاحب الطلب
function pendingDevicesOut_(){
  return readAll_('Devices').filter(d => d.status === 'pending').map(d => {
    const owner = deviceOwner_(String(d.deviceId), d.phone);
    return { id:String(d.id), phone:String(d.phone), workerName:String(d.workerName||''), deviceId:String(d.deviceId), userAgent:d.userAgent,
      model:String(d.model||''), os:String(d.os||''), browser:String(d.browser||''), createdAt:isoStr_(d.createdAt), fromName: owner ? String(owner.name) : '' };
  });
}
// رد «ما تغيّر فقط»: الصفوف المتغيرة + المحذوفة؛ الأرشيف وطلبات الأجهزة كاملة إن تغيّرت (قوائم صغيرة)
function adminDelta_(ch, since, version, historyFrom){
  const has = o => Object.keys(o).length > 0;
  const out = { delta:true, since, version, historyFrom,
    removed:{ workers:Object.keys(ch.rw), log:Object.keys(ch.rl), advances:Object.keys(ch.ra) } };
  if(has(ch.w)) out.workers = adminWorkers_(w => ch.w[String(w.id)]);
  if(has(ch.l)) out.log = readAll_('Log').filter(r => ch.l[String(r.id)]).map(logOut_);
  if(has(ch.a)) out.advances = readAll_('Advances').filter(a => ch.a[String(a.id)]).map(advanceOut_);
  if(ch.ar) out.archives = readAll_('Archives').map(archiveOut_);
  if(ch.d) out.pendingDevices = pendingDevicesOut_();
  return out;
}

function actionApproveWorker_(data){
  const wage = Number(data.wage);
  if(!isFinite(wage) || wage<=0) throw new Error('قيمة يومية غير صحيحة');
  const before = workerById_(data.workerId);
  if(!before) throw new Error(ERR_WORKER);
  // حساب محذوف لا يُعاد تفعيله (قد يكون صاحب الرقم سجّل من جديد بحساب آخر)
  if(before.status === 'deleted') throw new Error(ERR_DELETED);
  const wasPending = before.status === 'pending'; // قبل التحديث (الكائن نفسه يتحدث في الذاكرة)
  const w = updateById_('Workers', data.workerId, wasPending && before.reviewNote ? { status:'active', wage, reviewNote:'' } : { status:'active', wage });
  if(wasPending){
    // سُجّل من جهاز مرتبط بعامل آخر: القبول ينقل الجهاز إلى الحساب الجديد
    const dev = approvedDeviceRow_(w.phone);
    if(dev) releaseDeviceFromOthers_(dev, new Date().toISOString());
    notifyWorker_(w, 'تم قبول حسابك 🎉', 'وافقت الإدارة على تسجيلك بيومية ' + money_(wage) + '. يمكنك الآن تسجيل الحضور', 'account');
  }
  return {};
}
// رفض طلب تسجيل: حذف فعلي فقط لحساب معلّق بلا أي سجل مالي؛ غير ذلك يُعامل كحذف ناعم
function actionRejectWorker_(data){
  const id = String(data.workerId||'');
  const w = workerById_(id);
  if(!w) throw new Error(ERR_WORKER);
  const hasRecords = ['Log','Advances','Settlements'].some(k => readAll_(k).some(r => String(r.workerId) === id));
  if(w.status !== 'pending' || hasRecords) return actionAdminDeleteWorker_(data);
  deleteWhere_('Workers', r=>String(r.id)===id);
  deleteWhere_('Devices', d=>samePhone_(d.phone, w.phone));
  return {};
}

function actionAdminDeleteWorker_(data){
  const w = workerById_(data.workerId);
  if(!w) throw new Error(ERR_WORKER);
  if(w.status !== 'deleted') softDeleteWorker_(w, 'حذفت الإدارة حساب العامل');
  return {};
}
function actionDecideAttendance_(data){
  if(data.decision !== 'approved' && data.decision !== 'rejected') throw new Error('قرار غير صالح');
  const prev = readAll_('Log').find(x => String(x.id) === String(data.logId));
  const prevStatus = prev ? prev.status : ''; // قبل التحديث (الكائن نفسه يتحدث في الذاكرة)
  const r = updateById_('Log', data.logId, { status:data.decision });
  if(!r) throw new Error('السجل غير موجود');
  if(prevStatus !== data.decision){ // لا إشعار مكرر عند نقرة مزدوجة
    const w = workerById_(r.workerId);
    if(data.decision === 'approved') notifyWorker_(w, 'تم اعتماد حضورك ✓', 'اعتمدت الإدارة حضورك ليوم ' + dateStr_(r.date), 'att');
    else notifyWorker_(w, 'تم رفض حضور', 'رفضت الإدارة حضورك ليوم ' + dateStr_(r.date), 'att');
  }
  return {};
}
function actionApproveAllPending_(data){
  const ids = {}; (data.ids||[]).forEach(id => ids[String(id)] = 1);
  const rows = readAll_('Log').filter(r => ids[String(r.id)] && r.status === 'pending');
  updateRows_('Log', rows.map(row => ({ row, patch:{ status:'approved' } }))); // قراءة واحدة بدل قراءة لكل سجل
  // إشعار واحد لكل عامل (لا إشعار لكل يوم)
  const byWorker = {}; rows.forEach(r => (byWorker[String(r.workerId)] = byWorker[String(r.workerId)] || []).push(dateStr_(r.date)));
  const workers = readAll_('Workers');
  Object.keys(byWorker).forEach(id => {
    const days = byWorker[id], w = workers.find(x => String(x.id) === id);
    notifyWorker_(w, 'تم اعتماد حضورك ✓', days.length === 1 ? 'اعتمدت الإدارة حضورك ليوم ' + days[0] : 'اعتمدت الإدارة ' + days.length + ' أيام من حضورك', 'att');
  });
  return { count: rows.length };
}
function actionAddAdvance_(data){
  const amount = Number(data.amount);
  if(!isFinite(amount) || amount <= 0) throw new Error('قيمة سلفة غير صحيحة');
  const w = workerById_(data.workerId);
  if(!w) throw new Error(ERR_WORKER);
  if(w.status === 'deleted') throw new Error(ERR_DELETED);
  const { date } = riyadhTodayParts_(), note = safeText_(data.note, 200);
  appendObj_('Advances', { id:newId_(), workerId:w.id, workerName:w.name, amount, note, date, timestamp:Date.now() });
  notifyWorker_(w, 'سلفة جديدة', 'سُجّلت عليك سلفة بمبلغ ' + money_(amount) + (note ? ' — ' + note.slice(0,60) : ''), 'adv');
  return {};
}
// إن كان الصافي سالبًا (السلف أكبر من المستحق) لا يضيع الفرق: يُرحَّل كسلفة للفترة التالية.
// (سابقًا كان الفرق يُمحى تلقائيًا عند تحريك lastSettledAt فتخسر المنشأة المبلغ)
function carryAdvance_(w, net, afterTs, label){
  if(net >= 0) return null;
  const ts = afterTs + 1;
  return { id:newId_(), workerId:w.id, workerName:w.name, amount:money_(-net),
    note:'رصيد سالب مرحّل من '+label, date:Utilities.formatDate(new Date(ts), TZ, 'yyyy-MM-dd'), timestamp:ts };
}

function actionSettleWorkerAccount_(data){
  const w = workerById_(data.workerId);
  if(!w) throw new Error(ERR_WORKER);
  const log = readAll_('Log'), advances = readAll_('Advances');
  const pending = countPending_(w, log);
  if(pending) throw new Error('يوجد '+pending+' طلب حضور معلّق — اعتمده أو ارفضه قبل التصفية');
  const { earned, advanced, net } = computeAccount_(w, log, advances);
  if(!earned && !advanced) throw new Error('لا يوجد رصيد لتصفيته');
  const { date } = riyadhTodayParts_();
  const now = Date.now();
  const paid = Math.max(net, 0);
  const since = Number(w.lastSettledAt)||0, id = String(w.id);
  const days = log.filter(r => String(r.workerId) === id && r.status === 'approved' && Number(r.timestamp) > since).length;
  const carry = carryAdvance_(w, net, now, 'تصفية '+date);
  ensureHeader_('Settlements');
  appendObj_('Settlements', { id:newId_(), workerId:w.id, workerName:w.name, amount:paid, date, timestamp:now, month:'',
    earned, advances:advanced, carried: carry ? carry.amount : 0, days, ackAt:'' });
  if(carry) appendObj_('Advances', carry);
  updateRows_('Workers', [{ row:w, patch:{ lastSettledAt: now } }]);
  notifyWorker_(w, 'تمت تصفية حسابك', 'المستحق ' + earned + ' − السلف ' + advanced + ' = المدفوع ' + paid + (carry ? ' (رصيد مرحّل ' + carry.amount + ')' : ''), 'settle');
  return { earned, advanced, net, paid, carried: carry ? carry.amount : 0 };
}

/* ---------------------------- التقرير الشهري (مصدر واحد للمعاينة والإقفال وملف PDF) ---------------------------- */
const DAY_CODE = { approved:'A', pending:'P', rejected:'R' };

function validMonth_(month){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('شهر غير صالح');
  if(month > riyadhTodayParts_().month) throw new Error('لا يمكن تصفية شهر لم يبدأ بعد');
}

function buildMonthReport_(month){
  const allWorkers = readAll_('Workers');
  const log = readAll_('Log'), advances = readAll_('Advances');
  const untilTs = Math.min(monthEndTs_(month), Date.now());
  const numDays = daysInMonth_(month);
  const byId = {}; allWorkers.forEach(w => byId[String(w.id)] = w);

  // سجلات حضور هذا الشهر (حسب التاريخ)
  const monthLog = log.filter(r => dateStr_(r.date).indexOf(month) === 0);
  const dayIdx = {};
  monthLog.forEach(r => { const k = String(r.workerId)+'|'+dateStr_(r.date); if(!dayIdx[k]) dayIdx[k] = r; });
  const hasMonthRecords = {}; monthLog.forEach(r => hasMonthRecords[String(r.workerId)] = 1);

  // العمال المشمولون: النشطون + من ألغى حسابه ولديه رصيد أو حضور في الشهر (لا يسقط رصيده من التقرير)
  const workers = allWorkers.filter(w => {
    const st = w.status || 'active';
    if(st === 'active') return true;
    if(st !== 'deleted') return false;
    const acc = computeAccount_(w, log, advances, untilTs);
    return acc.earned || acc.advanced || hasMonthRecords[String(w.id)];
  });

  const pendingTotal = workers.reduce((n,w)=> n + countPending_(w, log, untilTs), 0)
    + monthLog.filter(r => r.status === 'pending' && !workers.some(w => String(w.id) === String(r.workerId))).length;

  const rows = [], advRows = [];
  workers.forEach(w => {
    const id = String(w.id);
    const acc = computeAccount_(w, log, advances, untilTs);
    let days = '', approvedDays = 0, monthEarned = 0;
    for(let d=1; d<=numDays; d++){
      const rec = dayIdx[id+'|'+month+'-'+String(d).padStart(2,'0')];
      days += rec ? (DAY_CODE[rec.status] || '-') : '-';
      if(rec && rec.status === 'approved'){ approvedDays++; monthEarned += recordWage_(rec, w); }
    }
    rows.push({ id, name:w.name, profession:w.profession||'', wage:Number(w.wage)||0, status:w.status||'active',
      days, approvedDays, monthEarned:money_(monthEarned),
      earned:acc.earned, advances:acc.advanced, net:acc.net,
      paid:Math.max(acc.net,0), carried:acc.net < 0 ? money_(-acc.net) : 0 });
    const since = Number(w.lastSettledAt)||0;
    advances.filter(a => String(a.workerId) === id && Number(a.timestamp) > since && Number(a.timestamp) <= untilTs)
      .forEach(a => advRows.push({ workerId:id, name:w.name, profession:w.profession||'', date:dateStr_(a.date),
        amount:money_(a.amount), note:String(a.note||''), timestamp:Number(a.timestamp)||0 }));
  });
  advRows.sort((a,b) => a.timestamp - b.timestamp);

  // التكلفة التشغيلية = مجموع أجور أيام الحضور المعتمدة بتاريخ هذا الشهر، مجمّعة حسب المهنة
  const prof = {};
  monthLog.filter(r => r.status === 'approved').forEach(r => {
    const w = byId[String(r.workerId)];
    const p = (w && w.profession) || 'غير محدد';
    const o = prof[p] || (prof[p] = { profession:p, ids:{}, days:0, cost:0 });
    o.ids[String(r.workerId)] = 1; o.days++; o.cost += recordWage_(r, w);
  });
  const professions = Object.keys(prof).map(k => ({ profession:k, workers:Object.keys(prof[k].ids).length,
    days:prof[k].days, cost:money_(prof[k].cost) })).sort((a,b) => b.cost - a.cost);

  const sum = (arr, f) => money_(arr.reduce((s,x) => s + (Number(x[f])||0), 0));
  return {
    month, monthLabel:monthLabel_(month), numDays, untilTs, generatedAt:new Date().toISOString(), pendingTotal,
    workers:rows, advances:advRows, professions,
    totals:{
      workers:rows.length, approvedDays:rows.reduce((s,r)=>s+r.approvedDays,0),
      totalCost:sum(professions,'cost'), totalEarned:sum(rows,'earned'), totalAdvances:sum(rows,'advances'),
      totalNet:sum(rows,'paid'), totalCarried:sum(rows,'carried'), totalAdvanceRows:sum(advRows,'amount')
    }
  };
}

function actionPreviewMonthReport_(data){
  const month = String(data.month||'');
  validMonth_(month);
  const report = buildMonthReport_(month);
  report.final = false;
  return { report };
}

function actionCloseMonthForAll_(data){
  const month = String(data.month||'');
  validMonth_(month);
  const archives = readAll_('Archives');
  if(archives.some(a => monthStr_(a.month) === month)) throw new Error('تم إقفال هذا الشهر سابقًا — افتح تقريره من الأرشيف');
  if(archives.some(a => monthStr_(a.month) > month)) throw new Error('يوجد شهر لاحق مُقفل بالفعل — لا يمكن إقفال شهر سابق له');

  const report = buildMonthReport_(month);
  if(!report.workers.length) throw new Error('لا يوجد عمال لتصفيتهم');
  if(report.pendingTotal) throw new Error('يوجد '+report.pendingTotal+' طلب حضور معلّق — اعتمده أو ارفضه قبل التصفية');
  const earlier = unsettledEarlierMonth_(month, report.workers.map(r => r.id));
  if(earlier) throw new Error('يوجد حضور غير مصفّى في '+monthLabel_(earlier)+' — أقفل ذلك الشهر أولًا حتى لا تُدمج مستحقاته في هذا الشهر');

  const today = riyadhTodayParts_().date;
  const now = Date.now();
  const untilTs = report.untilTs;
  const byId = {}; readAll_('Workers').forEach(w => byId[String(w.id)] = w);
  const settlements = [], carries = [], workerPatches = [];
  report.workers.forEach(r => {
    const w = byId[r.id];
    settlements.push({ id:newId_(), workerId:w.id, workerName:w.name, amount:r.paid, date:today, timestamp:now, month,
      earned:r.earned, advances:r.advances, carried:r.carried, days:r.approvedDays, ackAt:'' });
    const c = carryAdvance_(w, r.net, untilTs, report.monthLabel);
    if(c) carries.push(c);
    workerPatches.push({ row:w, patch:{ lastSettledAt: Math.max(Number(w.lastSettledAt)||0, untilTs) } });
  });

  // 1) الحالة المالية أولًا (مصدر الحقيقة)
  ensureHeader_('Settlements');
  appendMany_('Settlements', settlements);
  appendMany_('Advances', carries);
  updateRows_('Workers', workerPatches);
  report.workers.forEach(r => notifyWorker_(byId[r.id], 'تمت تصفية حسابك — ' + report.monthLabel,
    'أيام معتمدة ' + r.approvedDays + '، المدفوع ' + r.paid + (r.carried ? '، رصيد مرحّل ' + r.carried : ''), 'settle'));

  // 2) الأرشيف: التقرير الكامل مجزأ + صف ملخص
  report.final = true;
  report.closedAt = new Date().toISOString();
  const archiveId = newId_();
  report.archiveId = archiveId;
  report.signature = reportSignature_(report); // يُحسب قبل أي إضافة للتقرير (رابط الملف لا يدخل في التوقيع)
  const reportSheet = createReportFile_(report); // ملف Google Sheets مستقل؛ فشله لا يُفشل الإقفال
  report.reportSheet = reportSheet;
  // التقرير النهائي يحل محل التقرير المباشر لهذا الشهر
  try{ const live = ss_().getSheetByName(liveReportName_(month)); if(live) ss_().deleteSheet(live); }catch(e){}
  const json = JSON.stringify(report), CH = 40000, parts = [];
  for(let i=0, p=0; i<json.length; i+=CH, p++) parts.push({ id:newId_(), archiveId, part:p, chunk:json.slice(i, i+CH) });
  appendMany_('ArchiveData', parts);
  ensureHeader_('Archives');
  appendObj_('Archives', {
    id:archiveId, month, monthLabel:report.monthLabel, closedAt:report.closedAt,
    totalWorkers:report.totals.workers, totalNet:report.totals.totalNet, numDays:report.numDays,
    accountsJson:'', matrixJson:'', totalCost:report.totals.totalCost, totalAdvances:report.totals.totalAdvances,
    totalCarried:report.totals.totalCarried, reportSheet, signature:report.signature
  });
  protectArchiveSheets_();
  return { report, archiveId, totalNet: report.totals.totalNet };
}

/* =========================================================================
   حماية التقارير
   1) توقيع الخادم: HMAC-SHA256 لأرقام التقرير بمفتاح سري في Script Properties (لا يغادر الخادم أبدًا)،
      فلا يمكن حساب رمز صحيح لتقرير معدّل.
   2) التحقق: verifyReport (برمز QR المطبوع) يعيد حساب التوقيع من الأرشيف ويقارنه بالرمز المطبوع،
      ويقارن المدفوع لكل عامل بسجل التصفيات.
   3) أرشيف غير قابل للتعديل: أوراق الأرشيف والتصفيات محمية فلا يعدّلها إلا مالك الشيت (والخادم).
   ========================================================================= */
const utf8Bytes_ = s => { const b = unescape(encodeURIComponent(String(s))); const out = new Array(b.length); for(let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
function reportSecret_(){
  const props = props_();
  let k = props.getProperty('REPORT_SECRET');
  if(!k){ props.setProperty('REPORT_SECRET', Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()); k = props.getProperty('REPORT_SECRET'); }
  return k;
}
// الصيغة الثابتة لكل ما يظهر من أرقام في التقرير — أي تغيير فيها يغيّر التوقيع
function reportCanonical_(r){
  const t = r.totals || {}, n = v => money_(v);
  return JSON.stringify({ v:1, id:String(r.archiveId || ''), m:String(r.month), c:String(r.closedAt || ''),
    t:[t.workers, t.approvedDays, t.totalCost, t.totalEarned, t.totalAdvances, t.totalNet, t.totalCarried].map(n),
    w:(r.workers || []).map(w => [String(w.id), String(w.name), String(w.profession || ''), n(w.wage), n(w.approvedDays), n(w.monthEarned),
      n(w.earned), n(w.advances), n(w.net), n(w.paid), n(w.carried), String(w.days || '')]),
    a:(r.advances || []).map(a => [String(a.workerId), String(a.date), n(a.amount), String(a.note || '')]),
    p:(r.professions || []).map(p => [String(p.profession), n(p.workers), n(p.days), n(p.cost)]) });
}
function reportSignature_(r){
  const mac = hmac_(utf8Bytes_(reportSecret_()), utf8Bytes_(reportCanonical_(r)));
  const hex = mac.map(b => (b < 16 ? '0' : '') + b.toString(16)).join('').toUpperCase();
  return hex.slice(0, 20).match(/.{4}/g).join('-'); // 80 بت: تخمينه مستحيل عمليًا
}
const sigKey_ = s => String(s || '').toUpperCase().replace(/[^0-9A-F]/g, '');

// أوراق الأرشيف والتصفيات: لا يعدّلها إلا المالك (الخادم يعمل بصلاحيته). فشل الحماية لا يُفشل الإقفال.
function protectArchiveSheets_(){
  ['Archives', 'ArchiveData', 'Settlements'].forEach(key => {
    try{
      const sh = sheet_(key);
      if(sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
      const p = sh.protect().setDescription('أرشيف التقارير — محمي من التعديل (تطبيق UniGuard)');
      p.removeEditors(p.getEditors());
      if(p.canDomainEdit()) p.setDomainEdit(false);
    }catch(e){}
  });
}

// تقرير الأرشيف كما حُفظ عند الإقفال (بلا أي تعديل)
function archivedReport_(a){
  const parts = readAll_('ArchiveData').filter(p => String(p.archiveId) === String(a.id))
    .sort((x,y) => Number(x.part) - Number(y.part));
  const report = parts.length ? JSON.parse(parts.map(p => String(p.chunk)).join('')) : legacyArchiveReport_(a);
  report.final = true;
  report.archiveId = String(a.id);
  return report;
}

// تحقق عام (بلا رمز إدارة): يلزمه رقم الأرشيف + رمز التوقيع المطبوع معًا، فلا يمكن استعراض تقارير أخرى
function actionVerifyReport_(data){
  const id = String(data.id || '').trim(), sig = sigKey_(data.sig);
  const cache = cache_(), rk = 'vr_' + id.slice(0, 40);
  const tries = Number(cache.get(rk)) || 0;
  if(tries >= 30) throw new Error('محاولات كثيرة — حاول بعد ساعة');
  if(!id || sig.length !== 20) return { valid:false, reason:'رابط التحقق غير مكتمل — امسح رمز QR من التقرير مرة أخرى' };
  // يقبل رقم الأرشيف الكامل (من رمز QR) أو رقم التقرير المطبوع RPT-YYYYMM-XXXXXX (إدخال يدوي)
  const no = id.toUpperCase().match(/^RPT-(\d{4})(\d{2})-([0-9A-F]{6})$/);
  const a = readAll_('Archives').find(x => no
    ? monthStr_(x.month) === no[1] + '-' + no[2] && String(x.id).slice(0, 6).toUpperCase() === no[3] && sigKey_(x.signature) === sig
    : String(x.id) === id);
  const fail = reason => { cache.put(rk, String(tries + 1), 3600); return { valid:false, reason }; };
  if(!a){
    const sameNo = no && readAll_('Archives').some(x => monthStr_(x.month) === no[1] + '-' + no[2] && String(x.id).slice(0, 6).toUpperCase() === no[3]);
    return fail(sameNo ? 'رمز التحقق لا يطابق التقرير الأصلي — هذه النسخة معدّلة أو غير صحيحة' : 'لا يوجد تقرير بهذا الرقم في أرشيف الشركة');
  }
  if(!a.signature) return fail('هذا التقرير لم يُوقَّع بعد — افتحه من لوحة الإدارة ليُوقَّع');
  if(sigKey_(a.signature) !== sig) return fail('رمز التحقق لا يطابق التقرير الأصلي — هذه النسخة معدّلة أو غير صحيحة');
  const r = archivedReport_(a);
  if(sigKey_(reportSignature_(r)) !== sig) return { valid:false, tampered:true, reason:'بيانات الأرشيف في الشيت عُدّلت بعد الإقفال — لا يُعتمد هذا التقرير' };
  // مقارنة المدفوع لكل عامل بسجل التصفيات (مصدر الحقيقة المالي)
  let settlementsOk = null;
  if(!r.legacy){
    const sets = readAll_('Settlements').filter(s => monthStr_(s.month) === r.month);
    if(sets.length) settlementsOk = r.workers.every(w => sets.some(s => String(s.workerId) === String(w.id) && money_(s.amount) === money_(w.paid)));
  }
  return { valid:true, settlementsOk, report:{
    reportNo:'RPT-' + r.month.replace('-', '') + '-' + String(r.archiveId).slice(0, 6).toUpperCase(),
    month:r.month, monthLabel:r.monthLabel, closedAt:r.closedAt, signature:a.signature, signedLater:!!r.signedLater || !r.signature,
    totals:r.totals, advancesCount:(r.advances || []).length,
    workers:r.workers.map(w => ({ name:w.name, profession:w.profession, approvedDays:w.approvedDays, advances:w.advances, paid:w.paid, carried:w.carried }))
  } };
}

// أقدم شهر سابق لـ month فيه حضور معتمد لم تشمله أي تصفية بعد (أو '' إن لم يوجد)
function unsettledEarlierMonth_(month, workerIds){
  const since = {};
  readAll_('Workers').forEach(w => since[String(w.id)] = Number(w.lastSettledAt)||0);
  const ids = {}; workerIds.forEach(id => ids[String(id)] = 1);
  let earliest = '';
  readAll_('Log').forEach(r => {
    const id = String(r.workerId), m = dateStr_(r.date).slice(0, 7);
    if(!ids[id] || r.status !== 'approved' || m >= month || Number(r.timestamp) <= since[id]) return;
    if(!earliest || m < earliest) earliest = m;
  });
  return earliest;
}

function actionGetArchive_(data){
  const a = readAll_('Archives').find(x => String(x.id) === String(data.id));
  if(!a) throw new Error('الأرشيف غير موجود');
  const report = archivedReport_(a);
  if(a.signature){ report.signature = String(a.signature); return { report }; }
  // أرشيف أُقفل قبل ميزة التوقيع: يُوقَّع مرة واحدة الآن كما هو محفوظ، ويُذكر ذلك في صفحة التحقق
  report.signature = reportSignature_(report);
  withLock_(()=>{
    const row = readAll_('Archives').find(x => String(x.id) === String(a.id));
    if(row && !row.signature){ ensureHeader_('Archives'); updateRows_('Archives', [{ row, patch:{ signature:report.signature } }]); commitDataVersion_(); }
    else if(row) report.signature = String(row.signature);
  });
  protectArchiveSheets_();
  return { report };
}

// تحويل أرشيف النسخة القديمة (accountsJson/matrixJson) إلى شكل التقرير الجديد
function legacyArchiveReport_(a){
  let accounts=[], matrix=[];
  try{ accounts = JSON.parse(a.accountsJson||'[]'); }catch(e){}
  try{ matrix = JSON.parse(a.matrixJson||'[]'); }catch(e){}
  const month = monthStr_(a.month), numDays = Number(a.numDays)||daysInMonth_(month);
  const mById = {}; matrix.forEach(m => mById[String(m.workerId)] = m);
  const prof = {};
  const rows = accounts.map(x => {
    const m = mById[String(x.id)] || { days:{}, approvedDays:0 };
    let days = ''; for(let d=1; d<=numDays; d++) days += DAY_CODE[m.days && m.days[d]] || '-';
    const monthEarned = money_((m.approvedDays||0) * (Number(x.wage)||0));
    if(m.approvedDays){ const p = prof[x.profession] || (prof[x.profession] = { profession:x.profession, workers:0, days:0, cost:0 });
      p.workers++; p.days += m.approvedDays; p.cost = money_(p.cost + monthEarned); }
    const net = Number(x.net)||0;
    return { id:String(x.id), name:x.name, profession:x.profession, wage:Number(x.wage)||0, status:'active', days,
      approvedDays:m.approvedDays||0, monthEarned, earned:Number(x.earned)||0, advances:Number(x.advances)||0, net,
      paid:net, carried:0 };
  });
  const professions = Object.keys(prof).map(k => prof[k]);
  const sum = (arr, f) => money_(arr.reduce((s,x) => s + (Number(x[f])||0), 0));
  return { month, monthLabel:a.monthLabel, numDays, closedAt:isoStr_(a.closedAt), final:true, legacy:true,
    workers:rows, advances:[], professions,
    totals:{ workers:rows.length, approvedDays:rows.reduce((s,r)=>s+r.approvedDays,0), totalCost:sum(professions,'cost'),
      totalEarned:sum(rows,'earned'), totalAdvances:sum(rows,'advances'), totalNet:Number(a.totalNet)||0, totalCarried:0, totalAdvanceRows:0 } };
}

// يضيف عناوين الأعمدة الجديدة لورقة قديمة (مثل الأرشيف بعد إضافة أعمدة التكلفة)
function ensureHeader_(key){
  const sh = sheet_(key), labels = SHEETS[key].labels;
  const cur = sh.getRange(1, 1, 1, labels.length).getValues()[0];
  if(cur.some((v,i) => String(v) !== labels[i])) sh.getRange(1, 1, 1, labels.length).setValues([labels]);
}

/* ---------------------------- تقرير الشهر كجداول Google Sheets ---------------------------- */
const COMPANY_NAME = 'الحماية العالمية';

// محتوى التقرير كجداول: {title, head, rows, total}
function reportBlocks_(r){
  const SYM = { A:'✓', P:'⏳', R:'✗', '-':'' };
  const t = r.totals, monthSum = money_(r.workers.reduce((s,w) => s + (Number(w.monthEarned)||0), 0));
  const mxHead = ['العامل','المهنة']; for(let d = 1; d <= r.numDays; d++) mxHead.push(d); mxHead.push('أيام','المستحق');
  return {
    summary: { title:'الملخص العام', head:['البند','القيمة'], rows:[
      ['التكلفة التشغيلية الإجمالية', t.totalCost], ['عدد العمال', t.workers], ['أيام العمل المعتمدة', t.approvedDays],
      ['إجمالي السلف', t.totalAdvances], ['الصافي المدفوع', t.totalNet], ['رصيد سالب مرحّل للشهر التالي', t.totalCarried] ] },
    prof: { title:'التكلفة التشغيلية حسب المهنة', head:['المهنة','عدد العمال','أيام معتمدة','التكلفة التشغيلية'],
      rows: r.professions.map(p => [p.profession, p.workers, p.days, p.cost]),
      total: ['الإجمالي', r.professions.reduce((s,p) => s + p.workers, 0), t.approvedDays, t.totalCost] },
    matrix: { title:'كشف الدوام الكامل (✓ معتمد · ✗ مرفوض · ⏳ معلّق · فارغ غياب)', head: mxHead, symbols: true,
      rows: r.workers.map(w => { const row = [w.name, w.profession]; for(let d = 0; d < r.numDays; d++) row.push(SYM[w.days[d]] || ''); return row.concat([w.approvedDays, w.monthEarned]); }),
      total: ['الإجمالي', ''].concat(new Array(r.numDays).fill(''), [t.approvedDays, monthSum]) },
    acc: { title:'ملخص الحسابات لكل عامل', head:['#','العامل','المهنة','اليومية','أيام الشهر','مستحق الشهر','السلف','الصافي','المدفوع','المرحّل'],
      rows: r.workers.map((w, i) => [i + 1, w.name + (w.status === 'deleted' ? ' (ملغى)' : ''), w.profession, w.wage, w.approvedDays, w.monthEarned, w.advances, w.net, w.paid, w.carried || '-']),
      total: ['', 'الإجمالي', '', '', t.approvedDays, monthSum, t.totalAdvances, money_(t.totalEarned - t.totalAdvances), t.totalNet, t.totalCarried] },
    adv: { title:'كشف السلف', head:['#','التاريخ','العامل','المهنة','المبلغ','ملاحظة'],
      rows: r.advances.map((a, i) => [i + 1, a.date, a.name, a.profession, a.amount, a.note]),
      total: ['', '', 'إجمالي السلف', '', t.totalAdvanceRows, ''] }
  };
}

const colLetter_ = n => { let s = ''; while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
// يكتب عدة جداول في ورقة واحدة بتنسيق موحد: كل الخلايا في المنتصف، حدود، تظليل متناوب، إجمالي مميز
function renderBlocks_(sh, banner, blocks, widths){
  const out = [], tables = [], titles = [];
  banner.forEach(b => out.push(b));
  blocks.forEach(b => {
    out.push([]); out.push([b.title]); titles.push(out.length);
    const start = out.length + 1;
    out.push(b.head);
    (b.rows.length ? b.rows : [['لا توجد بيانات']]).forEach(row => out.push(row));
    if(b.total && b.rows.length) out.push(b.total);
    tables.push({ start, end: out.length, cols: b.head.length, hasTotal: !!(b.total && b.rows.length), symbols: !!b.symbols });
  });
  const width = Math.max(1, Math.max.apply(null, out.map(r => r.length)));
  const values = out.map(row => { const x = row.slice(); while(x.length < width) x.push(''); return x.map(v => v == null ? '' : v); });
  const formats = values.map(row => row.map(v => typeof v === 'number' ? (Number.isInteger(v) ? '#,##0' : '#,##0.00') : '@'));
  const all = sh.getRange(1, 1, values.length, width);
  all.setNumberFormats(formats); all.setValues(values);
  all.setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
  const L = colLetter_, area = (r1, r2, c) => 'A' + r1 + ':' + L(c) + r2;
  sh.getRangeList(banner.map((_, i) => area(i + 1, i + 1, width))).setBackground('#14213b').setFontColor('#ffffff').setFontWeight('bold');
  sh.getRange(1, 1, 1, width).setFontSize(14);
  sh.getRangeList(titles.map(i => 'A' + i)).setFontWeight('bold').setFontSize(12).setFontColor('#14213b').setHorizontalAlignment('right');
  sh.getRangeList(tables.map(t => area(t.start, t.start, t.cols))).setBackground('#14213b').setFontColor('#ffffff').setFontWeight('bold');
  const zebra = []; tables.forEach(t => { for(let i = t.start + 2; i <= t.end - (t.hasTotal ? 1 : 0); i += 2) zebra.push(area(i, i, t.cols)); });
  if(zebra.length) sh.getRangeList(zebra).setBackground('#f5f7fb');
  const totals = tables.filter(t => t.hasTotal).map(t => area(t.end, t.end, t.cols));
  if(totals.length) sh.getRangeList(totals).setBackground('#fbeeda').setFontWeight('bold');
  sh.getRangeList(tables.map(t => area(t.start, t.end, t.cols))).setBorder(true, true, true, true, true, true, '#d5dbe6', SpreadsheetApp.BorderStyle.SOLID);
  // كشف الدوام: خط فاصل واضح بين كل عامل، وفاصل بين الاسم/المهنة والأيام وبين الأيام والمجاميع
  tables.filter(t => t.symbols).forEach(t => {
    const med = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;
    sh.getRange(t.start, 1, t.end - t.start + 1, t.cols).setBorder(true, true, true, true, null, true, '#8f9bb5', med);
    sh.getRange(t.start, 2, t.end - t.start + 1, 1).setBorder(null, true, null, null, null, null, '#8f9bb5', med);
    sh.getRange(t.start, t.cols - 1, t.end - t.start + 1, 1).setBorder(null, null, null, true, null, null, '#8f9bb5', med);
    sh.getRange(t.start + 1, t.cols - 1, t.end - t.start, 2).setBackground('#f1f4fa').setFontWeight('bold');
  });
  // ✓ أخضر، ✗ أحمر، ⏳ برتقالي في كشف الدوام
  const sym = tables.filter(t => t.symbols).map(t => sh.getRange(t.start + 1, 3, t.end - t.start, Math.max(1, t.cols - 4)));
  if(sym.length) sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('✓').setFontColor('#1f7a56').setBackground('#e6f4ec').setRanges(sym).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('✗').setFontColor('#bd4438').setBackground('#fdecea').setRanges(sym).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('⏳').setFontColor('#b9761f').setBackground('#fff4e0').setRanges(sym).build()
  ]);
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setRowHeights(1, values.length, 26);
}
function reportBanner_(r, reportNo){
  const when = r.final ? 'تاريخ الإقفال: ' + Utilities.formatDate(new Date(r.closedAt), TZ, 'yyyy-MM-dd HH:mm')
                       : 'آخر تحديث: ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') + ' (مباشر، غير نهائي)';
  return [[COMPANY_NAME + ' — تقرير الدوام والرواتب الشهري — ' + r.monthLabel],
          ['الفترة: ' + r.month + '-01 إلى ' + r.month + '-' + String(r.numDays).padStart(2, '0') + '   ·   ' + when + (reportNo ? '   ·   رقم التقرير: ' + reportNo : '') + (r.signature ? '   ·   توقيع الخادم: ' + r.signature : '')]];
}

/* التقرير النهائي للشهر المُقفل: ملف Google Sheets مستقل (لا ورقة داخل ملف العمل)، باسم الشهر،
   في نفس مجلد ملف العمل، بأربع أوراق: الملخص، كشف الدوام، الحسابات، السلف */
function createReportFile_(r){
  try{
    const file = SpreadsheetApp.create('تقرير الدوام — ' + r.monthLabel + ' (' + r.month + ')');
    const reportNo = 'RPT-' + r.month.replace('-', '') + '-' + String(r.archiveId || '').slice(0, 6).toUpperCase();
    const B = reportBlocks_(r), banner = reportBanner_(r, reportNo);
    const days = []; for(let d = 0; d < r.numDays; d++) days.push(32);
    const tabs = [
      ['الملخص',     [B.summary, B.prof], [230, 120, 110, 140]],
      ['كشف الدوام', [B.matrix],          [150, 110].concat(days, [55, 90])],
      ['الحسابات',   [B.acc],             [40, 160, 110, 80, 80, 100, 90, 100, 100, 90]],
      ['السلف',      [B.adv],             [40, 100, 160, 110, 90, 280]]
    ];
    tabs.forEach((t, i) => {
      const sh = i === 0 ? file.getSheets()[0].setName(t[0]) : file.insertSheet(t[0]);
      sh.setRightToLeft(true);
      renderBlocks_(sh, banner, t[1], t[2]);
    });
    try{ // في نفس مجلد ملف العمل (وإلا يبقى في "ملفاتي" على Drive)
      const parents = DriveApp.getFileById(ss_().getId()).getParents();
      if(parents.hasNext()) DriveApp.getFileById(file.getId()).moveTo(parents.next());
    }catch(e){}
    return file.getUrl();
  }catch(e){
    console.error('تعذر إنشاء ملف التقرير', e);
    return '';
  }
}

/* التقرير المباشر (غير النهائي) يبقى ورقة داخل ملف العمل ويتحدّث تلقائيًا */
function writeReportSheet_(r, name){
  try{
    const ss = ss_();
    name = name || 'تقرير ' + r.month;
    // الكتابة فوق نفس الورقة (لا حذف وإنشاء) حتى لا تُغلق على من يفتحها أثناء التحديث التلقائي
    let sh = ss.getSheetByName(name);
    if(sh){ sh.clear(); sh.clearConditionalFormatRules(); } else sh = ss.insertSheet(name);
    sh.setRightToLeft(true);
    const B = reportBlocks_(r), widths = [170, 110];
    for(let i = 0; i < r.numDays + 2; i++) widths.push(70);
    renderBlocks_(sh, reportBanner_(r, ''), [B.summary, B.matrix, B.acc, B.adv, B.prof], widths);
    return name;
  }catch(e){
    console.error('تعذر إنشاء ورقة التقرير', e);
    return '';
  }
}

function actionApproveDevice_(data){
  const dev = readAll_('Devices').find(d=>String(d.id)===String(data.deviceLogId));
  if(!dev) throw new Error('الطلب غير موجود');
  if(dev.status !== 'pending') return {}; // سبق البتّ فيه (نقرة مزدوجة)
  const now = new Date().toISOString();
  // جهاز واحد معتمد فقط لكل رقم في كل لحظة، وأي طلبات معلّقة أخرى لنفس الرقم (ومنها المكررة القديمة)
  // تُغلق معه — وإلا تبقى ظاهرة للإدارة، واعتماد أحدها لاحقًا يُسقط الجهاز الذي اعتُمد الآن
  const others = readAll_('Devices').filter(d=>samePhone_(d.phone, dev.phone) && (d.status==='approved' || d.status==='pending') && d.id!==dev.id);
  updateRows_('Devices', others.map(row => ({ row, patch:{ status:'replaced', decidedAt:now } })));
  updateById_('Devices', dev.id, { status:'approved', decidedAt:now });
  releaseDeviceFromOthers_(dev, now); // جهاز كان مرتبطًا بعامل آخر: يُنقل إلى هذا الحساب
  appendObj_('DeviceLogs', { id:newId_(), phone:dev.phone, workerName:dev.workerName, deviceId:dev.deviceId, userAgent:dev.userAgent, event:'اعتمدت الإدارة الجهاز الجديد', timestamp:Date.now() });
  notifyWorker_(dev, 'تم اعتماد جهازك ✓', 'وافقت الإدارة على جهازك الجديد، يمكنك الآن استخدام حسابك', 'device');
  return {};
}
function actionRejectDevice_(data){
  const dev = readAll_('Devices').find(d=>String(d.id)===String(data.deviceLogId));
  if(!dev) throw new Error('الطلب غير موجود');
  if(dev.status !== 'pending') return {};
  // الرفض يشمل الطلبات المكررة المعلّقة لنفس (الرقم + الجهاز)
  const dups = readAll_('Devices').filter(d=>d.status==='pending' && samePhone_(d.phone, dev.phone) && String(d.deviceId)===String(dev.deviceId));
  updateRows_('Devices', dups.map(row => ({ row, patch:{ status:'rejected', decidedAt:new Date().toISOString() } })));
  appendObj_('DeviceLogs', { id:newId_(), phone:dev.phone, workerName:dev.workerName, deviceId:dev.deviceId, userAgent:dev.userAgent, event:'رفضت الإدارة الجهاز الجديد', timestamp:Date.now() });
  notifyWorker_(dev, 'رُفض طلب الجهاز', 'رفضت الإدارة الدخول لحسابك من الجهاز الجديد', 'device');
  return {};
}

/* ---------------------------- إشعارات الهاتف (Web Push) ----------------------------
 * تصل الإشعارات إلى شاشة الهاتف حتى والتطبيق مغلق، بلا Firebase أو أي حساب خارجي، ولا تُحفظ في الشيت:
 *  1) نص الإشعار يُوضع في ذاكرة الخادم المؤقتة (CacheService) لمدة 6 ساعات فقط ثم يُمحى تلقائيًا.
 *  2) يُرسل "تنبيه فارغ" موقّع (VAPID/ES256) إلى خدمة الإشعارات في الهاتف (Google أو Apple).
 *  3) الهاتف يستيقظ (sw.js)، يجلب النص من الذاكرة المؤقتة عبر getNotifications ويعرضه.
 * التنبيه فارغ لأن تشفير المحتوى داخل التنبيه غير متاح في Apps Script، فيُجلب النص بطلب مستقل.
 * اشتراكات الهواتف ومفاتيح VAPID تُحفظ في Script Properties (إعدادات السكربت المخفية)، لا في الشيت. */
const NOTIF_TTL = CACHE_TTL;
const NOTIF_KEEP = 10;     // آخر 10 إشعارات لكل مستلم
const MAX_SUBS = 5;        // حد أقصى 5 أجهزة لكل مستلم
let _outbox = [], _pushOwners = {};
function notify_(owner, title, body, tag){
  _outbox.push({ id:newId_(), owner, title:String(title).slice(0,80), body:String(body).slice(0,240), tag:tag||'', timestamp:Date.now() });
}
const workerOwner_ = phone => 'w:' + phoneKey_(phone);
function notifyWorker_(w, title, body, tag){ if(w && w.phone) notify_(workerOwner_(w.phone), title, body, tag); }
function notifyAdmin_(title, body, tag){ notify_('admin', title, body, tag); }
// يُستدعى داخل القفل: يضيف النصوص إلى ذاكرة كل مستلم (لا كتابة في الشيت)
function commitNotifications_(){
  if(!_outbox.length) return;
  const items = _outbox; _outbox = [];
  const cache = cache_(), byOwner = {};
  items.forEach(n => (byOwner[n.owner] = byOwner[n.owner] || []).push(n));
  Object.keys(byOwner).forEach(owner => {
    let list = [];
    try{ list = JSON.parse(cache.get('notif_' + owner) || '[]'); }catch(e){}
    list = list.concat(byOwner[owner]).slice(-NOTIF_KEEP);
    try{ cache.put('notif_' + owner, JSON.stringify(list), NOTIF_TTL); }catch(e){}
    _pushOwners[owner] = 1;
  });
}
// اشتراكات الهواتف: Script Properties، مفتاح لكل مستلم يحوي قائمة عناوين الاشتراك
function readSubs_(owner){
  try{ return JSON.parse(props_().getProperty('push_' + owner) || '[]'); }catch(e){ return []; }
}
function writeSubs_(owner, list){
  const props = props_();
  if(list.length) props.setProperty('push_' + owner, JSON.stringify(list)); else props.deleteProperty('push_' + owner);
}
function removeEndpoint_(endpoint){
  const all = props_().getProperties();
  Object.keys(all).filter(k => k.indexOf('push_') === 0).forEach(k => {
    let list = []; try{ list = JSON.parse(all[k]); }catch(e){}
    const keep = list.filter(s => s.endpoint !== endpoint);
    if(keep.length !== list.length) writeSubs_(k.slice(5), keep);
  });
}
function sendPendingPushes_(){
  const owners = _pushOwners; _pushOwners = {};
  if(!Object.keys(owners).length) return;
  try{
    const subs = [];
    Object.keys(owners).forEach(o => readSubs_(o).forEach(s => { if(/^https:\/\//.test(s.endpoint)) subs.push(s); }));
    if(!subs.length) return;
    const reqs = subs.map(s => ({ url:s.endpoint, method:'post', payload:'', muteHttpExceptions:true,
      headers:{ TTL:String(NOTIF_TTL), Urgency:'high', Authorization: vapidAuthHeader_(s.endpoint) } }));
    const res = UrlFetchApp.fetchAll(reqs);
    // اشتراكات انتهت (حُذف التطبيق أو أُلغي الإذن): تُحذف
    const gone = []; res.forEach((r, i) => { const c = r.getResponseCode(); if(c === 404 || c === 410) gone.push(subs[i].endpoint); });
    if(gone.length) withLock_(() => gone.forEach(removeEndpoint_));
  }catch(e){ console.error('تعذر إرسال الإشعارات', e); }
}

// ---- منحنى P-256 وتوقيع ES256 (RFC 6979: k حتمي، فلا حاجة لمولّد أرقام عشوائية آمن) ----
// محلل Apps Script لا يقبل صيغة BigInt الحرفية (مثل 0n) فيرفض الملف كله: ثوابت عبر BigInt() بدلًا منها
const N0 = BigInt(0), N1 = BigInt(1), N2 = BigInt(2), N3 = BigInt(3), N4 = BigInt(4), N8 = BigInt(8), N255 = BigInt(255);
const P256 = (function(){
  const p = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const G = [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
             BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')];
  const mod = (a, m) => { const r = a % m; return r >= N0 ? r : r + m; };
  const pow = (b, e, m) => { let r = N1; b = mod(b, m); while(e > N0){ if(e & N1) r = r * b % m; b = b * b % m; e >>= N1; } return r; };
  const inv = (a, m) => pow(a, m - N2, m);
  function dbl(P){ // إحداثيات جاكوبي، a = -3
    const X = P[0], Y = P[1], Z = P[2];
    if(Z === N0 || Y === N0) return [N0, N1, N0];
    const YY = Y * Y % p, S = N4 * X * YY % p, ZZ = Z * Z % p, M = mod(N3 * (X - ZZ) * (X + ZZ), p);
    const X3 = mod(M * M - N2 * S, p);
    return [X3, mod(M * (S - X3) - N8 * YY * YY, p), N2 * Y * Z % p];
  }
  function add(P, Q){
    if(P[2] === N0) return Q; if(Q[2] === N0) return P;
    const Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
    const U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p, S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
    if(U1 === U2) return S1 === S2 ? dbl(P) : [N0, N1, N0];
    const H = mod(U2 - U1, p), R = mod(S2 - S1, p), HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
    const X3 = mod(R * R - HHH - N2 * V, p);
    return [X3, mod(R * (V - X3) - S1 * HHH, p), P[2] * Q[2] % p * H % p];
  }
  function mulJ(P, k){
    let R = [N0, N1, N0];
    while(k > N0){ if(k & N1) R = add(R, P); P = dbl(P); k >>= N1; }
    return R;
  }
  function mulG(k){
    const R = mulJ([G[0], G[1], N1], k);
    const zi = inv(R[2], p), zi2 = zi * zi % p;
    return [R[0] * zi2 % p, R[1] * zi2 % p * zi % p];
  }
  // للتحقق من توقيع قفل الهاتف: x للنقطة a·G + b·Q (أو null إن كانت اللانهاية)
  function mulAdd(a, b, qx, qy){
    const R = add(mulJ([G[0], G[1], N1], a), mulJ([qx, qy, N1], b));
    if(R[2] === N0) return null;
    const zi = inv(R[2], p);
    return R[0] * zi % p * zi % p;
  }
  const B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  const onCurve = (x, y) => x < p && y < p && mod(y * y - (x * x % p * x - N3 * x + B), p) === N0;
  return { n, mod, inv, pow, mulG, mulAdd, onCurve };
})();
const u8_ = bytes => bytes.map(b => b & 255);                // بايتات Apps Script موقّعة (-128..127)
const s8_ = bytes => bytes.map(b => (b & 255) > 127 ? (b & 255) - 256 : (b & 255));
const bigToBytes_ = (x, len) => { const out = []; for(let i = 0; i < len; i++){ out.unshift(Number(x & N255)); x >>= N8; } return out; };
const bytesToBig_ = bytes => bytes.reduce((a, b) => (a << N8) + BigInt(b & 255), N0);
const b64url_ = bytes => Utilities.base64EncodeWebSafe(s8_(bytes)).replace(/=+$/, '');
const hmac_ = (key, data) => u8_(Utilities.computeHmacSha256Signature(s8_(data), s8_(key)));
function es256Sign_(message, d){
  const n = P256.n;
  const h = u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, message, Utilities.Charset.UTF_8));
  const z = bytesToBig_(h) % n;
  const x = bigToBytes_(d, 32), h1 = bigToBytes_(z, 32);
  let V = new Array(32).fill(1), K = new Array(32).fill(0);
  K = hmac_(K, V.concat([0], x, h1)); V = hmac_(K, V);
  K = hmac_(K, V.concat([1], x, h1)); V = hmac_(K, V);
  for(;;){
    V = hmac_(K, V);
    const k = bytesToBig_(V);
    if(k > N0 && k < n){
      const r = P256.mulG(k)[0] % n;
      const s = P256.mod(P256.inv(k, n) * (z + r * d), n);
      if(r !== N0 && s !== N0) return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
    }
    K = hmac_(K, V.concat([0])); V = hmac_(K, V);
  }
}
function vapidKeys_(){
  const props = props_();
  let priv = props.getProperty('VAPID_PRIVATE'), pub = props.getProperty('VAPID_PUBLIC');
  if(priv && pub) return { d: BigInt('0x' + priv), pub };
  // مفتاح جديد: 256 بت من عدة UUID عشوائية (مولّد آمن في Google) عبر SHA-256
  let seed = ''; for(let i = 0; i < 8; i++) seed += Utilities.getUuid();
  const d = bytesToBig_(u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed + Date.now(), Utilities.Charset.UTF_8))) % (P256.n - N1) + N1;
  const Q = P256.mulG(d);
  pub = b64url_([4].concat(bigToBytes_(Q[0], 32), bigToBytes_(Q[1], 32)));
  priv = d.toString(16).padStart(64, '0');
  props.setProperty('VAPID_PRIVATE', priv); props.setProperty('VAPID_PUBLIC', pub);
  return { d, pub };
}
function vapidAuthHeader_(endpoint){
  const aud = endpoint.match(/^https:\/\/[^/]+/)[0];
  const cache = cache_(), ck = 'vapid_' + aud;
  const hit = cache.get(ck); if(hit) return hit; // التوقيع صالح 12 ساعة: يُعاد استخدامه
  const keys = vapidKeys_();
  let sub = 'mailto:hudurak@example.com';
  try{ const u = ScriptApp.getService().getUrl(); if(u) sub = u; }catch(e){}
  const enc = o => b64url_(u8_(Utilities.newBlob(JSON.stringify(o)).getBytes()));
  const input = enc({ typ:'JWT', alg:'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
  const header = 'vapid t=' + input + '.' + b64url_(es256Sign_(input, keys.d)) + ', k=' + keys.pub;
  cache.put(ck, header, 11 * 3600);
  return header;
}

// ---- إجراءات الإشعارات ----
function pushOwnerOf_(data){
  if(data.token){ requireAdmin_(data.token); return 'admin'; }
  return workerOwner_(requireWorkerDevice_(data).w.phone); // والتطبيق مغلق: الجهاز المعتمد يكفي لجلب نصوص الإشعارات
}
function actionGetPushKey_(){ return { key: vapidKeys_().pub }; }
function actionSavePush_(data){
  const endpoint = String(data.endpoint||'');
  if(!/^https:\/\/[^\s]{10,900}$/.test(endpoint)) throw new Error('اشتراك غير صالح');
  const owner = pushOwnerOf_(data);
  removeEndpoint_(endpoint); // الجهاز نفسه قد يكون مسجلًا باسم مستلم آخر (خروج ثم دخول بحساب آخر)
  const mine = readSubs_(owner).concat([{ endpoint, createdAt: Date.now() }]).slice(-MAX_SUBS); // الأقدم يُحذف
  writeSubs_(owner, mine);
  return {};
}
function actionRemovePush_(data){
  const endpoint = String(data.endpoint||'');
  if(endpoint) removeEndpoint_(endpoint);
  return {};
}
// يستدعيها الهاتف (sw.js) عند وصول التنبيه: الإشعارات الأحدث من آخر ما عرضه (من الذاكرة المؤقتة)
function actionGetNotifications_(data){
  const owner = pushOwnerOf_(data), since = Number(data.since) || 0;
  let list = [];
  try{ list = JSON.parse(cache_().get('notif_' + owner) || '[]'); }catch(e){}
  const items = list.filter(n => Number(n.timestamp) > since)
    .map(n => ({ id:n.id, title:n.title, body:n.body, tag:n.tag, timestamp:n.timestamp }));
  return { items };
}
/* شغّلها مرة واحدة من المحرر: تمنح صلاحية الإرسال (UrlFetch) وتولّد مفاتيح الإشعارات */
function setupPush(){
  // أوراق الإشعارات من نسخة سابقة لم تعد مستخدمة: تُحذف
  ['اشتراكات الإشعارات', 'الإشعارات'].forEach(n => { const sh = ss_().getSheetByName(n); if(sh) ss_().deleteSheet(sh); });
  Logger.log('مفتاح الإشعارات العام: ' + vapidKeys_().pub);
  try{ UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions:true }); }catch(e){}
  Logger.log('تم تجهيز إشعارات الهاتف ✓ (لا يُحفظ أي إشعار في الشيت)');
}

/* ---------------------------- التقرير المباشر (يتحدّث تلقائيًا في الشيت) ---------------------------- */
function liveReportName_(month){ return 'تقرير ' + month + ' (مباشر)'; }
// الشهر قبل month بـ n شهر (yyyy-MM)
function monthsBack_(month, n){
  const t = Number(month.slice(0,4)) * 12 + Number(month.slice(5,7)) - 1 - n;
  return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2,'0');
}
// يعيد بناء ورقة "تقرير الشهر (مباشر)" للشهر الحالي (والسابق ما لم يُقفل بعد) إن تغيّرت البيانات
function refreshLiveReport_(force){
  const cache = cache_();
  if(!force && !cache.get('report_dirty')) return 'لا تغييرات';
  cache.remove('report_dirty'); // قبل البناء: أي تغيير أثناءه يُعيد العلامة فيُلتقط في الدورة التالية
  const month = riyadhTodayParts_().month, prev = monthsBack_(month, 1);
  const closed = {}; readAll_('Archives').forEach(a => closed[monthStr_(a.month)] = 1);
  const months = [month];
  if(!closed[prev] && readAll_('Log').some(r => dateStr_(r.date).indexOf(prev) === 0)) months.unshift(prev);
  const done = [];
  months.forEach(m => {
    if(closed[m]) return;
    const r = buildMonthReport_(m); r.final = false;
    if(writeReportSheet_(r, liveReportName_(m))) done.push(liveReportName_(m));
  });
  return done.join('، ');
}
// يستدعيه المشغّل الدوري كل 10 دقائق (لا يعمل شيئًا إن لم تتغير البيانات)
function refreshLiveReport(){ refreshLiveReport_(false); }
// من قائمة "UniGuard" داخل الشيت
function updateReportNow(){
  const done = refreshLiveReport_(true);
  try{ SpreadsheetApp.getActive().toast(done ? 'تم تحديث: ' + done : 'لا يوجد حضور لهذا الشهر بعد', 'UniGuard'); }catch(e){}
}
// تعديل يدوي داخل الشيت: يغيّر إصدار البيانات (العام وإصدار كل العمال) فيظهر التعديل في التطبيقات المفتوحة خلال ثوانٍ
function onEdit(){
  const v = Utilities.getUuid();
  try{ cache_().putAll({ data_ver: v, wv_epoch: v, report_dirty: '1' }, CACHE_TTL); }catch(e){}
  try{ cache_().remove(checkedInKey_(riyadhTodayParts_().date)); }catch(e){} // حضور حُذف يدويًا: تُبنى القائمة من جديد
}
function onOpen(){
  SpreadsheetApp.getUi().createMenu('UniGuard — الحماية العالمية').addItem('تحديث التقرير الشهري الآن', 'updateReportNow').addToUi();
}
/* شغّلها مرة واحدة من المحرر: تفعّل التحديث التلقائي للتقرير كل 30 دقيقة (كانت 10: إعادة بناء التقرير ثقيلة،
 * وكل تنفيذ يشغل مكانًا من حصة Google للتنفيذات المتزامنة ووقت المشغّلات اليومي). «تحديث التقرير الآن» فوري */
function setupAutoReport(){
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'refreshLiveReport').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshLiveReport').timeBased().everyMinutes(30).create();
  refreshLiveReport_(true);
  Logger.log('تم تفعيل التحديث التلقائي للتقرير كل 30 دقيقة');
}

/* فحص النشر: شغّلها من المحرر وافتح Execution log.
 * ملاحظة: عند التشغيل من المحرر يعيد Google رابط الاختبار (/dev) لا رابط النشر (/exec) — رقماهما مختلفان دائمًا،
 * لذا المقارنة الصحيحة تكون بقائمة Manage deployments (رقم Deployment ID) لا بهذا الرابط. */
function checkDeployment(){
  let url = '';
  try{ url = ScriptApp.getService().getUrl() || ''; }catch(e){}
  const workers = readAll_('Workers').filter(w => w.status !== 'deleted').length;
  Logger.log('إصدار الكود في المحرر: ' + SERVER_VERSION);
  Logger.log('ملف الشيت المرتبط: ' + ss_().getName() + ' — عدد العمال فيه: ' + workers);
  if(!url) Logger.log('⚠ لا يوجد نشر (Web app) لهذا المشروع — Deploy ← New deployment ← Web app');
  else if(/\/dev$/.test(url)) Logger.log('رابط الاختبار (/dev) لا يصلح للمقارنة. افتح Deploy ← Manage deployments وتأكد أن رقم Deployment ID للنشر هو نفسه الموجود في رابط التطبيق (WEB_APP_URL في app.html)');
  else Logger.log('رابط النشر: ' + url);
  Logger.log('بعد النشر افتح رابط /exec في المتصفح: يجب أن يظهر "version":"' + SERVER_VERSION + '"');
}

/* شغّلها مرة واحدة يدويًا من المحرر: تنشئ الأوراق وتضبط أعمدة النص */
function setupSheets(){
  Object.keys(SHEETS).forEach(key => { formatTextColumns_(sheet_(key), key); ensureHeader_(key); });
}

/* ترحيل البيانات القديمة — شغّلها مرة واحدة بعد نشر هذه النسخة:
 * 1) تضبط أعمدة النص  2) تحوّل التواريخ/الأوقات المخزنة كـ Date إلى نص
 * 3) تحذف طلبات الأجهزة المكررة (نفس الرقم + نفس الجهاز) مع إبقاء الأحدث
 * ملاحظة: الأرقام التي فقدت الصفر البادئ تبقى قابلة للمطابقة عبر phoneKey_، لكن
 * راجع ورقة "العمال" يدويًا لحذف الحسابات المكررة لنفس الرقم (احتفظ بالأقدم). */
function migrateData(){
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try{
    setupSheets();
    ['Log','Advances','Settlements','Archives'].forEach(key=>{
      const rows = readAll_(key);
      const patches = [];
      rows.forEach(r=>{
        const p = {};
        if(r.date instanceof Date) p.date = dateStr_(r.date);
        if(r.time instanceof Date) p.time = timeStr_(r.time);
        if(r.month instanceof Date) p.month = monthStr_(r.month);
        if(Object.keys(p).length) patches.push({ row:r, patch:p });
      });
      updateRows_(key, patches);
      Logger.log(key+': أُصلح '+patches.length+' صف');
    });
    const seen = {};
    const devs = readAll_('Devices');
    const dupIds = {};
    for(let i=devs.length-1; i>=0; i--){
      const d = devs[i], k = phoneKey_(d.phone)+'|'+d.deviceId;
      if(seen[k] && d.status !== 'approved') dupIds[d.id] = 1; else seen[k] = 1;
    }
    Logger.log('Devices: حُذف '+deleteWhere_('Devices', d => dupIds[d.id])+' طلب مكرر');
    const byPhone = {};
    readAll_('Workers').filter(w=>w.status!=='deleted').forEach(w=>{
      const k = phoneKey_(w.phone); (byPhone[k] = byPhone[k] || []).push(w.name+' ('+w.id+')');
    });
    Object.keys(byPhone).forEach(k=>{ if(byPhone[k].length>1) Logger.log('⚠ حسابات مكررة للرقم '+k+': '+byPhone[k].join(' ، ')); });
  } finally { commitDataVersion_(); lock.releaseLock(); }
}
