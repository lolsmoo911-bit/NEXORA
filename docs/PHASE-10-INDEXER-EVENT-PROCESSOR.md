# Phase 10 — الفهرسة ومعالجة الأحداث (Indexer & Event Processor)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ معالج أحداث/فهرس محلي (local indexer) يحول أحداث السلسلة/السيرفر إلى نماذج قراءة قابلة للاستعلام مع:
- معالجة idempotent (إعادة نفس الحدث لا تغيّر النتيجة)
- دعم replay آمن
- نماذج قراءة للأصول، الأوامر/الصفقات، والمحافظ (ضمن النطاق المتاح)

## 2. النطاق
### داخل النطاق
- وحدة `source/indexer/src/event-indexer.mjs`.
- دعم أحداث محاكاة/موحدة (generic event envelope) مثل:
  - `AssetRegistered`, `AssetStateChanged`
  - `PriceUpdated`
  - `OrderPlaced`, `OrderCancelled`, `TradeExecuted`
  - `PortfolioDeposit`, `PortfolioWithdraw`
- تخزين حالة في الذاكرة مع إمكانية أخذ snapshot وإعادة البناء من event log.
- اختبارات Node.

### خارج النطاق
- اتصال RPC حي إلزامي أو مزامنة إنتاجية عالية الأداء
- قاعدة بيانات موزعة
- فهرسة كاملة لكل عقود السلسلة (يُوسّع لاحقًا)

## 3. التصميم المقترح
- **Event envelope:** `{ id, type, timestamp, source, payload, blockNumber?, txHash? }`
- **Idempotency key:** `event.id` (أو مفتاح مركب)
- **Read models:** خرائط/جداول منطقية للأصول، آخر الأسعار، الصفقات، أوامر، وحالة المحافظ المبسطة.
- واجهات:
  - `applyEvent(event)`
  - `applyEvents(events)`
  - `getState()` / `getSnapshot()`
  - `rebuildFrom(events)`

## 4. خطة التنفيذ
1. إنشاء الوحدة والاختبارات.
2. تنفيذ معالجات الأحداث وidempotency/replay.
3. تشغيل `node --test source/indexer/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- نفس الحدث المعاد لا يسبب ازدواجية.
- إعادة البناء من سجل الأحداث تنتج نفس الحالة النهائية.
- الاختبارات تمر محليًا.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/indexer/src/event-indexer.mjs`
  - `source/indexer/test/event-indexer.test.mjs`
- تنفيذ الاختبارات:
  - `node --test source/indexer/test/event-indexer.test.mjs`
- النتيجة: **4 اختبارات ناجحة، 0 فشل** (بناء read models، idempotency، replay/rebuild، معالجة تغييرات الحالة والأحداث غير المعروفة).
