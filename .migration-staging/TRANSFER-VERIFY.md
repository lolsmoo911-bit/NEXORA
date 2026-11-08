# TRANSFER-VERIFY — NEXORA (replit-transfer-20261108)

**staging only — لم يتم دمج أو نقل أو حذف أي ملف**
- شُيّد: 2026-11-08
- المصدر: https://github.com/lolsmoo911-bit/NEXORA.git @ `replit-transfer-20261108`
- الموقع: `/home/runner/workspace/.migration-staging/replit-transfer-20261108`
- التقرير نفسه يقع خارج الـ clone: `/home/runner/workspace/.migration-staging/TRANSFER-VERIFY.md`
- OpenCode/Replit محمية كما هي: `opencode v2.2.6`, `.replit`, `.config/opencode`, `.local/share/opencode/opencode.db` (33157120 bytes), service `http://127.0.0.1:49374` — كلها لم تُمس
- لا تثبيت حزم، لا أنفاق، لا Cloudflare، لا تعديل خدمات

## 1) HEAD والتحقق

| البند | القيمة |
|---|---|
| branch | `replit-transfer-20261108` |
| HEAD | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` — ✅ مطابق للمتوقع |
| tree | `9a65b4691784931ec0279927a49f3036af9469b3` |
| log[-1] | `ffef93b testnet: epoch 605 - height 32, cumulative 19348 blocks, app_hash E6BE368D9FDEC52B...` |
| log[-2] | `0b3b41f chore: stage safe NEXORA migration snapshot for Replit` (هذا الـ HEAD) |
| status | `## replit-transfer-20261108...origin/replit-transfer-20261108` — **نظيف** |
| untracked | **لا يوجد** |
| remote | `origin https://github.com/lolsmoo911-bit/NEXORA.git` |

## 2) المسارات المطلوبة

| المسار | الخالة |
|---|---|
| `source/bridge/` | ✅ موجود (bridge.test.mjs + 4 اختبارات) |
| `tools/opencode-bridge/` | ✅ موجود (src + scripts) |
| `tools/proxy-grabber/` | ✅ موجود (proxy_grabber.py + اختبارات) |
| `tools/cloudflare-edge/` | ✅ موجود (package.json + src/test) |
| `tools/secure-file-handoff/` | ✅ موجود (handoff.py + tests) |
| `apps/` | ✅ `apps/market-data-hub` |
| `docs/` | ✅ 13 ملفاً |

## 3) عدد وحجم الملفات المتتبعة فعلياً (مصحح)

| البند | القيمة الفعلية |
|---|---|
| `git ls-files \| wc -l` | **374** |
| التوزيع | source 285, tools 42, apps 30, docs 13, scripts 1, روت (README/opencode.json/.gitignore) 3 |
| مجموع tracked (sum wc -c) | **3,647,931 bytes** (~3.5MB) |
| حجم الـ clone (du -sh `.`) | 6.7M (يشمل `.git`) |
| `docs/MIGRATION-SNAPSHOT-MANIFEST.json` | 126K, `included_file_count: 489`, `included_bytes: 7469022` |

### التناقض في الـ Manifest (لم يُعدل)

- الـ Manifest يسجل: `branch: replit-migration-staging` + `base_commit: ffef93b` + `created_utc: 2026-11-07` + **489 ملفاً / 7,469,022 bytes**.
- الفرع المرحلي الفعلي: **374 ملفاً / 3,647,931 bytes** — أي أن الـ Manifest يعود لفرع/إصدار أقدم ولا يصف هذا الفرع 1:1.
- تفصيل هام:
  - `tracked not in manifest`: **2** فقط (`.gitignore`, `docs/MIGRATION-SNAPSHOT-MANIFEST.json` — طبيعي).
  - `manifest listed missing on disk`: **117** ملفاً! معظمها `source/contracts/lib/forge-std/**` (submodule غير مُهيأ في clone) + `apps/market-data-hub/var/last-fetch.json`. هذا يعني أن الفرع **لا يحمل forge-std** هنا (contracts/foundry.toml + src/test موجودة، لكن `lib/` غير موجودة).
- النتيجة: لا تعتمد على Manifest counts — الرقم الموثوق هو **374 / 3,647,931 bytes**.

## 4) Testnet ledger/state — الفرع vs GitHub main

