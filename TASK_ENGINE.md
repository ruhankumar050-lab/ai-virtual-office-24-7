# محرك تنفيذ المهام المستمر (TASK_ENGINE.md)

## 1. نموذج الحالات الإحدى عشرة (11 Task Statuses)
1. `new` (جديدة)
2. `analyzing` (قيد التحليل)
3. `queued` (في قائمة الانتظار)
4. `in_progress` (قيد التنفيذ)
5. `waiting_dependency` (تنتظر موظفًا آخر)
6. `testing` (قيد الاختبار)
7. `needs_fix` (تحتاج إلى إصلاح)
8. `awaiting_owner_approval` (تنتظر موافقة المالك)
9. `completed` (مكتملة)
10. `paused` (متوقفة)
11. `failed` (فشلت)

## 2. آلية المسارات المتوازية والاعتماديات (Parallel DAG)
عند استلام درس أو مشروع متكامل عبر `createMultiTrackProject()`:
- تُنشأ **4 مسارات مستقلة بالتوازي**: `curriculum`، `video`، `game`، `booklet`.
- المهام التابعة (مثل `render_real_video` بعد `produce_video_script`، ومهام `qa_verify_*` بعد البناء، ومهمة `ceo_finalize_project` بعد جميع مسارات QA) تبدأ بحالة `waiting_dependency` وتُفتح تلقائياً إلى `queued` فور اكتمال `depends_on_json`.
- ينفذ العمال (`processReadyQueueJobs`) حتى `maxConcurrency` (افتراضياً 3) مهام متوازية في الدورة الواحدة.

## 3. نقاط الاستكمال والميزانية والمحاولات (Checkpoints & Recovery)
- تُحفظ نتائج كل خطوة في `checkpoint_json` و`kv_store` داخل `data/office.sqlite`.
- عند إعادة تشغيل الخادم، يبحث `orchestrator.init()` عن أي مهام أو وظائف عالقة في حالة `in_progress` / `running` ويعيدها إلى `queued` / `pending` لاستئنافها من آخر Checkpoint دون تكرار العمل المنتهي.
- لكل مهمة حد محاولات (`max_attempts = 3`) ولكل مشروع ميزانية توكنز (`budget_tokens = 150000`) تمنع الحلقات اللانهائية وتُحوّل المهمة إلى `paused` أو `failed` مع `stop_reason` واضح يرفعه أ. طارق للمالك.
