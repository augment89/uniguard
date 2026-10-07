/* =========================================================================
   حركة شاشة البداية (GSAP): يظهر الشعار في الوسط، ثم عند الإخفاء يصعد الشعار نفسه إلى مكان
   شعار صفحة الدخول — الخلفيتان متطابقتان، فتبدو شاشة البداية وكأنها تتحول إلى صفحة الدخول.
   يُحمَّل مباشرة بعد عناصر الشاشة (قبل config.js و core.js) فتبدأ الحركة من أول لحظة.
   core.js يستدعي SplashFX.out عند الإخفاء و SplashFX.reset عند إعادة الإظهار.
   تظهر في كل فتح وكل تحديث للصفحة، وشريط التحميل يكتمل حتى 100% قبل أن تختفي.
   بلا حركة: «تقليل الحركة»، أو تأخر تحميل الملف (ظهور CSS البسيط).
   ========================================================================= */
(function(){
  var sp = document.getElementById('splash');
  if(!sp) return;
  // داخل الحساب (sp-skip): بلا شاشة بداية — مخفية من البداية؛ Splash.show (رسالة انتظار) يعيد إظهارها
  if(document.documentElement.classList.contains('sp-skip')) sp.classList.add('sp-hide');
  var g = window.gsap;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // إن تأخر وصول الملفين بعد رسم الشاشة (__spT) فقد بدأ ظهور CSS (بعد 0.6 ث): لا نعيد الشاشة من الصفر (وميض)
  var fx = !!g && !reduce && !sp.classList.contains('sp-hide') && performance.now() - (window.__spT || 0) < 450;
  var mark = sp.querySelector('.sp-mark'), lines = [].slice.call(sp.querySelector('.sp-txt').children);
  // لحظة رسم الشاشة (لا لحظة وصول هذا الملف): منها تُحسب أقل مدة ظهور
  var tl = null, fly = null, flyTarget = null, startAt = Date.now() - Math.max(0, performance.now() - (window.__spT || performance.now()));
  var bar = document.getElementById('spBar'), pctEl = document.getElementById('spPct');
  var INTRO_MS = 1100; // أقل مدة قبل الإخفاء: يكتمل ظهور الشعار ويُرى شريط التحميل وهو يمتلئ
  var PLAIN_MS = 900;  // بلا مكتبة الحركة أو مع «تقليل الحركة»: أقل مدة ظهور للشعار والشريط

  if(fx){
    sp.classList.add('fx');
    g.set(mark, { opacity: 0, scale: .82, y: 14 }); // فورًا (قبل أول رسم) — لا داخل الخط الزمني
    g.set(lines, { opacity: 0, y: 10 });
    tl = g.timeline()
      .to(mark, { opacity: 1, scale: 1, y: 0, duration: .7, ease: 'power3.out' }, .05)
      .to(lines, { opacity: 1, y: 0, duration: .45, stagger: .07, ease: 'power2.out' }, .35);
  }

  // fadeStart: يبدأ إخفاء core.js (sp-out + فك قفل التمرير ← تبدأ حركة صفحة الدخول)، fadeEnd: يُخفي الشاشة نهائيًا
  // from: نسبة التحميل الحالية — يمتلئ الشريط منها إلى 100% ثم تختفي الشاشة
  function out(fadeStart, fadeEnd, from){
    if(!fx){
      // بلا حركة: الشعار والشريط ظاهران فورًا (sp-ready)، والشريط يمتلئ بانتقال CSS، ثم تختفي بعد أقل مدة —
      // كانت تختفي فورًا داخل الحساب (البيانات جاهزة من النسخة المحلية) قبل أن يظهر الشعار أو الشريط
      sp.classList.add('sp-ready');
      bar.style.width = '100%'; pctEl.textContent = '100%';
      setTimeout(function(){ fadeStart(); setTimeout(fadeEnd, 380); }, Math.max(500, PLAIN_MS - (Date.now() - startAt)));
      return;
    }
    var wait = Math.max(0, INTRO_MS - (Date.now() - startAt)), p = { v: Math.max(4, from || 0) };
    bar.style.transition = 'none';
    g.to(p, { v: 100, duration: Math.max(.45, wait / 1000), ease: 'power1.inOut',
      onUpdate: function(){ bar.style.width = p.v + '%'; pctEl.textContent = Math.round(p.v) + '%'; },
      onComplete: function(){ bar.style.transition = ''; leave(fadeStart, fadeEnd); } });
  }
  // صفحة الدخول ظاهرة: ينتقل الشعار إلى مكان شعارها. غيرها (الحساب، القفل): تلاشٍ عادي
  function leave(fadeStart, fadeEnd){
    var target = document.querySelector('body > .landing:not(.hidden) .landing-hero .brand-logo');
    if(tl){ tl.progress(1); tl = null; }
    if(!target || !target.offsetWidth){ fadeStart(); setTimeout(fadeEnd, 380); return; }
    // شعار صفحة الدخول بلا حركة دخول (نقيس مكانه النهائي)، ومخفي حتى يصل إليه شعار شاشة البداية
    document.documentElement.classList.add('sp-flying');
    var a = mark.getBoundingClientRect(), b = target.getBoundingClientRect();
    flyTarget = target; target.style.visibility = 'hidden';
    sp.classList.add('sp-fly');
    fadeStart();
    fly = g.to(mark, {
      x: (b.left + b.width / 2) - (a.left + a.width / 2),
      y: (b.top + b.height / 2) - (a.top + a.height / 2),
      scale: b.height / a.height, duration: .7, ease: 'power3.inOut',
      onComplete: function(){ fly = null; fadeEnd(); cleanup(); }
    });
  }
  function cleanup(){
    if(fly){ fly.kill(); fly = null; }
    if(flyTarget){ flyTarget.style.visibility = ''; flyTarget = null; }
    sp.classList.remove('sp-fly');
    document.documentElement.classList.remove('sp-flying');
    if(fx) g.set(mark, { clearProps: 'transform' });
  }
  // إعادة الإظهار («اسحب للتحديث»، «جاري بدء فترة جديدة»): الشعار في مكانه ظاهرًا بلا حركة البداية،
  // وأقل مدة ظهور تُحسب من الآن — وإلا يختفي فورًا حين يكتمل التحديث بسرعة فلا يُرى الشريط وهو يمتلئ
  function reset(){
    startAt = Date.now();
    if(tl){ tl.progress(1); tl = null; }
    cleanup();
    if(fx) g.set([mark].concat(lines), { clearProps: 'opacity,transform' });
  }

  window.SplashFX = { out: out, reset: reset };
})();
