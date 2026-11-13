# Phase 6 — طبقة الأوراكل المحاكاة (Mock Oracle & Price Feeds)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
توفير تغذية أسعار/بيانات محاكاة محلية (بدون مزودين مدفوعين) لاستهلاكها من العقود والخدمات، مع دعم:
- تسجيل/تحديث أسعار لأصول متعددة
- صلاحيات مُحدّثين (feeders/operators)
- بيانات جودة/حداثة السعر (timestamp, freshness window, status flags مبسطة)
- قراءة حتمية للأسعار الأخيرة

## 2. النطاق
### داخل النطاق
- عقد Solidity اختباري `MockOracle.sol`.
- وظائف:
  - إدارة feeders/admin
  - تعيين/تحديث سعر أصل (`assetId`/key)
  - تخزين `price`, `decimals` (أو scale ثابت)، `timestamp`, `sourceRef`
  - استعلام السعر والحالة (fresh/stale بناءً على نافذة قابلة للضبط لكل أصل أو عامة)
- اختبارات Foundry.

### خارج النطاق
- أوراكل إنتاجي، توقيعات خارجية، تجميع لامركزي
- بيانات سوق حية مدفوعة
- مقاومة كاملة لهجمات MEV/التلاعب على الشبكات العامة

## 3. التصميم المقترح

### العقد: `MockOracle.sol`
- `admin` + `feeders` mapping
- `maxStaleness` (افتراضي) أو per-feed config (مبسط: عالمي + اختياري override لاحقًا؛ هذه المرحلة عالمي)
- لكل feed (bytes32 assetKey):
  - `price` (uint256)
  - `updatedAt` (uint64)
  - `exists` (bool)
  - `decimals` (uint8)
  - `sourceRef` (bytes32/string hash)

**واجهات مقترحة:**
- `setFeeder(address,bool)`
- `setMaxStaleness(uint256)`
- `pushPrice(bytes32 assetKey, uint256 price, uint8 decimals, bytes32 sourceRef)`
- `getPrice(bytes32 assetKey) -> (price, decimals, updatedAt, isFresh)`
- `getFeed(bytes32 assetKey) -> struct`

**قواعد:**
- السعر > 0
- تحديث فقط من feeder/admin
- `isFresh = (block.timestamp - updatedAt) <= maxStaleness`

## 4. خطة التنفيذ
1. إنشاء `source/contracts/src/MockOracle.sol`.
2. إنشاء `source/contracts/test/MockOracle.t.sol`.
3. تشغيل `forge test` في `source/contracts`.
4. تحديث الخطة/الوثائق ودفع التغييرات.

## 5. معيار القبول
- دعم تحديثات متعددة الأصول وصلاحيات feeders.
- حساب freshness بشكل صحيح.
- جميع الاختبارات الجديدة والقائمة تمر محليًا.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/contracts/src/MockOracle.sol`
  - `source/contracts/test/MockOracle.t.sol`
- تنفيذ الاختبارات:
  - `PATH="/home/runner/workspace/.foundry/versions/foundry-rs/foundry/v1.8.5:$PATH" forge test` (داخل `source/contracts`)
- النتيجة: **143 اختبارًا ناجحًا، 0 فشل** (7 suites)، بما في ذلك اختبارات `MockOracle` الجديدة.
