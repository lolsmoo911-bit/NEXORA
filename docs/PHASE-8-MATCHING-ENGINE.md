# Phase 8 — محرك الأوامر والمطابقة (Matching Engine - Simulated)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ نواة تداول محاكاة (server-side logic) تدعم:
- دفتر أوامر مبسط (limit orders)
- مطابقة price-time priority
- تنفيذ جزئي/كامل، إلغاء أوامر
- توليد أحداث تداول (trades/fills) وسجل حالة دفتر الأوامر

## 2. النطاق
### داخل النطاق
- وحدة محرك مطابقة حتمية في `source/exchange/src/matching-engine.mjs`.
- دعم أوامر `limit` (buy/sell)، `cancel`.
- حالات الأمر: `open`, `partially_filled`, `filled`, `cancelled`, `rejected`.
- اختبارات Node في `source/exchange/test/`.

### خارج النطاق (هذه المرحلة)
- أوامر market/stop المتقدمة، رسوم معقدة، margin/liquidation إنتاجية
- استمرارية موزعة/عالية التوفر
- ربط مباشر بـ API/DB إنتاجية (يتكامل لاحقًا)

## 3. التصميم المقترح
- **Order:** `{ id, side, type, price, quantity, remaining, status, timestamp, accountId?, instrument }`
- **Book:** قوائم/هياكل مرتبة (bids تنازليًا بالسعر ثم الأقدمية، asks تصاعديًا بالسعر ثم الأقدمية)
- **Match:** عند إدخال أمر شراء قابل للتنفيذ يقابل أفضل أسعار بيع والعكس.
- **Trade:** `{ id, buyOrderId, sellOrderId, price, quantity, timestamp, instrument }`
- واجهات مقترحة:
  - `createMatchingEngine()` / class
  - `placeOrder(orderInput)`
  - `cancelOrder(orderId)`
  - `getOrder(orderId)`, `getBook(instrument)`, `getTrades()`

## 4. خطة التنفيذ
1. إنشاء `source/exchange/src/matching-engine.mjs` و`source/exchange/test/matching-engine.test.mjs`.
2. تنفيذ المنطق الحتمي والاختبارات (مطابقة كاملة/جزئية، أولوية السعر/الزمن، إلغاء، رفض مدخلات).
3. تشغيل اختبارات `node --test source/exchange/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- سيناريوهات المطابقة والإلغاء الأساسية تمر محليًا بشكل حتمي.
- لا آثار جانبية على وحدات قائمة.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/exchange/src/matching-engine.mjs`
  - `source/exchange/test/matching-engine.test.mjs`
- تنفيذ الاختبارات:
  - `node --test source/exchange/test/matching-engine.test.mjs`
- النتيجة: **5 اختبارات ناجحة، 0 فشل** (مطابقة price-time، تنفيذ جزئي/كامل، إلغاء، تحقق مدخلات).
