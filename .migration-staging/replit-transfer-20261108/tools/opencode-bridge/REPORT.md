# التقرير النهائي — ترقية جسر OpenCode ⇄ ChatGPT إلى v0.2.0

التاريخ: 2026-10-22 · المشروع: `C:\Users\Administrator\opencode-bridge`

## 1) الملفات التي تغيّرت

## 2026-11-05 — OpenCode-only WARP Proxy Bridge

Added `src/proxy-manager.js` and three MCP tools: `opencode_proxy_status`, `opencode_proxy_enable`, and `opencode_proxy_disable`. Added isolated tests in `scripts/proxy-manager-test.mjs`, npm scripts, and WARP setup/limitations documentation in README.

Safety boundary: this integration supports only Cloudflare WARP Local Proxy at `127.0.0.1:40000`; requires a TLS-verified HTTPS probe; backs up and edits only `service/OpenCodeAgent.xml`; does not restart services; does not change global proxy/network settings; and never triggers on HTTP 429 or rate-limit errors. Live service XML and services are left untouched during development.


**مصدر الخدمة (`src/`)**
- `server.js` — إعادة كتابة كشكل v0.2.0: خادم MCP بـ 19 أداة مربوطة بالنطاقات، أخطاء صادقة، تقييد معدل/حجم على المسارات الحساسة، تقدّم صادق أثناء الانتظار، سطر `[auth]` للمناولة عند رفض الطلبات (بدون قيم توكن).
- `auth.js` — مزوّد OAuth داخلي: `/.well-known/oauth-authorization-server`، صفحة `/authorize` بكلمة سرّ + مربعات قدرات، `/register` (DCR)، `/token` (code + refresh مع تدوير)، PKCE S256، حفظ refresh tokens في `.auth/tokens.json`.
- `config.js` — إشارات القدرات وSCOPES وتحليل الجذور (جديد).
- `workspace.js` — أسوار الجذور + مقاومة traversal + تحويل مسارات Windows 8.3 + بحث نصي مقصوص (جديد).
- `audit.js` — سجل JSONL في `.audit/audit.jsonl` مع حجب القيم السرية (جديد).
- `screenshot.js` — لقطة شاشة كاملة عبر PowerShell/System.Drawing بحد 4MB (جديد).
- `guards.js` — كاشف الأوامر عالية الخطورة (جديد).
- `opencode.js` — عميل OpenCode: shell (create/get/list/output + انتظار honest)، interrupt، fs write، paging بالـ cursor، `progressSince`، انتظار رد الوكيل.
- `format.js` / `events.js` — transcript مع تبديل عرض التفكير والمرفقات ورموز الخروج؛ ring buffer للأحداث.

**الإعدادات**
- `.env` — إضافة `BRIDGE_ALLOW_WRITE/SHELL/SCREENSHOT`، `BRIDGE_WORKSPACE_ROOTS`، `BRIDGE_SHELL_TIMEOUT/CONFIRM`، `BRIDGE_MAX_REQUEST_BYTES`، `BRIDGE_RATE_LIMIT`، متغيرات OAuth (القيم لا تنشر هنا).
- `.env.example` و `.gitignore` — مثال محدث + تجاهل `.auth/` و `.audit/`.

**السكربتات (`scripts/`)**
- `oauth-test.mjs` — 19 فحصًا جديدًا.
- `core-test.mjs` — 16 فحصًا جديدًا.
- `integration-test.mjs` — 24 فحصًا جديدًا (تكامل حقيقي مع OpenCode).
- `smoke.mjs` — تسجيل دخول OAuth آلي + إصلاح خطأ بادئة `Bearer `.
- `smoke-write.mjs` — جلسة مخصّصة جديدة للكتابة + مهلة عميل SDK صحيحة.

**توثيق**
- `README.md` — إعادة كتابة عربية كاملة للإصدار v0.2.0.
- ملف تشخيصي `_dbg-oauth.mjs` أُنشئ وحُذف بعد حل المشكلة.

## 2) الأدوات الممنوحة لـ ChatGPT (19)

