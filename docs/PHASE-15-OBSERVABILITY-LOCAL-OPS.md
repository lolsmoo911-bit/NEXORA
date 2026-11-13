# Phase 15 — المراقبة والرصد المحلي (Observability & Local Ops)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تحسين قابلية الملاحظة والتشغيل المحلي للنظام عبر سجلات منظمة، فحوصات صحة، وإرشادات تشغيل.

## 2. النطاق
### داخل النطاق
- وحدة `source/observability/src/observability.mjs`:
  - logger منظم (structured) مع مستويات وأحداث سياقية
  - health checks قابلة للتسجيل والتنفيذ
  - ملخص حالة تشغيلي
- اختبارات Node.
- Runbook محلي: `docs/LOCAL-OPS-RUNBOOK.md`.

### خارج النطاق
- منصات مراقبة مدفوعة (APM/SaaS)
- تنبيهات إنتاجية موزعة

## 3. التصميم المقترح
- `createLogger({ service, sink })` ينتج سجلات JSON-like قابلة للفحص.
- `createHealthRegistry()` لتسجيل checks (`name`, async/sync fn) وتنفيذها مع حالة `ok/degraded/down`.
- مؤشرات أساسية: uptime، عدد الأحداث، آخر أخطاء.

## 4. خطة التنفيذ
1. إنشاء الوحدة والاختبارات والـ runbook.
2. تشغيل `node --test source/observability/test/*.mjs`.
3. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- سجلات منظمة قابلة للاستهلاك برمجيًا.
- فحوصات الصحة تُرجع نتائج واضحة ومجمعة.
- توفر runbook تشغيل محلي أساسي.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/observability/src/observability.mjs`
  - `source/observability/test/observability.test.mjs`
  - `docs/LOCAL-OPS-RUNBOOK.md`
- تنفيذ الاختبارات:
  - `node --test source/observability/test/observability.test.mjs`
- النتيجة: **3 اختبارات ناجحة، 0 فشل** (سجلات منظمة، تجميع فحوصات الصحة، ملخص تشغيل محلي).