| البند | فرع `replit-transfer-20261108` (staging) | GitHub `main` الحالي |
|---|---|---|
| ledger epoch | **605** | **627** |
| cumulativeBlocks | 19348 | 20052 |
| height | 32 | 32 |
| app_hash | `E6BE368D9FDEC52B...` | `DAA4C4D942BB6F4F...` |
| commit | `ffef93b` (epoch 605) | `b61acba` (epoch 627) |
| مسار الملفات | `source/testnet/{ledger,state}.json` (222K/46K) | `testnet/{ledger,state}.json` (روت) |
| تأخر | **22 epoch** | — (الأحدث) |
| الفرق | — | +22 epoch (`3e87763`→`b61acba`، heights متطابقة، app_hash غير مطابق) |

- تم التحقق بـ `git fetch origin main` (بدون checkout العمل). **لم تُستبدل أي ملفات Testnet.**

### hashes (الملفات المرحلية)

```
7bb6de6fa778d4431cee66c0fcbaa595c8ce611dfee072e8dac18f591170c455  source/testnet/state.json
bc8b62ec14ec058888220ede05e115af1d7965e0b786f5be4cf3070617412ef1  source/testnet/ledger.json
10e976fdbb42b724e97f445cd81d3147b3dbd24c0be7dfa5d36ea28ed220d46b  docs/MIGRATION-SNAPSHOT-MANIFEST.json (repofile itself)
```

## 5) اختبارات خفيفة (بدون تثبيت، بدون لمس خدمات)

### 5.1 `source/bridge` — ✅ ناجح كاملاً

- `package.json`: zależności **`dependencies: {}`** — لا يعتمد على أي حزمة.
- نفذ: `node --test test/*.test.mjs`
- **النتيجة: 76 pass, 0 fail** (duration ~358ms).

### 5.2 `tools/opencode-bridge` — ⚠️ نجاح جزئي (بيئي، مُفسّر)

- نفذ: `node scripts/core-test.mjs`
- **النتيجة: 14 passed, 2 failed**
- الفاشل: `withinRoots rejects drive escapes (C:/..)` + `withinRoots rejects UNC paths` — **اختبارات Windows-path على Linux** (لا يثير exceptions في بيئة Replit Linux) — ليس انكسار منطق، عيب بيئة.
- `test:proxy` / `integration-test` **لم تُنفذ** لأنها تتطلب dependencies (`@modelcontextprotocol/sdk`، `@opencode/client`، `zod`) — التثبيت ممنوع في هذه المرحلة.

### اختبارات لم تُنفذ (عمداً)

- `tools/proxy-grabber/test_proxy_grabber.py` — يتطلب pytest/controlller (لا تُثب ولا تُشغ الأنفاق الآن).
- `tools/cloudflare-edge/test`, `tools/secure-file-handoff/tests` — تُراجعات في مرحلة لاحقة.

## 6) مخاطر / نواقص

| الخطورة | البند |
|---|---|
| 🔴 | **testnet الفرع متأخر 22 epochs** عن main (605 vs 627) — أي دمج مستقبلي يحتاج rebase/lag-merge وإعادة فحص ledger |
| 🟡 | **Manifest stale** (489 vs 374) — لا يُعتمد عليه كمرجع counts؛ يحتاج توليد جديد من الفرع الحالي |
| 🟡 | **`source/contracts/lib/forge-std` غير موجودة** في الـ clone (lib/ غير معروضة، 117 ملف مفقود من_manifest) — بناء contracts قد يفشل |
| 🟡 | **اختلاف المسارات** — الفرع يستخدم `source/testnet/` بينما main يستخدم `testnet/` روت — خطر تصادم تخطيط في الدمج |
| 🟡 | **اختبارات `tools/opencode-bridge` فائتة على Linux (Windows paths)** — 2 failed بيئية |
| 🟡 | **اختبارات tools/` تتطلب deps** — لم تُثب ولا تُشغ |
| 🟢 | OpenCode/Replit لم تُمس — staging معزول في `.migration-staging/` |
| 🟢 | الـ clone نظيف، HEAD **مطابق تماماً** |

## 7) ما لم يتم تنفيذه (التزام)

- ❌ لا دمج إلى جذر workspace، لا نقل من staging
- ❌ لا حذف/استبدال أي ملف حالي، لا تعديل Manifest
- ❌ لا تثبيت حزم، لا تعديل خدمات، لا أنفاق/Cloudflare
- ❌ لم تُستبدل ملفات Testnet، لم تُعدل DB، لم تُعدل `.replit`

**خلاصة: الاستيراد المرحلي والتحقق اكتملا — الفرع سليم ونظيف وHEAD مطابق، لكنه متأخر 22 epoch وManifest stale، وsubmodule forge-std غير مهيأ. بانتظار تعليقك قبل أي دمج.**
