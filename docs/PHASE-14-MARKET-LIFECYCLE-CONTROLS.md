# Phase 14 — إدارة دورة حياة السوق (Market Lifecycle & Controls)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ ضوابط دورة حياة الأصول/الأسواق محليًا لضمان انتقالات حالة آمنة ومنضبطة.

## 2. النطاق
### داخل النطاق
- وحدة `source/controls/src/lifecycle-controls.mjs`.
- حالات مدعومة: `draft`, `active`, `halted`, `suspended`, `retired`.
- انتقالات مسموحة فقط مع تسجيل أسباب/فاعلين وطوابع زمنية.
- ضوابط تشغيل (pause/halt/resume) وcircuit-breaker محاكى بسيط (عتبات قابلة للتهيئة).
- اختبارات Node.

### خارج النطاق
- حوكمة إنتاجية on-chain مع تصويت
- تكامل مراقبة خارجية حية

## 3. التصميم المقترح
- `createLifecycleController()`
- تسجيل كيان (asset/market) وتتبع حالته وتاريخه.
- `transition(entityId, toState, { actorId, reason })`
- `tripCircuitBreaker` / `resetCircuitBreaker`
- فحوصات `canTrade`, `canMutate` حسب الحالة.

## 4. خطة التنفيذ
1. إنشاء الوحدة والاختبارات.
2. تنفيذ آلة الحالات والضوابط والسجل.
3. تشغيل `node --test source/controls/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- منع الانتقالات غير الصالحة.
- تسجيل كل انتقال/إجراء تحكم.
- الاختبارات تمر محليًا.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/controls/src/lifecycle-controls.mjs`
  - `source/controls/test/lifecycle-controls.test.mjs`
- تنفيذ الاختبارات:
  - `node --test source/controls/test/lifecycle-controls.test.mjs`
- النتيجة: **3 اختبارات ناجحة، 0 فشل** (انتقالات حالة صالحة، منع انتقالات غير صالحة/نهائية، circuit breaker وauto-halt).