قراءة: `opencode_list_sessions`, `opencode_active_sessions`, `opencode_get_session` (paging + `include_reasoning`), `opencode_session_diff`, `opencode_recent_events`, `opencode_read_file`, `opencode_list_files`, `opencode_find_files`, `opencode_search_text`, `opencode_list_images`, `opencode_get_image` (يعيد كتلة صورة MCP حقيقية).

كتابة/تنفيذ: `opencode_send_message` (ينشئ جلسة جديدة عند عدم تمرير session_id — حماية من تلوث محادثة المستخدم), `opencode_interrupt_session`, `opencode_write_file`, `opencode_edit_file` (يرفض التطابق المتعدد), `opencode_shell_run` (+ `confirm: true` للأوامر عالية الخطورة), `opencode_shell_get`, `opencode_shell_list`, `opencode_screenshot` (يتطلب `confirm: true` دائمًا).

## 3) الاختبارات — النتائج بصدق

| المجموعة | النتيجة الأخيرة | ملاحظات |
|---|---|---|
| `oauth-test.mjs` | **19/19 ✅** | metadata، سرّ خاطئ 401، منطق النطاقات لكل تمنيح، PKCE replay/verifier، 401 + `WWW-Authenticate`، تدوير refresh، DCR، نداء أداة حي |
| `core-test.mjs` | **16/16 ✅** | traversal (.. وأقساط UNC/8.3/أقراص)، منع كتابة خارج الجذور، بحث نصي، حجب الأسرار، أوامر عالية الخطورة، تنسيق transcript، تقصير مخرجات |
| `integration-test.mjs` | **24/24 ✅** (بعد إصلاح واحد) | كل فحص ضد OpenCode حقيقي؛ تاريخيًا فشل فحص `shell_list` ووهّض سلوك API (تس腹泻 أدناه) ثم صُحّح الاختبار والمخطط معًا |
| `smoke.mjs` | **✅ CONNECTED + 11 أداة قراءة** | تاريخيًا فشل 401 بسبب غياب بادئة `Bearer ` — وجد بأداة سجل `[auth]` وعولج |
| `smoke-write.mjs` | **✅ BRIDGE_V2_OK** | جلسة جديدة + رد حقيقي قياب};

**إخفاقات بشرية عُولجت خلال هذا العمل:** (1) فشل `shell_list shows previous runs` — سلوك OpenCode يُخرج الـ shells المكتملة من القائمة سريعًا؛ عدّلنا الأداة والوصف وطبيعة الاختبار بصدق والمكثّر بـ `shell_get` بid. (2) 401 في `smoke.mjs` — رأس Authorization بلا `Bearer `. (3) timeout `-32001` في `smoke-write.mjs` — مهلة عميل SDK كانت 60s بينما `wait_seconds=90`؛ عُدّلت المدة واعتمدنا جلسة مخصّصة بدل حواية محادثة المستخدم. (4) فشلات تزويد نفق trycloudflare (مهل زمنية + 409 Tunnelstore من جهة Cloudflare) — دمجنا حلقة إعادة محاولة حتى نجح النفق.

## 4) الميزات المثبتة فعليًا (end-to-end)

1. اتصال ChatGPT-style SDK عبر MCP Streamable HTTP مع قفل OAuth (PKCE) و401 صامت لغير المهيمن.
2. عرض قوائم الجلسات ورموائها التفصيلية مع ترقيم صفحات (cursor) وعرض التفكير عند الطلب.
3. فيلسوف أحاديث أوامر/أدوات/مخرجات + مرفقات المستخدمان + رموز خروج الشيل.
4. قراءة/كتابة/تعديل ملفات داخل الجذور المسموحة فقط، ورفض صريح لكل هروب مسار (بما فيها مسارات Windows 8.3 والUNC).
5. بحث نصي مقيّد وفي نطاق الجذور (يتجاهل node_modules/.git).
6. شيل صادق: مخرجات + رمز خروج + مهلة تُكشف، وأوامر عالية الخطورة معوّقة بـ `confirm`.
7. لقطات شاشة حقيقية تعيدها كتل صور MCP بعد `confirm: true`.
8. وصول الوكيل حيًا: إرسال رسالة/توجيه، انتظار رد حقيقي، وقف running session.
9. تحديد معدل + حد حجم + حدود الحجم على مخرجات الأدوات.
10. سجل مراجعة JSONL **بلا أسرار** حقيقي (تم التبعية في الملفين core وaudit نفسه).
11. تشغيل النفق HTTPS عبر trycloudflare و/health عبره ناجح ب200 — أي المسار البعيد بعنوان OAuth metadata يعمل.

