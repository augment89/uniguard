// يُحمَّل بعد config.js (IS_ADMIN_APP و UI_LOGO_SRC من هناك)
(function(){
  var SHORT_NAME = 'UniGuard';
  var FLAG = 'hudurak_install_seen';
  var deferredPrompt = null;
  var fabHiddenThisSession = false;

  var isStandalone = function(){
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  };
  var ua = navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  var isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  var isMobile = isIOS || /android|mobile/i.test(ua) || (window.matchMedia && matchMedia('(pointer:coarse)').matches);
  var seen = function(){ try{ return localStorage.getItem(FLAG) === '1'; }catch(e){ return false; } };
  var markSeen = function(){ try{ localStorage.setItem(FLAG,'1'); }catch(e){} };

  var banner = document.getElementById('installBanner');
  var fab = document.getElementById('installFab');

  /* ---- بوابة التثبيت: شاشة كاملة تطلب التثبيت قبل صفحة الدخول (هواتف فقط، من المتصفح) ----
     تختار الطريقة المناسبة لكل هاتف: زر تثبيت مباشر (أندرويد/Chrome)، خطوات Safari (آيفون)،
     أو "افتح في Chrome/Safari" إن كان الرابط مفتوحًا داخل واتساب/فيسبوك (لا يمكن التثبيت منها). */
  // صفحة الإدارة (admin.html): تطبيق مستقل بأيقونة logo-admin.png — يُثبَّت أولًا قبل استخدامه (الهاتف، والكمبيوتر إن كان متصفحه يدعم التثبيت)
  var adminPage = IS_ADMIN_APP;
  var APP_LABEL = adminPage ? 'UniGuard إدارة' : 'UniGuard';
  var INSTALLED = adminPage ? 'hudurak_installed_admin' : 'hudurak_installed';
  var isAndroid = /android/i.test(ua);
  var isPhone = isIOS || isAndroid || /mobile/i.test(ua);
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Snapchat|TikTok|musical_ly|; wv\)|GSA\//i.test(ua);
  var gate = document.getElementById('installGate'), gateOn = false, bypass = false;
  var SHARE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  function wasInstalled(){ try{ return localStorage.getItem(INSTALLED) === '1'; }catch(e){ return false; } }
  function setInstalled(v){ try{ if(v) localStorage.setItem(INSTALLED, '1'); else localStorage.removeItem(INSTALLED); }catch(e){} }
  // حدث «قابل للتثبيت» وصل قبل تحميل هذا الملف (يلتقطه سكربت رأس الصفحة)
  if(window.__bip){ deferredPrompt = window.__bip; setInstalled(false); }

  /* زر التثبيت المباشر يظهر فقط حين يرسل المتصفح حدث «قابل للتثبيت» (beforeinstallprompt). Chrome لا يرسله
     في أول زيارة إلا بعد أن يلمس المستخدم الصفحة مرة ويبقى عليها نحو 30 ثانية، ولا يرسله إطلاقًا إن كان
     التطبيق مثبّتًا. لذلك: زر «تثبيت التطبيق» فوري — لمسه يحقق شرط اللمس، ويعرض عدًّا حتى يجهز المتصفح ثم
     يصبح «تثبيت الآن». انتهى العد بلا حدث = التطبيق مثبّت غالبًا أو المتصفح لا يدعم التثبيت المباشر: خطوات القائمة ⋮ */
  var T0 = Date.now(), ENGAGE_MS = window.__IG_WAIT_MS || 32000; // (__IG_WAIT_MS للاختبارات فقط)
  var canPrompt = 'onbeforeinstallprompt' in window;
  var prep = '', prepTimer = null, installedNow = false; // prep: '' | 'wait' | 'fail'
  function gateMode(){
    if(inApp) return isIOS ? 'inapp-ios' : 'inapp-android';
    if(!window.isSecureContext) return 'insecure';
    if(deferredPrompt) return 'native';
    if(overlap) return 'overlap';
    if(wasInstalled() || installedNow) return 'installed';
    if(isIOS) return isIOSSafari ? 'ios' : 'ios-other';
    return canPrompt && prep !== 'fail' ? 'prepare' : 'manual';
  }
  function startPrepare(){
    if(prep) return;
    prep = 'wait';
    var end = Math.max(Date.now() + 4000, T0 + ENGAGE_MS);
    (function tick(){
      if(deferredPrompt || prep !== 'wait' || !gateOn) return;
      var left = Math.ceil((end - Date.now()) / 1000);
      if(left <= 0){ prep = 'fail'; renderGate(); return; }
      if(!document.getElementById('igWait')) renderGate();
      var el = document.getElementById('igWait'); if(el) el.textContent = '⏳ جاري تجهيز التثبيت... ' + left;
      prepTimer = setTimeout(tick, 250);
    })();
  }
  // التطبيق مثبّت على هذا الجهاز؟ (Chrome أندرويد: ملف التثبيت يذكر نفسه في related_applications، ويرى
  // المتصفح فقط التطبيقات التي تشمل هذه الصفحة). في صفحة الإدارة: إن ظهر تطبيق العمال فهو مثبّت من نسخة قديمة
  // نطاقها كل الموقع — يشمل صفحة الإدارة فيمنع المتصفح تثبيتها بجانبه (overlap)
  var overlap = false;
  function detectInstalled(){
    if(!navigator.getInstalledRelatedApps) return;
    navigator.getInstalledRelatedApps().then(function(list){
      list = list || [];
      overlap = adminPage && list.some(function(a){ return /\/manifest\.webmanifest$/.test(a.url || ''); });
      if((overlap || list.length) && !deferredPrompt){ installedNow = !overlap; renderGate(); }
    }).catch(function(){});
  }
  function copyLink(btn){
    var done = function(){ btn.textContent = 'تم نسخ الرابط ✓'; };
    try{ navigator.clipboard.writeText(location.href).then(done, fallback); }catch(e){ fallback(); }
    function fallback(){ var t = document.createElement('input'); t.value = location.href; document.body.appendChild(t); t.select();
      try{ document.execCommand('copy'); done(); }catch(e){} t.remove(); }
  }
  var COPY_BTN = '<button class="ig-btn2" id="igCopy">📋 نسخ رابط التطبيق</button>';
  function renderGate(){
    if(!gateOn) return;
    var m = gateMode(), h = '';
    if(m === 'native'){
      h = '<button class="ig-btn" id="igInstall">📲 تثبيت الآن</button><p class="ig-hint">اضغط «تثبيت» في النافذة التي تظهر، ثم افتح التطبيق من أيقونته.</p>';
    }else if(m === 'prepare'){
      h = prep === 'wait'
        ? '<button class="ig-btn" id="igWait" disabled>⏳ جاري تجهيز التثبيت...</button><p class="ig-hint">ابقَ على هذه الصفحة لحظات — يتحول الزر إلى «تثبيت الآن» تلقائيًا.</p>'
        : '<button class="ig-btn" id="igPrepare">📲 تثبيت التطبيق</button><p class="ig-hint">اضغط الزر، ويجهّز المتصفح التثبيت خلال ثوانٍ.</p>';
    }else if(m === 'overlap'){
      var workerUrl = location.href.split(/[?#]/)[0].replace(/admin\.html$/, 'app.html');
      h = '<p class="ig-steps">تطبيق العمال المثبّت على هذا الهاتف من نسخة قديمة يشمل صفحة الإدارة، لذلك لا يسمح المتصفح بتثبيت تطبيق الإدارة بجانبه. الحل مرة واحدة فقط:</p>' +
          '<ol class="ig-steps"><li>احذف أيقونة <b>UniGuard</b> (تطبيق العمال) من الهاتف: اضغط عليها مطولًا ← إلغاء التثبيت</li>' +
          '<li>افتح <a href="' + workerUrl + '" style="color:#f0b45c">رابط تطبيق العمال</a> وثبّته من جديد</li><li>عد إلى هذه الصفحة وثبّت تطبيق الإدارة</li></ol>';
    }else if(m === 'installed'){
      h = '<div class="ig-ok">✓ تم تثبيت التطبيق على هاتفك</div><p class="ig-steps">افتحه الآن من أيقونة <b>' + APP_LABEL + '</b>' + (isPhone ? ' في الشاشة الرئيسية لهاتفك.' : ' (في سطح المكتب أو قائمة البرامج).') + '</p>' +
          '<p class="ig-hint">لا تجد الأيقونة؟ <a href="#" id="igReinstall">اعرض خطوات التثبيت</a></p>';
    }else if(m === 'ios'){
      h = '<ol class="ig-steps"><li>اضغط زر المشاركة ' + SHARE_SVG + ' أسفل الشاشة</li><li>اختر «إضافة إلى الشاشة الرئيسية»</li><li>اضغط «إضافة» ✓ ثم افتح التطبيق من أيقونته</li></ol>';
    }else if(m === 'ios-other'){
      h = '<p class="ig-steps">التثبيت على آيفون يتم من متصفح <b>Safari</b> فقط: انسخ الرابط وافتحه في Safari، ثم اضغط زر المشاركة ' + SHARE_SVG + ' واختر «إضافة إلى الشاشة الرئيسية».</p>' + COPY_BTN;
    }else if(m === 'insecure'){ // رابط http (مثل عنوان شبكة محلية للتجربة): المتصفح يمنع تثبيت التطبيقات عليه
      h = '<p class="ig-steps">لا يمكن تثبيت التطبيق من هذا الرابط لأنه غير آمن (<b>http</b>). افتح رابط التطبيق الرسمي الذي يبدأ بـ <b>https://</b> لتثبيته.</p>' +
          COPY_BTN + '<button class="ig-btn2" id="igContinue">متابعة في المتصفح (للتجربة فقط)</button>';
    }else if(m === 'inapp-android'){
      var intent = 'intent://' + location.host + location.pathname + location.search + '#Intent;scheme=' + location.protocol.replace(':', '') + ';package=com.android.chrome;end';
      h = '<a class="ig-btn" href="' + intent + '">🌐 فتح في Chrome للتثبيت</a>' + COPY_BTN +
          '<p class="ig-hint">الرابط مفتوح داخل تطبيق آخر (مثل واتساب) ولا يمكن التثبيت منه — افتحه في متصفح Chrome.</p>';
    }else if(m === 'inapp-ios'){
      h = '<p class="ig-steps">الرابط مفتوح داخل تطبيق آخر (مثل واتساب). اضغط <b>⋯</b> ثم «فتح في Safari»، أو انسخ الرابط وافتحه في Safari.</p>' + COPY_BTN;
    }else{
      // المتصفح لم يعرض التثبيت المباشر بعد انتظار كافٍ: غالبًا التطبيق مثبّت أصلًا
      var why = prep === 'fail' ? '<p class="ig-hint">لم يعرض المتصفح التثبيت المباشر. إن كان التطبيق مثبّتًا فافتحه من أيقونة <b>' + APP_LABEL + '</b>، وإلا ثبّته من القائمة:</p>' : '';
      if(!isPhone){ // كمبيوتر: أيقونة التثبيت في شريط العنوان
        h = why + '<ol class="ig-steps"><li>اضغط أيقونة التثبيت ⊕ في يمين شريط العنوان، أو قائمة المتصفح <b>⋮</b></li><li>اختر «تثبيت ' + APP_LABEL + '»</li><li>افتح التطبيق من أيقونته على سطح المكتب</li></ol>';
      }else{ // manual: متصفح لا يعرض زر التثبيت المباشر (أو التطبيق مثبّت أصلًا)
        h = why + '<ol class="ig-steps"><li>اضغط قائمة المتصفح <b>⋮</b> أعلى الشاشة</li><li>اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»</li><li>اضغط «تثبيت» ✓ ثم افتح التطبيق من أيقونته</li></ol>' +
            '<p class="ig-hint">إن كان التطبيق مثبّتًا من قبل ستجد في القائمة «فتح التطبيق».</p>';
      }
    }
    var box = document.getElementById('igAction');
    box.innerHTML = h;
    var b;
    if((b = document.getElementById('igInstall'))) b.onclick = gateInstall;
    if((b = document.getElementById('igPrepare'))) b.onclick = startPrepare;
    if((b = document.getElementById('igCopy'))) b.onclick = function(){ copyLink(this); };
    if((b = document.getElementById('igContinue'))) b.onclick = function(){
      bypass = true; window.InstallGate.hide();
      if(typeof init === 'function') init(); // يكمل الفتح العادي (البوابة لم تعد مطلوبة في هذه الجلسة)
    };
    if((b = document.getElementById('igReinstall'))) b.onclick = function(e){ e.preventDefault(); setInstalled(false); installedNow = false; prep = ''; renderGate(); };
  }
  function gateInstall(){
    if(!deferredPrompt){ renderGate(); return; }
    var p = deferredPrompt; deferredPrompt = null;
    p.prompt();
    p.userChoice.then(function(c){ if(c && c.outcome === 'accepted'){ setInstalled(true); markSeen(); } renderGate(); })
      .catch(function(){ renderGate(); });
  }
  window.InstallGate = {
    // من المتصفح (غير مثبّت): النافذة الكبيرة هي الوحيدة التي تظهر حتى التثبيت —
    // تطبيق العمال: الهواتف. تطبيق الإدارة: الهواتف + الكمبيوتر الذي يدعم متصفحه التثبيت (Chrome/Edge)
    required: function(){
      return !bypass && !isStandalone() && /^https?:$/.test(location.protocol) && (isPhone || (adminPage && 'onbeforeinstallprompt' in window));
    },
    show: function(){
      if(gateOn) return;
      gateOn = true;
      var logo = gate.querySelector('.ig-logo'); if(logo) logo.src = UI_LOGO_SRC;
      if(adminPage){ // نصوص تطبيق الإدارة
        document.getElementById('igTitle').textContent = 'ثبّت تطبيق الإدارة';
        gate.querySelector('.ig-sub').textContent = 'لوحة الإدارة تعمل كتطبيق مستقل عن تطبيق العمال — ثبّته على جهازك أولًا، مرة واحدة فقط.';
        gate.querySelector('.ig-feats').innerHTML = '<li><span>🔐</span>دخول باسم المستخدم وكلمة المرور، والفتح بقفل الهاتف اختياري</li><li><span>🔔</span>تصلك طلبات الحضور والأجهزة والتسجيل فورًا</li><li><span>⚡</span>يفتح مباشرة على لوحة الإدارة بأيقونته الخاصة (ADMIN)</li>';
      }
      gate.classList.remove('hidden');
      if(window.updateScrollLock) updateScrollLock(); // الصفحة خلف البوابة لا تتحرك
      banner.hidden = true; fab.hidden = true;
      detectInstalled();
      renderGate();
    },
    hide: function(){ gateOn = false; gate.classList.add('hidden'); if(window.updateScrollLock) updateScrollLock(); },
    isOn: function(){ return gateOn; }
  };

  if(isStandalone() || !/^https?:$/.test(location.protocol)) return;

  /* ---- النافذة ---- */
  function mode(){ return deferredPrompt ? 'native' : (isIOS ? (isIOSSafari ? 'ios' : 'ios-other') : 'manual'); }
  function render(m){
    if(window.InstallGate.required()) return; // الهاتف غير مثبّت: النافذة الكبيرة فقط، لا نافذة صغيرة
    var steps = '';
    if(m === 'ios'){
      steps = '<div class="ib-steps">١) اضغط زر المشاركة ' + SHARE_SVG + ' أسفل الشاشة<br>٢) اختر «إضافة إلى الشاشة الرئيسية»<br>٣) اضغط «إضافة» ✓</div>';
    } else if(m === 'ios-other'){
      steps = '<div class="ib-steps">افتح هذه الصفحة في متصفح <b>Safari</b> ثم اضغط زر المشاركة واختر «إضافة إلى الشاشة الرئيسية».</div>';
    } else if(m === 'manual'){
      steps = '<div class="ib-steps">افتح قائمة المتصفح (⋮) ثم اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</div>';
    }
    banner.innerHTML =
      '<div class="ib-row"><img class="ib-icon" alt="" src="'+UI_LOGO_SRC+'">' +
      '<div class="ib-text"><b>ثبّت '+(adminPage ? 'تطبيق الإدارة' : 'تطبيق '+SHORT_NAME)+' بضغطة واحدة</b><span>يفتح من شاشتك الرئيسية مثل أي تطبيق، أسرع وبدون شريط المتصفح.</span></div></div>' +
      steps +
      '<div class="ib-actions">' +
      (m === 'native' ? '<button class="ib-yes" id="ibInstall">📲 تثبيت الآن</button>' : '') +
      '<button class="ib-no" id="ibClose">'+(m === 'native' ? 'لاحقًا' : 'حسنًا')+'</button></div>';
    banner.hidden = false;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ banner.classList.add('show'); }); });
    document.getElementById('ibClose').onclick = hide;
    var yes = document.getElementById('ibInstall');
    if(yes) yes.onclick = doInstall;
    fab.hidden = true;
  }
  function hide(){
    markSeen();
    banner.classList.remove('show');
    setTimeout(function(){ banner.hidden = true; updateFab(); }, 450);
  }
  function doInstall(){
    if(!deferredPrompt){ render(mode()); return; }
    var p = deferredPrompt; deferredPrompt = null;
    p.prompt();
    p.userChoice.then(function(c){
      banner.classList.remove('show'); banner.hidden = true;
      if(c && c.outcome === 'accepted'){ markSeen(); fab.hidden = true; } else { updateFab(); }
    }).catch(function(){ updateFab(); });
  }

  /* ---- الزر السريع: ظاهر دائمًا حتى يُثبَّت التطبيق ---- */
  function canOffer(){ return !!deferredPrompt || isIOS || isMobile; }
  function updateFab(){
    fab.hidden = isStandalone() || gateOn || window.InstallGate.required() || fabHiddenThisSession || !banner.hidden || !canOffer();
  }
  fab.addEventListener('click', function(e){
    if(e.target && e.target.id === 'installFabX'){ e.stopPropagation(); fabHiddenThisSession = true; fab.hidden = true; return; }
    if(deferredPrompt) doInstall(); else render(mode());
  });

  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredPrompt = e;
    setInstalled(false); // المتصفح يعرض التثبيت = التطبيق غير مثبّت (حُذف مثلًا)
    if(gateOn){ clearTimeout(prepTimer); renderGate(); return; } // البوابة تعرض الزر بنفسها
    // أول فتح: نافذة التثبيت فورًا؛ بعدها يبقى الزر السريع متاحًا
    if(!seen()) render('native'); else updateFab();
  });
  window.addEventListener('appinstalled', function(){
    deferredPrompt = null; markSeen(); setInstalled(true); fab.hidden = true;
    banner.classList.remove('show'); banner.hidden = true;
    renderGate();
  });

  // آيفون/متصفحات بلا حدث تثبيت: نعرض الخطوات مرة عند أول فتح، والزر السريع دائمًا
  setTimeout(function(){
    if(isStandalone() || gateOn) return;
    if(!deferredPrompt && !seen() && (isIOS || isMobile)) render(mode());
    else updateFab();
  }, isIOS ? 900 : 2500);
})();
