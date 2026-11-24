# التخزين المحلي والتكامل مع Google Drive (STORAGE_AND_DRIVE.md)

## 1. التخزين المحلي الدائم
- قاعدة البيانات: `data/office.sqlite` (SQLite عبر `sql.js` مع حفظ ذري `.tmp` -> `rename`).
- مخرجات المشاريع: `deliverables/projects/<projectId>/{video,game,booklet,curriculum}/`.
- سجل الأصول: جدول `assets_registry` يحفظ المسار المحلي، المصدر، الترخيص، ونتائج فحص 3D، ورابط Drive بعد الرفع.

## 2. التكامل الرسمي مع Google Drive (OAuth 2.0)
تم بناء طبقة `engine/drive.js` لدعم ربط حساب المالك الشخصي عبر OAuth 2.0 الرسمي:
- المسارات: `/api/drive/status`, `/api/drive/credentials`, `/api/drive/auth-url`, `/api/drive/oauth/callback`, `/api/drive/upload-asset`, `/api/drive/files`, `/api/drive/disconnect`.
- المجلد الرئيسي التلقائي: `AI Virtual Office` مع مجلدات فرعية للمشروع والقسم.
- **الرفع القابل للاستئناف (Resumable Upload):** يدعم الرفع على أجزاء عبر `uploadType=resumable` لملفات الفيديو الكبيرة.
- **حماية الملفات:** يمنع الاستبدال الصامت للملفات الموجودة عبر إصدار نسخة جديدة مؤرخة.
- **ملاحظة المساحة:** مساحة Google المجانية (15 GB عادةً) مشتركة بين Google Drive وGmail وGoogle Photos.

## 3. ما يلزم لتفعيل الربط على حسابك الشخصي
لعدم توفر بيانات تطبيق OAuth خاصة بحسابك مسبقاً، يتطلب تفعيل زر **"ربط Google Drive"** الخطوة التالية من المالك:
1. إنشاء OAuth Client ID (Web Application) في Google Cloud Console وتفعيل `Google Drive API`.
2. إضافة Redirect URI: `https://<your-domain>/api/drive/oauth/callback`.
3. إدخال `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET` في إعدادات الخادم (أو من قسم إعدادات Drive المحمي بكلمة مرور المالك)، ثم الضغط على **ربط Google Drive** والموافقة على الصلاحيات.