## 5) حدود ومفارق — بصراحة (غير مدعوم حاليًا)

- `screenshot` تلتقط الشاشة الكاملة فقط (وليس نافذة بعينها) وتحتاج سطح مكتب نشطًا (لا تعمل من جلسة Service) وحد 4MB.
- `opencode_shell_list` تعرض الشغّالَ فقط؛ API OpenCode يخرج المكتملة سريعًا — استعمل `shell_get` بالid.
- عناوين أنفاق trycloudflare المجانية تتبدل بكل إعادة تشغيل للنفق؛ عنوان ChatGPT Overview معه قديم ويحدث.
- access tokens في الذاكرة: إعادة تشغيل الـbridge تتطلب تمنحه من ChatGPT (refresh الدائم الناضج يُعالج الأجل بسرعة عكسية لو مصم يعيد الصفحة).
- على خطط ChatGPT Plus/Pro حدود منفتاحtheir الموديل على أدوات الكتابة؛ أما الواقة الكاملة فتعمل في Business/Enterprise/Edu.
- الصور المُسقاطة `file://` من أدوات الجلسة المتلوية تعُد داخل الجذور فقط؛ لا يوجد scanner PDF/دوك مكاتب.

## 6) خطوات الاتصال الآمن (رفع القيم الحسّية)

1. في `.env`: اضبط `BRIDGE_OAUTH_PASSWORD` (سرّ طويل) و`BRIDGE_WORKSPACE_ROOTS`، وفعّل قد ما تريد فقط
   من `BRIDGE_ALLOW_WRITE/SHELL/SCREENSHOT`. ثم:
   ```powershell
   cd C:\Users\Administrator\opencode-bridge
   npm start
   ```
2. افتح النفق:
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
   ```
   تظهر بالسجل عنوان مثل `https://<عشوائي>.trycloudflare.com` (العنوان الحالي: **burner-departmental-forward-restored**.trycloudflare.com — يتغير مع كل نفق جديد).
3. عنوان MCP الذي تدخله بـ ChatGPT = `<عنوان النفق>` + **قيمة `BRIDGE_PATH`** من بانر التشغيل أو `.env`
   (المسار السري — لا يُطبع هنا). مثال الصيغة: `https://<subdomain>.trycloudflare.com/mcp-<سري-طويل>`.
4. ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → **Create** connector:
   - Authentication = **OAuth**؛ سيفتح ChatGPT صفحة /authorize عبر النفق؛ أدخل السرّ.
   - علّم قدرات في صفحة الضوء community those aren't غفلها، واترك القطعات الغ>>) غير فعّلة.
5. تحقق أن /health عبر النفق يعيد JSON واكتب من من的伤害:
   ```powershell
   node scripts/smoke.mjs          # دخول + القراءة
   node scripts/smoke-write.mjs    # الكتابة (يجلس جلسة خاصة ويرد BRIDGE_V2_OK)
   ```
6. اضبط النفق/النفاية يدويًا كي تعيش بعد كل إعادة تشغيل للجهاز (النفق + `npm start`).

> لا تشارك عنوان الـ MCP الكامل ولا سرّ /authorize. أي تسريب؟ غيّر `BRIDGE_PATH` و`BRIDGE_OAUTH_PASSWORD` وأعد التشغيل.

## 7) الخدمات التلقائية (25-10-2026)

منفّذ كطلبات المستخدم الثلاثة: رابط + تشغيل تلقائي + أسماء نظامية.

