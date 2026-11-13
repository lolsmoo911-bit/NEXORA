# Phase 4 — عقود تمثيل الأصول (Tokenization Primitives, Local/Test)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ بدائل عقود أولية لتمثيل الأصول (test-only) تدعم:
- إصدار/حرق/نقل وحدات تمثيلية (fungible baseline)
- ضوابط أدوار (admin, minter, pauser)
- حالات تشغيل (active/paused)
- ربط بيانات وصفية أساسية بالأصل (AID/asset metadata reference)

## 2. النطاق (هذه المرحلة)
### داخل النطاق
- عقد ERC-20 تمثيلي مبسط (بدون اعتماديات خارجية) مع:
  - `mint`, `burn`, `transfer`, `approve`, `transferFrom`
  - `pause/unpause` يمنعان النقل/السك/الحرق حسب السياسة
  - إدارة أدوار أساسية
  - تخزين مرجع الأصل: `aid`, `assetClass`, `metadataURI`/hash (اختياري)
- اختبارات Foundry تغطي المسارات الأساسية والحالات السلبية.

### خارج النطاق
- إصدار مرتبط باحتياطي حقيقي أو استرداد قانوني
- آليات KYC/AML أو قيود تنظيمية
- حوكمة إنتاجية/ترقيات عقود
- تكامل تداول/مطابقة/تسوية كامل (يأتي في مراحل لاحقة)

## 3. التصميم المقترح

### العقد: `AssetToken.sol` (Fungible Representational Token)
**الحقول الأساسية:**
- `name`, `symbol`, `decimals`
- `totalSupply`
- `aid` (bytes32), `assetClass` (string/bytes32), `metadataURI` (string)
- `admin`, أدوار minter/pauser (mapping)
- `paused`

**الوظائف الأساسية:**
- أدوار: `setMinter`, `setPauser`, `transferAdmin`
- تحكم: `pause`, `unpause`
- رمزية: `mint`, `burn`, `transfer`, `approve`, `transferFrom`
- قراءة: getters للأرصدة والسماحات والبيانات الوصفية

**الأحداث:**
- `Transfer`, `Approval`
- `Paused`, `Unpaused`
- `RoleUpdated` (أو أحداث مخصصة لكل دور)
- `AssetMetadataUpdated` (اختياري عند التهيئة/التحديث المسموح)

### اعتبارات الأمان/الاتساق (test-only)
- فحوصات الصلاحيات الصارمة للسك/الحرق/الإيقاف.
- منع عمليات السك/النقل عند الإيقاف (حسب السياسة المحددة).
- فحوصات underflow/overflow relying on Solidity ^0.8.x.
- عدم وجود سلوكيات مخفية أو اعتمادات خارجية.

## 4. خطة التنفيذ
1. إنشاء `source/contracts/src/AssetToken.sol`.
2. إنشاء `source/contracts/test/AssetToken.t.sol` مع تغطية:
   - نشر وتهيئة metadata
   - mint/burn بصلاحيات صحيحة/خاطئة
   - transfer/approve/transferFrom
   - pause/unpause وتأثيرها
   - إدارة الأدوار والصلاحيات
3. تشغيل اختبارات العقود ذات الصلة محليًا (`forge test`).
4. تحديث تقدم الخطة ودفع التغييرات.

## 5. معيار القبول
- العقد يترجم ويجتاز اختبارات Foundry المضافة.
- المسارات الأساسية والحالات السلبية المغطاة تمر محليًا.
- لا تغييرات على سلوك العقود القائمة خارج نطاق المرحلة.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/contracts/src/AssetToken.sol`
  - `source/contracts/test/AssetToken.t.sol`
- تنفيذ الاختبارات:
  - `PATH="/home/runner/workspace/.foundry/versions/foundry-rs/foundry/v1.8.5:$PATH" forge test` (داخل `source/contracts`)
- النتيجة: **118 اختبارًا ناجحًا، 0 فشل** (5 suites)، بما في ذلك اختبارات `AssetToken` الجديدة.
