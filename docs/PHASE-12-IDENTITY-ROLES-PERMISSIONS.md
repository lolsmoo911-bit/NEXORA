# Phase 12 — الهوية والصلاحيات (Identity, Roles & Permissions - Local)

> **الحالة:** قيد التنفيذ (بدون تكلفة، محلي/اختباري)  
> **المرجع:** [ZERO-COST-DEV-PLAN.md](./ZERO-COST-DEV-PLAN.md)

## 1. الهدف
توفير طبقة هوية وصلاحيات محلية (RBAC) لحماية العمليات الحساسة وتسجيلها، بدون بنية هوية مدفوعة.

## 2. النطاق
### داخل النطاق
- وحدة `source/auth/src/rbac.mjs`.
- أدوار افتراضية: `admin`, `operator`, `trader`, `viewer`, `auditor`.
- سياسات/صلاحيات للعمليات (أصول، أسعار، تداول، محافظ، إدارة).
- تدقيق (audit log) للقرارات/العمليات الإدارية الحساسة.
- اختبارات Node.

### خارج النطاق
- SSO/OAuth/MFA إنتاجي
- إدارة مفاتيح/هويات خارجية
- تخزين تدقيق موزع

## 3. التصميم المقترح
- `createRbacService()` يدير المستخدمين/الأدوار/السجلات.
- `assignRole(userId, role)` / `revokeRole`
- `can(userId, permission)` و`authorize(userId, permission, context?)`
- سجل تدقيق: `{ timestamp, actorId, action, permission, allowed, context }`

## 4. خطة التنفيذ
1. إنشاء الوحدة والاختبارات.
2. تنفيذ RBAC + audit log.
3. تشغيل `node --test source/auth/test/*.mjs`.
4. تحديث التقدم والوثائق ودفع التغييرات.

## 5. معيار القبول
- الصلاحيات تُفرض حسب الأدوار.
- العمليات الحساسة تُسجّل في سجل التدقيق.
- الاختبارات تمر محليًا.