- **خدمات ويندوز دائمة عبر WinSW 2.12** (بجانب محاولات nssm السابقة — nssm 2.24 أظهر تعلّفات في
  مسارات إيقاف/restart فاستُبدل بـ WinSW بمقاطعات تنفيذ مباشرة):
  `OpenCodeAgent` (خلفية OpenCode على 45278)، `OpenCodeBridge` (الجسر v0.2.0)،
  `OpenCodeTunnel` (نفق HTTPS) — بدء Automatic (Bridge/Tunnel delayed)، إعادة تلقائية عند الخروج
  (onfailure restart)، وسجلات تُدوَّر تلقائيًا تحت `.service\`.
- حالة التحقق بعد التبديل: الثلاثة Running، إعادة تشغيل Bridge/Tunnel عبر
  `Restart-Service` = **~1.1 ثانية** لكل منهما بدون تعليق؛ `/health` محلي وعبر النفق 200.
- محدودية سابقة صُحّحت مع هذا السبب: لفّات `cmd.exe` كانت ترفض رسائل إيقاف الخدمة، فظهرت
  STOP_PENDING و502 متقطعًا عندما تزامن مع جولة اكتشاف ChatGPT — تخلّينا عنها كليًا.
- لفّات المناولة القديمة (cmd/ps1) التي كانت تعلّق في الإيقاف حُذفت كليًا؛ التعريف الحقيقي
  في `service\*.xml` + النسخ التنفيذية `service\*.exe` (كلها مربوطة من `WinSW-x64.exe`).

## 8) الرابط الدائم (25-10-2026) — غيّر العنوان لهذا فقط

- المستخدم سجّل في Cloudflare (`cloudflared tunnel login`) على منطقته **sageswap.dpdns.org**.
- أنشأت نفقًا مسمّى `opencode-agent` (معرّف `c212147a-15c5-470a-b628-6f86fcec47b8`) وربطته بـ DNS:
  `mcp.sageswap.dpdns.org` (CNAME → cfargotunnel، proxied).
- خدمة `OpenCodeTunnel` صارت تشغّل `cloudflared tunnel run --url http://127.0.0.1:8787 opencode-agent`
  — العنوان **ثابت عبر الإقلاعات**، و`tunnel-url.txt` يحفظه.
- تحقق بالفاعل عبر HTTPS الدائم: `/health` = **200** (مرتين)،
  `/.well-known/oauth-authorization-server` = 200 مع issuer `https://mcp.sageswap.dpdns.org`،
  نداء MCP بلا توكن = **401 مع WWW-Authenticate** — أي مسار ChatGPT كامل وعلى الرابط الدائم.
- درس مكتسب معوى: `cloudflared tunnel run` **بدون** `--url` يعيد 503 فارغًا لكل طلب وسيطًا
  متصلًا (يوجد في السجل Invalid ingress) — تم إدخال `--url` في الخدمة.
- ملاحظة صيانة اختيارية: ملف تسجيل الدخول `~\.cloudflared\cert.pem` ظهرت قيمه في نافذة
  الطرفية أثناء العمل — يُعاد توليده بسهولة بمسّ `cloudflared tunnel login` متى شئت.

## 9) حُلّ لغز "Authentication succeeded, action discovery failed" (25-10-2026)

- **الدليل من سجل الجسر:** المصادقة نجحت كاملًا (`authorize page` → `authorize complete OK`
  → `token code OK`) ثم أرسل ChatGPT `POST /` — إلى **جذر النطاق** لا للمسار السري — فوقعت 404.
  عميل ChatGPT يرسل طلبات MCP دائمًا إلى جذر النطاق ويهمل المسار الفرعي؛ المصادقة لم تكن مشكلة إطلاقًا.
- **الإصلاح:** الجسر يخدم الـMCP في **`/` + المسار السري** كليهما (تحدي 401 بلا رمز يبقى حاجزًا
  في المكانين)، مع مستعار `/.well-known/openid-configuration` للاكتشاف الاحتياطي، وتغطية
  حد السرعة وفحص حجم الطلب للجذر أيضًا.
