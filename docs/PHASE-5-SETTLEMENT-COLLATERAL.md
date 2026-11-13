# Phase 5 — نموذج التسوية والضمان (Settlement & Collateral Model - Simulated)

> **الحالة:** ✅ مكتملة (محلي/اختباري، بدون تكلفة)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
نمذجة التسوية والضمان بشكل **محاكى** (بدون أصول/مدفوعات حقيقية) لدعم تدفقات التداول والتمثيل في المراحل اللاحقة:
- حالات تسوية واضحة: `Pending`, `Matched`, `Settled`, `Failed`, `Cancelled`
- دفتر التزامات/ضمان افتراضي (virtual collateral)
- قواعد انتقال حالة وآليات تحرير/خصم الضمان (محاكاة)

## 2. النطاق
### داخل النطاق
- عقد Solidity اختباري لإدارة حسابات ضمان افتراضية وتسويات محاكاة.
- دعم:
  - إيداع/سحب ضمان افتراضي (داخل النموذج المحاكى)
  - إنشاء التزام/تسوية (settlement intent) وحجز الضمان
  - انتقالات حالة (match/settle/fail/cancel) مع تأثيرات على الضمان المحجوز
  - صلاحيات مشغل (operator/admin) للعمليات التشغيلية
- اختبارات Foundry للحالات الأساسية والسلبية.

### خارج النطاق
- تسوية أصول/نقود حقيقية أو تكامل مصرفي/حفظ
- تصفية إنتاجية معقدة أو تغذية مخاطر حية
- ربط مباشر بمحرك مطابقة كامل (يُدمج لاحقًا عبر الواجهات)

## 3. التصميم المقترح

### العقد: `SimulatedSettlement.sol`
**المفاهيم:**
- **Collateral account:** رصيد افتراضي متاح + محجوز لكل حساب.
- **Settlement record:** معرف، أطراف (payer/payee أو طرفي تداول)، مبلغ/قيمة محاكاة، مبلغ ضمان محجوز، حالة، بيانات مرجعية (asset/ref hash).

**الحالات:** `None, Pending, Matched, Settled, Failed, Cancelled`

**الوظائف الأساسية (مقترحة):**
- إدارة: تعيين/إزالة مشغل
- ضمان: `depositCollateral`, `withdrawCollateral` (من المتاح فقط)
- تسوية: `createSettlement`, `matchSettlement`, `settleSettlement`, `failSettlement`, `cancelSettlement`
- قراءة: getters للأرصدة والتسويات

**قواعد انتقال الحالة (مبدئية):**
- `None -> Pending` (إنشاء)
- `Pending -> Matched | Cancelled | Failed`
- `Matched -> Settled | Failed | Cancelled` (حسب السياسة)
- الحالات النهائية: `Settled`, `Failed`, `Cancelled`

**سياسة الضمان (محاكاة مبسطة):**
- عند الإنشاء/المطابقة (حسب التصميم): حجز ضمان من الطرف المطلوب.
- عند `Settled`: تحرير الضمان المحجوز (أو تحويله محاكيًا ضمن الدفتر) حسب النموذج.
- عند `Failed/Cancelled`: تحرير الضمان المحجوز إلى المتاح.

## 4. خطة التنفيذ
1. إنشاء `source/contracts/src/SimulatedSettlement.sol`.
2. إنشاء `source/contracts/test/SimulatedSettlement.t.sol`.
3. تشغيل `forge test` في `source/contracts` والتحقق من عدم وجود تراجعات.
4. تحديث تقدم الخطة والوثائق ودفع التغييرات.

## 5. معيار القبول
- العقد والاختبارات يمران محليًا.
- انتقالات الحالة وقواعد الضمان المحجوز/المتاح صحيحة للحالات المغطاة.
- لا تأثير سلبي على العقود والاختبارات القائمة.


## 6. نتائج التحقق
- تمت إضافة:
  - `source/contracts/src/SimulatedSettlement.sol`
  - `source/contracts/test/SimulatedSettlement.t.sol`
- تنفيذ الاختبارات:
  - `PATH="/home/runner/workspace/.foundry/versions/foundry-rs/foundry/v1.8.5:$PATH" forge test` (داخل `source/contracts`)
- النتيجة: **133 اختبارًا ناجحًا، 0 فشل** (6 suites)، بما في ذلك اختبارات `SimulatedSettlement` الجديدة.
