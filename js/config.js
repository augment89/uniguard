/* =========================================================================
   إعدادات التطبيق — الملف الوحيد الذي تحتاج تعديله عند النشر
   - WEB_APP_URL: رابط /exec لنشر Google Apps Script (server/Code.gs)
   - SHEET_API_KEY: يطابق API_KEY في Code.gs
   - عند نشر نسخة جديدة: node tools/release.js 2.9.1 — يرفع الإصدار هنا وفي sw.js وروابط ?v=
     ويولّد صفحة الإدارة admin.html من app.html
   ========================================================================= */
const APP_VERSION = '2.20.0';
const APP_BUILD = '2026-10-05';
const APP_NAME_AR = 'حضور الحماية العالمية';
const APP_NAME_EN = 'UniGuard Attendance';
const APP_SHORT = 'UniGuard';
const COMPANY_AR = 'الحماية العالمية';

// الخادم (Google Apps Script)
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxrIdbV3p_Fngw240RaxUeaj37pGgOemN9G7qtQH18lNm7SfLoVGbOWenXOdnAEiWM/exec";
const SHEET_API_KEY = "wrk-1fA3kQ7xLm2ZpT8vB4nRc6YdH1sEu3Jg";

// التعرف على الوجه (2.18): كاشف Human (BlazeFace + شبكة 468 نقطة) وبصمة SFace (OpenCV Zoo) عبر onnxruntime-web.
// كلها من موقع التطبيق نفسه (public/js/vendor و public/models) — لا يعتمد على موقع خارجي قد يتعطل أو يُحذف.
// المصادر الخارجية الأصلية احتياط فقط إن لم تُرفع الملفات المحلية. أسماء المجلدات تحمل الإصدار (ذاكرة الهاتف لها دائمة)
const HUMAN_SRC = new URL('js/vendor/human-3.3.6/human.esm.js', document.baseURI).href;
const HUMAN_MODELS = new URL('models/human/', document.baseURI).href;
const ORT_DIR = new URL('js/vendor/ort-1.20.1/', document.baseURI).href;
// SFace بأوزان 16 بت (18.5MB بدل 36.9MB): نفس البصمات حرفيًا (تشابه 1.00000 على 40 صورة) — تُعاد 32 بت عند فتحه
const SFACE_URL = new URL('models/sface/face_recognition_sface_2021dec_f16.onnx', document.baseURI).href;
const SFACE_MB = 18.5, ORT_WASM_MB = 10.7; // للنسبة المئوية أثناء أول تنزيل إن لم يذكر الخادم الحجم
const HUMAN_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js';
const HUMAN_MODELS_CDN = 'https://vladmandic.github.io/human-models/models/';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const SFACE_CDN = 'https://huggingface.co/opencv/opencv_zoo/resolve/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx';

// الشعار: رابط كامل (يعمل أيضًا داخل نافذة الطباعة وملف PDF)
const LOGO_SRC = new URL('img/logo.png', document.baseURI).href;
// شعار واجهة التطبيق: تطبيق الإدارة (admin.html) بشعار مختلف يميّزه عن تطبيق العمال (التقارير تبقى بشعار الشركة)
const IS_ADMIN_APP = /\/admin\.html$/.test(location.pathname);
const UI_LOGO_SRC = IS_ADMIN_APP ? new URL('img/logo-admin.png', document.baseURI).href : LOGO_SRC;