- **بنية تشخيص أضيفت معه:** سجل دائم مقروء `.service\bridge-console.log` بتوقيت UTC لكل سطر
  (مخرجات WinSW الخام يدوِّرها داخل مجلد `win-sw-bridge.log\` ولا يبقّي سوى أسطر قليلة)،
  وإثراء سطري `[auth]`/`[http]` بـ المسار/المضيف/IP/UA/حالة الرمز، وسجل OAuth كامل
  (register/authorize/complete/token/refresh) **بدون طباعة أي قيمة حساسة**.
- **التحقق النهائي بالفاعل:** `oauth-test` = **19/19** بعد الإصلاح؛ ثم اتصل ChatGPT فعليًا عبر
  الرابط الدائم: `POST / → ok(cfg_...)` + فتح جلسة MCP (mcp:read mcp:write bridge:shell
  bridge:screenshot) + دفق SSE بمعرّف جلسة → ok. رسالة ChatGPT: **"Primary is now connected"**.

## 10) عطلة 28-10: اختفاء Node.js وإعادة بناء الحصانة (28-10-2026)

- **الجسر خدم 3 أيام كاملة** (25→27 أكتوبر) بلا أي غلطة — آخر طلب ناجح 22:46 ثم إطفاء الجهاز.
- **27-10 05:46**: Windows Installer أزال **Node.js v24.9.0** (سجلات MsiInstaller id=1034/11724؛
  سبب الإزالة غير معروف — لا نية منا). العملية الحية بقيت تعمل لأن الملفات المفتوحة تبقى
  متاحة حتى الإغلاق، فالجسر استمر خدمة طوال يوم 27.
- **28-10 00:17 إقلاع الجهاز** → الخدمة طلبت `C:\Program Files\nodejs\node.exe` → **غير موجود**
  (Win32Exception 2) → فشل بدء (SCM 7023)، وSCM لا يعيد محاولة البدء تلقائيًا → الخدمة بقيت
  واقفة ~30 ساعة → 502 عبر النفق لكل شيء.
- **الإصلاح:** تثبيت **Node.js v24.22.1 LTS (Krypton)** x64 بصمت (`msiexec /qn`) → بدء الخدمة
  → `/health` محلي وعبر الرابط الدائم 200، والجسر ربط OpenCode v2.1.2، و`oauth-test` =
  **OAUTH FLOW OK** (مع الحيلة: متغير بيئة `BASE` عالق في شلّات الجلسة يشوّه الاختبار —
  تُضبط يدويًا إلى `http://127.0.0.1:8787`).
- **حصانة جديدة ضد تكرار هذا النمط:**
  1. إجراءات استرجاع SCM لكل خدمة (`sc.exe failure`): إعادة تشغيل بعد 10/30/60 ثانية،
     تصفير العدّاد يوميًا (reset= 86400).
  2. مهمة مجدولة **"OpenCode Services Revive"** (ONSTART، SYSTEM، تأخير 1:30) تشغّل
     `service\revive-services.ps1` وتضمن أن الخدمات الثلاث شغالة بعد كل إقلاع؛ سجلها
     `.service\revive.log`.
  3. **حارس كل ساعة "OpenCode Services Watchdog"** (نفس السكربت): في 02-11 اكتُشف أن النفق
     والوكيل توقفا **بصمت** بعد الإقلاع (إيقاف نظيف بلا أي حدث عطل في SCM — سبب مجهول)؛
     النفق أعيد تشغيله فورًا والرابط الدائم عاد 200. الحارس يعيد أي خدمة متوقفة خلال أقل
     من ساعة، ويتخطى الوكيل إذا كان أي opencode خدامًا على 45278 (يدويًا أو كخدمة).
- ملاحظة صيانة: `Get-Command node` قد يظل فارغًا في شلّات قديمة فُتحت قبل التثبيت —
  استخدم المسار المطلق `C:\Program Files\nodejs\node.exe`.
