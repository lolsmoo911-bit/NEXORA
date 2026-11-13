# Phase 7 — تكامل Market Core مع خدمة التسعير (Pricing Service Integration)

> **الحالة:** قيد التنفيذ (بدون تكلفة، محلي/اختباري)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تغليف قدرات `source/market` في واجهة خدمة تسعير/تقييم داخلية موحدة للاستخدام من طبقات السيرفر (محاكاة محلية)، مع دعم:
- مدخلات موحدة للأدوات/السيناريوهات المدعومة
- استهلاك أسعار/مدخلات من مصادر محاكاة (Mock Oracle-like payloads)
- مخرجات تقييم حتمية وقابلة لإعادة الإنتاج

## 2. النطاق
### داخل النطاق
- وحدة خدمة في `source/market/src/pricing-service.mjs` (أو ما يعادلها ضمن الحزمة).
- واجهات لتقييم:
  - سندات (bond analytics: dirty/clean/yield/curve/z-spread عند توفر المدخلات)
  - FX (spot/forward/cross/triangle diagnostics)
  - سيناريوهات كريبتو (shocks/quantiles)
  - محاكاة سوق مركبة (`runMarketSimulation`) عبر مدخل خدمة موحد
- تطبيع مدخلات أسعار من شكل Oracle (`price`, `decimals`, `updatedAt`, `isFresh`) إلى قيم رقمية قابلة للاستخدام.
- اختبارات Node (`source/market/test`) تغطي المسارات الأساسية والتحقق من المدخلات.

### خارج النطاق
- تغذية أسعار حية حقيقية أو اتصال مزودي بيانات خارجيين
- APIs HTTP (تأتي في Phase 11)
- محرك تداول/محافظ كامل (Phases 8/9)

## 3. التصميم المقترح

### واجهات مقترحة
- `normalizeOraclePrice(feed, { requireFresh?, scale? }) -> number`
- `valueBond(input) -> { outputs... }`
- `valueFx(input) -> { outputs... }`
- `valueCrypto(input) -> { outputs... }`
- `valueMarketScenario(input) -> { outputs... }` (غلاف لـ `runMarketSimulation`)
- `priceAsset(request)` كموزع موحد حسب `assetType`/`kind`

### مبادئ
- حتمي، بدون شبكة، بدون اعتماد على وقت النظام باستثناء الحقول الممررة صراحة.
- أخطاء تحقق واضحة للمدخلات غير الصالحة.
- إعادة استخدام وحدات market core الحالية دون تكرار منطق التسعير.

## 4. خطة التنفيذ
1. إضافة وحدة خدمة التسعير وتصديرها من `source/market/src/index.mjs`.
2. إضافة اختبارات `source/market/test/pricing-service.test.mjs`.
3. تشغيل اختبارات market ذات الصلة والتحقق من عدم وجود تراجعات.
4. تحديث الخطة/الوثائق ودفع التغييرات.

## 5. معيار القبول
- واجهة خدمة موحدة تعمل على المدخلات المدعومة وتعيد مخرجات حتمية.
- دعم تطبيع مدخلات أسعار على نمط Oracle محاكى.
- اختبارات market تمر محليًا.
