# Phase 13 — سير عمل إصدار الأصول (Asset Issuance Workflow)

> **الحالة:** قيد التنفيذ (بدون تكلفة، محلي/اختباري)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
تنفيذ سير عمل محلي متكامل لإصدار أصل تمثيلي (محاكاة) من التعريف إلى التفعيل، مع فحوصات تحقق.

## 2. النطاق
### داخل النطاق
- وحدة `source/workflows/src/asset-issuance.mjs`.
- تدفق:
  1. تعريف الأصل (draft) والتحقق من المدخلات
  2. تسجيل/ربط الهوية (AID/reference) محليًا
  3. إنشاء/ربط تمثيل رمزي محاكى (metadata/linkage)
  4. بوابات تحقق (validation gates)
  5. تفعيل الأصل للتداول المحاكى
- قوالب metadata مبسطة لفئات الأصول المستهدفة.
- اختبارات Node.

### خارج النطاق
- إصدار قانوني/وصاية حقيقية
- نشر عقود إنتاجي على شبكة عامة
- موافقات تنظيمية

## 3. التصميم المقترح
- `createAssetIssuanceWorkflow({ coreApi, rbac? })`
- خطوات/واجهات:
  - `createDraft(...)`
  - `registerIdentity(...)`
  - `linkRepresentation(...)`
  - `validate(...)`
  - `activate(...)`
  - `issueAsset(...)` (تنفيذ متسلسل مع تقرير نتيجة)
- حالات: `draft`, `identity_registered`, `representation_linked`, `validated`, `active`, `rejected`

## 4. خطة التنفيذ
1. إنشاء الوحدة والاختبارات.
2. تنفيذ سير العمل والقوالب وفحوصات التحقق.
3. تشغيل `node --test source/workflows/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- إصدار أصل تجريبي محليًا من draft إلى active مع سجل خطوات.
- فشل الفحوصات يمنع التفعيل بشكل صحيح.
- الاختبارات تمر محليًا.
