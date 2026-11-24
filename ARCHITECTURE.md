# معمارية النظام (ARCHITECTURE.md)

## 1. نظرة عامة
تعتمد الشركة الافتراضية المستقلة على بنية معيارية في بيئة Node.js تفصل بوضوح بين:
1. **واجهة الشركة التفاعلية (`public/index.html` + `public/office3d.js`):** مكتب ثلاثي الأبعاد عبر WebGL/Three.js (12 غرفة + شخصيات متحركة بمزامنة الشفاه) مع وضع ثنائي الأبعاد خفيف للأجهزة الضعيفة.
2. **طبقة الخادم والـ API (`server.js`):** خادم HTTP + Server-Sent Events (`/api/events`) وخدمة الأصول المحلية (`/vendor/three/` و `/deliverables/`).
3. **العقل المركزي ومحرك الطوابير (`engine/orchestrator.js`):** إدارة أ. طارق للمشاريع متعددة المسارات (Parallel DAG)، استعادة المهام، والـ Workers الخلفية.
4. **قاعدة البيانات الدائمة (`engine/db.js`):** SQLite (`sql.js` محفوظ ذرياً في `data/office.sqlite`) لعشر جداول علائقية (`projects`, `tasks`, `job_queue`, `bug_reports`, `agent_memories`, `meetings`, `ai_usage_logs`, `assets_registry`, `audit_logs`, `kv_store`).
5. **طبقة توجيه الذكاء الاصطناعي (`engine/aiRouter.js` + `engine/llm.js`):** اختيار الموديل المناسب حسب المهمة + التحويل التلقائي الاحتياطي + تتبع الاستهلاك والأخطاء.
6. **محرك الإنتاج والاختبار (`engine/generators.js` + `engine/lessonParser.js`):**
   - تحليل الدروس (`PDF`, `DOCX`, `PPTX`, `TXT`, `MD`).
   - إنتاج فيديو MP4 حقيقي (`@resvg/resvg-js` + `ffmpeg-static` + WAV + SRT).
   - إنتاج ملازم PDF (`pdfkit` + `NotoSansArabic` + `arabic-persian-reshaper`) وDOCX (`docx`).
   - بناء ألعاب HTML5 تفاعلية + فحص نماذج GLB/GLTF.
   - اختبارات QA مستقلة تُصدر Bug Reports.
7. **التكامل والأمان (`engine/drive.js` + `engine/security.js`):** Google Drive OAuth 2.0، مصادقة المالك (`scrypt` + HMAC Cookie)، وفحص الأمان الساكن للأكواد المولدة.
