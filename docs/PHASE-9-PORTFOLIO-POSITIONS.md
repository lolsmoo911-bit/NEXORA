# Phase 9 — المحافظ والمراكز (Portfolio & Positions Service)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ خدمة محلية (محاكاة) لتتبع:
- الحسابات والأرصدة النقدية المحاكاة
- المراكز (positions) لكل أداة
- سجل العمليات (trades/deposits/withdrawals marks)
- لقطات حالة (snapshots) قابلة لإعادة البناء
- تقييم PnL/التعرض الأساسي باستخدام أسعار/علامات تسعير مُمررة

## 2. النطاق
### داخل النطاق
- وحدة في `source/portfolio/src/portfolio-service.mjs`.
- وظائف:
  - إنشاء/إدارة حسابات محاكاة
  - إيداع/سحب نقدي محاكى
  - تطبيق تنفيذات تداول (fills/trades) على الأرصدة والمراكز
  - تحديث أسعار market marks وحساب `unrealized PnL`, `equity`, `exposure`
  - توليد snapshot للحالة
- اختبارات Node في `source/portfolio/test/`.

### خارج النطاق
- هامش/رافعة مالية إنتاجية معقدة، تصفية متقدمة
- تكامل مباشر مع DB إنتاجية أو APIs (لاحقًا)
- رسوم/تمويل/فوائد مركبة متقدمة

## 3. التصميم المقترح
- **Account:** cash balance, positions by instrument, realized PnL, history/events.
- **Position:** quantity, average cost, realized PnL, mark price, unrealized PnL.
- **Events:** deposit, withdraw, trade_buy, trade_sell (أو fill processing).
- **Snapshot:** deterministic JSON-serializable state for rebuild/inspection.

## 4. خطة التنفيذ
1. إنشاء وحدة الخدمة والاختبارات.
2. تنفيذ منطق تحديث الأرصدة والمراكز من الصفقات والأسعار.
3. تشغيل اختبارات `node --test source/portfolio/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- الأرصدة والمراكز وPnL تُحسب بشكل صحيح للسيناريوهات الأساسية.
- اللقطات تعكس الحالة الحالية بشكل متسق.
- الاختبارات تمر محليًا.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/portfolio/src/portfolio-service.mjs`
  - `source/portfolio/test/portfolio-service.test.mjs`
- تنفيذ الاختبارات:
  - `node --test source/portfolio/test/portfolio-service.test.mjs`
- النتيجة: **5 اختبارات ناجحة، 0 فشل** (إيداع/سحب، صفقات، PnL محقق/غير محقق، مراكز short، لقطات حالة).
