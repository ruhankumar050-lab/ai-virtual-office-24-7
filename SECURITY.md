# الأمان وحماية البيانات والأسرار (SECURITY.md)

1. **حماية مفاتيح API والأسرار:**
   - تُحفظ مفاتيح `AI_API_KEY`, `AI_BACKUP_API_KEY`, `GOOGLE_CLIENT_SECRET`, `PLATFORM_API_KEY`, و`OWNER_PASSWORD` على الخادم فقط (متغيرات البيئة أو `kv_store` غير المُصدّر).
   - يتم إخفاء المفاتيح في `/api/state` و`/api/backup` (`••••••••xxxx`) ولا تُرسل أبداً إلى المتصفح ولا تُخزن في `localStorage`.
   - دالة `redactSecrets()` تحذف أي أنماط مفاتيح (`gsk_`, `AIza`, `AQ.`, `sk-or-`, `ghp_`, `rnd_`) قبل كتابة أي سجل أخطاء.

2. **مصادقة المالك (Owner Auth):**
   - تعتمد على `crypto.scryptSync` لتجزئة كلمة المرور وملف تعريف ارتباط `HttpOnly; SameSite=Lax` موقع بـ `HMAC-SHA256`.
   - تحمي المسارات الحساسة (`/api/settings`, `/api/reset`, `/api/restore`, `/api/drive/credentials`, `/api/drive/disconnect`, `/api/platform/config`).

3. **فحص وعزل الأكواد المولدة (Sandbox Static Analysis):**
   - تمر كل التطبيقات والألعاب المولدة عبر `scanGeneratedCodeSafety()` لمنع `eval()` و`new Function()` وقراءة `document.cookie` والروابط غير الموثوقة قبل حفظها للمعاينة.

4. **فحص أصول 3D (GLB/GLTF):**
   - يرفض `inspectGlbOrGltf()` أي نموذج ثلاثي الأبعاد بدون ترخيص واضح أو حجمه مفرط (>15MB) أو هيكله معطوب.

5. **سجل التدقيق والصلاحيات:**
   - تُسجل العمليات الحساسة في جدول `audit_logs`، ولا يملك أي موظف صلاحية حذف قاعدة البيانات أو النشر الخارجي تلقائياً.
