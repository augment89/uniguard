/* =========================================================================
   إعدادات التطبيق — الملف الوحيد الذي تحتاج تعديله عند النشر
   - WEB_APP_URL: رابط /exec لنشر Google Apps Script (server/Code.gs)
   - SHEET_API_KEY: يطابق API_KEY في Code.gs
   - عند نشر نسخة جديدة: node tools/release.js 2.9.1 — يرفع الإصدار هنا وفي sw.js وروابط ?v=
     ويولّد صفحة الإدارة admin.html من app.html
   ========================================================================= */
const APP_VERSION = '2.9.4';
const APP_BUILD = '2026-09-30';
const APP_NAME_AR = 'حضور الحماية العالمية';
const APP_NAME_EN = 'UniGuard Attendance';
const APP_SHORT = 'UniGuard';
const COMPANY_AR = 'الحماية العالمية';

// الخادم (Google Apps Script)
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycby0yn_SX4NFy-b-vig0mpOWs66XD77nO76IrvFznu78tDlYLx7sgQqqQDoHV6tJ3iwIYQ/exec";
const SHEET_API_KEY = "wrk-1fA3kQ7xLm2ZpT8vB4nRc6YdH1sEu3Jg";

// نماذج التعرف على الوجه
const MODELS_URL = "https://justadudewhohacks.github.io/face-api.js/models";

// الشعار: رابط كامل (يعمل أيضًا داخل نافذة الطباعة وملف PDF)
const LOGO_SRC = new URL('img/logo.png', document.baseURI).href;
// شعار واجهة التطبيق: تطبيق الإدارة (admin.html) بشعار مختلف يميّزه عن تطبيق العمال (التقارير تبقى بشعار الشركة)
const IS_ADMIN_APP = /\/admin\.html$/.test(location.pathname);
const UI_LOGO_SRC = IS_ADMIN_APP ? new URL('img/logo-admin.png', document.baseURI).href : LOGO_SRC;
