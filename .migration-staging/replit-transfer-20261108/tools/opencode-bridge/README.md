# OpenCode ⇄ ChatGPT Bridge (v0.2.0)

جسر **MCP** (Streamable HTTP + OAuth) يفتح OpenCode لـ ChatGPT بشكل **آمن**:

- يرى الجلسات (الجارية والقديمة) والـ transcript الكامل مع تعاظم الـ paging.
- يعرض ما ينفّذه الوكيل (Shell/Tools/Files) وملفاته.
- يمنح قدرات اختيارية: كتابة ملفات، تشغيل أوامر، لقطات شاشة.
- **قراءة فقط افتراضيًا**، مع أسوار: OAuth + نطاقات (scopes) + جذر عمل مقصوص + سجل مراجعة.

```
ChatGPT (Web, Developer mode → Create connector)
        │  HTTPS + MCP Streamable HTTP + OAuth 2.1 (PKCE)
        ▼
cloudflared tunnel  →  Bridge (Node, 127.0.0.1:8787)   ← هذا المشروع
                         ├─ OAuth AS داخلي (صفحة سرّ + DCR + refresh tokens)
                         ├─ نطاقات ومربعات قدرات (mcp:read/write, bridge:shell/screenshot)
                         ├─ حجز مسار سرّي + rate limit + حد حجم الطلب
                         └─ سجل مراجعة .audit/audit.jsonl (بلا أسرار)
        ▼
OpenCode background service (يكتشفه تلقائيًا من ~/.local/state/opencode/service.json)
```

## المتطلبات

| المتطلب | ملاحظة |
|---|---|
| Node.js 22+ | مثبت |
| OpenCode V2 | الخدمة الخلفية تعمل، أو ضبط `OPENCODE_URL` و `OPENCODE_PASSWORD` |
| ChatGPT Web + Developer mode | واجهة الـ connector تدعم OAuth أيضًا |
| نفق HTTPS | `cloudflared tunnel --url http://127.0.0.1:8787` (ChatGPT لا يلمس localhost) |

## الأدوات (19 أداة، مربوطة بالنطاقات)

قراءة (`mcp:read` — التخ кадري):

| الأداة | الوظيفة |
|---|---|
| `opencode_list_sessions` | قائمة الجلسات |
| `opencode_active_sessions` | ما يشتغل الآن |
| `opencode_get_session` | أرشيف الرسائل + مخرجات الأدوات، `cursor` للصفحات، `include_reasoning` لعرض تفكير الموديل |
| `opencode_session_diff` | الملفات التي تغيّرت في الجلسة |
| `opencode_recent_events` | أحداث حية (tool calls، permissions، shell) |
| `opencode_list_files` / `opencode_find_files` | استعراض/بحث مسارات (داخل الجذور فقط) |
| `opencode_read_file` | قراءة ملف (مقصوص الطول) |
| `opencode_search_text` | بحث نصي مقصوص داخل الملفات (يتجاهل node_modules/.git) |
| `opencode_list_images` | الصور/المرفقات الظاهرة في الأحداث |
| `opencode_get_image` | يجيب الصورة ككتلة MCP image حقيقية (base64 → PNG) |

قدرات إضافية (لا تظهر إلا إذا فُعّلت وعُلّمت):

| النطاق | الأدوات الممنوحة |
|---|---|
| `mcp:write` | `opencode_send_message` (يرسل تعليمًا للوكيل؛ بدون session_id يفتح جلسة جديدة)، `opencode_interrupt_session` (وقف آمن)، `opencode_write_file`، `opencode_edit_file` (مرفوض إن لم يكون التعديل فريدًا) |
| `bridge:shell` | `opencode_shell_run` (top مع مهلة ومخرجات ورمز خروج صادق)، `opencode_shell_get`، `opencode_shell_list` |
| `bridge:screenshot` | `opencode_screenshot` (شاشة كاملة، يحتاج `confirm: true` دائمًا) |

كل أداة تحتفظ بحقيبة معلومات واضحة: تعيد `isError = true` برسالة عربية مفهومة بدل الكذب.

## الإعدادات (`.env`)

```ini
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
BRIDGE_PATH=/mcp-<عشوائي-طويل>     # جزء من عنوان السرّ — لا تشاركه
BRIDGE_DIRECTORY=                  # مجلد افتراضي للـ filesystem tools
BRIDGE_WORKSPACE_ROOTS=~;…         # جذور الملفات المسموح بها (فصل بـ ؛ أو مسافة)
BRIDGE_ALLOW_WRITE=0               # 1 = يفعّل مهارة mcp:write
BRIDGE_ALLOW_SHELL=0               # 1 = يفعّل مهارة bridge:shell
BRIDGE_ALLOW_SCREENSHOT=0          # 1 = يفعّل مهارة bridge:screenshot
BRIDGE_SHELL_TIMEOUT=60            # مهلة كل shell بالثواني
BRIDGE_SHELL_CONFIRM=1             # طلب confirm=true للأوامر عالية الخطورة
BRIDGE_MAX_REQUEST_BYTES=4000000   # حد حجم الطلبات المصلحة (413 عنده)
BRIDGE_RATE_LIMIT=200              # طلب/دقيقة على المسارات المخصصة
BRIDGE_MAX_TOOL_OUTPUT=4000        # أقصى طول لمخرجات الأداة
BRIDGE_EVENT_BUFFER=400            # عدد الأحداث المحفوظة
BRIDGE_OAUTH_PASSWORD=<سرّك>       # كلمة السر في صفحة /authorize
BRIDGE_OAUTH_CLIENT_ID=…           # عميل OAuth (ChatGPT يهدك، أو DCR)
BRIDGE_TOKEN=                      # اختياري: توكن ثابت (مخفي حال تفعيل OAuth)
```

> `BRIDGE_WORKSPACE_ROOTS` أقوى سور: أي قراءة/كتابة/بحث/تشغيل ملف خارج هذه الجذور يُرفض
> بصراحة. ويتلعنين مقاومة `..` (دخول)، مسارات Windows 8.3 (مثل `ADMINI~1`)، أحجزة مسارات UNC `\\…`،
> وتثبيت أقرار كاملة.

## التشغيل التلقائي كخدمات ويندوز (WinSW)

ثلاث خدمات نظامية تبدأ مع الإقلاع وتُعاد تلقائيًا عند الأعطال، مبنية على **WinSW** (إيقاف/إعادة
تشغيل فوري نظيف ~1 ثانية — بلا أي تعليقات سابقة serviços). سجلات تدور تحت `.service\`:

| الخدمة | العرض | الوظيفة |
|---|---|---|
| `OpenCodeAgent` | OpenCode Agent Backend | يشغّل `opencode serve --service --port 45278` عند الإقلاع |
| `OpenCodeBridge` | OpenCode MCP Bridge | `node src/server.js` مع `.env` داخل مجلد المشروع |
| `OpenCodeTunnel` | OpenCode Public Tunnel | النفّق المسمّى **الدائم** `opencode-agent` — العنوان الثابت `https://mcp.sageswap.dpdns.org` |

إدارة سريعة:

```powershell
Get-Service OpenCodeAgent,OpenCodeBridge,OpenCodeTunnel   # الحالة
Restart-Service OpenCodeBridge                            # إعادة تشغيل فورية نظيفة
Get-Content C:\Users\Administrator\opencode-bridge\.service\tunnel-url.txt   # عنوان النفق الدائم
```

الإعدادات: `service\OpenCodeAgent.xml` / `OpenCodeBridge.xml` / `OpenCodeTunnel.xml`
(تضبط `USERPROFILE`/`XDG_STATE_HOME` لأن الخدمات تعمل بـ LocalSystem).

> **السجل الموثوق لطلب الجسر:** `.service\bridge-console.log` — كل سطر بتوقيت UTC.
> مخرجات WinSW الخام تدور داخل مجلد `win-sw-bridge.log\` (القراءة منها غير عملية)؛
> لذلك يكتب الجسر سجله الخاص الدائم بجانبها.
>
> **طبقة إضافية:** مهمة **"OpenCode Services Revive"** (ONSTART، SYSTEM، بعد ~1:30) تضمن
> بدء الخدمات الثلاث بعد كل إقلاع، وحارس كل ساعة **"OpenCode Services Watchdog"** يعيد أي
> خدمة توقفت بصمت (كلاهما يشغّل `service\revive-services.ps1` — سجلها `.service\revive.log`؛
> يتخطى الوكيل إذا كان 45278 خدامًا يدويًا)، مع إجراءات استرجاع SCM (restart بعد 10/30/60 ث)
> لكل خدمة. الجسر يحتاج **Node.js LTS** في
> `C:\Program Files\nodejs\node.exe` — أُعيد تثبيته v24.22.1 في 28-10 بعد إزالة مفاجئة للإصدار السابق.

### الرابط الدائم (نفق مسمّى)

النفق الآن **مسمّى** (يظل عنوانه ثابتًا عبر الإقلاعات) وليس سريعًا متغيّرًا:

- اسم النفق: `opencode-agent` (معرّفه في `REPORT.md`)، بياناته في `~\.cloudflared\`.
- الدومين: `https://mcp.sageswap.dpdns.org` (CNAME → `<tunnel-id>.cfargotunnel.com`، proxied).
- العنوان يُحفظ أيضًا في `.service\tunnel-url.txt`.
- إعادة تشغيل الجهاز: الخدمة تعيد النفق بنفس العنوان تلقائيًا — **لا حاجة لتحديث ChatGPT**.
- توافق ChatGPT: عميل ChatGPT يرسل طلبات MCP دائمًا إلى **جذر النطاق `/`** ويهمل المسار الفرعي —
  لذا الجسر يخدم الـMCP في `/` **والمسار السري معًا** (التحدي 401 بلا رمز يبقى حاجزًا في المكانين).
- لتلغي النفق كليًا: `cloudflared tunnel delete opencode-agent` + حذف سجل DNS من لو coffe الحساب.

## أمان الـ OAuth

- `GET /.well-known/oauth-authorization-server` — metadata يقرأها ChatGPT (issuer عبر النفق).
- `GET /register` — تسجيل عميل ديناميكي (DCR) يجعل الربط من ChatGPT بلا إعداد يدوي.
- `GET /authorize` — صفحة دخول بكلمة `BRIDGE_OAUTH_PASSWORD`، فيها **مربعات القدرات**
  (`mcp:write`، `bridge:shell`، `bridge:screenshot`)؛ الممنوح = مطلوب ∋ مُعلَّم ∋ مُفعّل في .env.
- `POST /token` — access token (الذاكرة فقط) + refresh token **محفوظ** في `.auth/tokens.json` (30 يوم) ويتدوّر.
- PKCE (S256) إلزامي، تكرارlander code يُرفض، قرصنة verifier تمنحه 400.

> ملاحظة صادقة: access tokens في الذاكرة، فأي إعادة تشغيل للـ bridge ستطلب من ChatGPT إعادة
> دخول (refresh token المحفوظ يُهدها تلقائيًا لو صُمم الاتصال إبحارًا).

## خطوات الربط من ChatGPT (آمنة)

1. في `.env`: حدد `BRIDGE_WORKSPACE_ROOTS` و `BRIDGE_OAUTH_PASSWORD`، وفعّل القدرات التي
   تريد (`BRIDGE_ALLOW_WRITE/SHELL/SCREENSHOT`) ثم `npm start`.
2. افتح النفق: `cloudflared tunnel --url http://127.0.0.1:8787`
   (كل تشغيل نفق هنا يطلق عنوانًا جديدًا `https://<random>.trycloudflare.com` — حفظه).
3. ChatGPT → Settings → Apps & Connectors → **Developer mode** → Create connector.
4. عنوان MCP: `<عنوان النفق>` + `BRIDGE_PATH` من الـ banner (المسار السرّي).
5. Authentication = **OAuth** → ChatGPT يفتح صفحة الربط → أدخل السرّ، وعلّم فقط القدرات
   التي تريده (مثلاً yes للقراءة، ولا عيب إلا إذا أردت الكتابة).
6. افحص من المحادثة: `@OpenCode` + طلب مثل «اقرأ src/server.js واشرحبيه» — أو أولًا
   `node scripts/smoke.mjs` للتحقق الداخلي.

> لا تشارك عنوان الـ MCP ولا سرّ الـ OAuth. السجل يرفض/يسجل بطريقة آمنة.

## الأمان — قواعد ثابتة

- قراءة فقط افتراضيًا؛ القدرات تفصل ملفات/أوامر/شاشة، والنطاق يُمنح من مربع تشكّل.
- كل طلب مكعّد/كبير يُرد (409/413/401/429) بلا كشف محتوى.
- أوامر مؤسفية (رجل، format the disk، rm –r خارج الجذر، إلخ) **يُرفض أصلًا** إلا بـ `confirm: true`
  منذ الجانب المتحيذر، و-register يكتب في سجل المراجعة.
- `BRIDGE_WORKSPACE_ROOTS` الورّقة الورقية: أي هروب مسار يُرصّد برسالة صريحة.
- سجل المراجعة `.audit/audit.jsonl` يخفي قيم password/token/secret/bearer — يُستعمل للتفقّد لا للكشف.
- أي prompt injection داخل ملف يقرأه الوكيل قد يحاول استغلال الأدوات — إن هذه السور منعت المهام
  خارج جزيرة عمل الملفات. راجع [مصادر OpenAI المخاطرة](https://developers.openai.com/plugins/build/auth).

## التجارب

```powershell
node scripts/oauth-test.mjs     # 19 فحص: metadata، أسواد، scopes، PKCE، refresh، DCR، أداة جيدة
node scripts/core-test.mjs     # 16 فحص: traversal، root، redact، high-risk، تنسيق، مشقصات
node scripts/integration-test.mjs  # 24 فحص حقيقي على 127.0.0.1: flush، atébrates، أدوات، 429، audit
node scripts/smoke.mjs         # اتصال عميل SDK + أدوات القراءة
node scripts/smoke-write.mjs   # جلسة مخصصة جديدة + send_message والتصاق الرد
```

آخر تدفّقة (2026-10-25): **oauth 19/19 · core 16/16 · integration 24/24 · smoke CONNECTED · smoke-write BRIDGE_V2_OK** —
وChatGPT اتصل فعليًا عبر الرابط الدائم (اكتشاف أدوات + جلسات MCP كاملة الصلاحيات).

## حدود معروفة (بصراحة)

- `screenshot` يلتقط **الشاشة كاملة** عبر PowerShell (`System.Drawing`)، لا نافذة محددة؛
  لا يعمل في جلسات Windows منفصلة (Service session) ويحتاج سطح مكتب نشطًا، وحده 4MB حد.
- `opencode_shell_list` يعرض فقط الـ **running** shells؛ المكتملة يطرحها API سريعًا،
  فاعتمد `opencode_shell_get` بid من `shell_run`.
- عناوين أنفاق trycloudflare المجانية تظل عناوينها **متغيرة** في كل إعادة نفق — **تم تجاوز هذا**
  بادخال نفق مسمّى دائم: `https://mcp.sageswap.dpdns.org` (انظر قسم الخدمات أعلاه).
- على خطط ChatGPT Plus/Pro، الموديل نفسه يقيّد أدوات الكتابة — يظهر connection موصل لكن
  بدون أدوات الكتابة؛ أما Business/Enterprise فتقبل.
- ملفات أصدار الوكيل docked عبر `file://` URIs كتابًا حية داخل الجذور فقط.

## استكشاف الأخطاء

| المشكلة | الحل |
|---|---|
| `Cannot find a running OpenCode service` | شغّل OpenCode أو اضبط `OPENCODE_URL` و `OPENCODE_PASSWORD` |
| ChatGPT "Failed to connect" / وصول 401 | النفق يعمل؟ المسار `BRIDGE_PATH` يطابق؟ جرّب إعادة إنشاء الconnector |
| ChatGPT "Authentication succeeded, action discovery failed" | كان لأن ChatGPT يضرب الجذر — صار الجسر يخدم MCP في `/` أيضًا؛ تحقّق من سطر `POST / → ok(...)` في `.service\bridge-console.log` |
| الجسر واقف بعد إقلاع الجهاز (502) | مهمة "OpenCode Services Revive" تعيد تشغيله تلقائيًا بعد ~1:30؛ يدويًا: `Start-Service OpenCodeBridge` — وتاريخ المحاولات في `.service\revive.log` |
| الصفحة تسأل سرًّا ولا يمر | `BRIDGE_OAUTH_PASSWORD` في .env وشغّلت from `npm start` بعد تعديله |
| `write access is disabled` | فعل القدرة في .env + علّم صندوقها في صفحة /authorize |
| `Path is outside the approved workspace directories` | عدّل `BRIDGE_WORKSPACE_ROOTS` في .env |
| `confirm=true is required` | أمر عالي الخطورة — أعد الطلب بـ `confirm: true` أو شنّف السمرة |
| 429 rate limit exceeded | طلب سريع كثير — دقيقة ويتعافى (`BRIDGE_RATE_LIMIT`) |

## بنية المشروع

```
src/
  config.js      علم والقدرات والنطاقات والجذور من .env
  auth.js        OAuth AS داخلي (authorize/password/DCR/token/refresh/PKCE)
  opencode.js    عميل HTTP لـ OpenCode (Shell/FS/messages/events/SSE)
  events.js      حلقة الأحداث الحية + ring buffer
  format.js      تنسيق transcript/أحداث/مخرجات (reasoning toggle وattachments)
  workspace.js   الجذور + مقاومة traversal + بحث نصي مقصوص
  guards.js      كشف الأوامر عالية الخطورة
  screenshot.js  لقطة شاشة كاملة (System.Drawing)
  audit.js       سجل JSONL بلا أسرار
  server.js      خادم HTTP + MCP + 19 أداة + rate/size limits
scripts/
  oauth-test.mjs / core-test.mjs / integration-test.mjs / smoke.mjs / smoke-write.mjs
```

> الحالة: v0.2.0 — كل البابولوجي فوق معلبّة بالتجارب؛ انظر «التجارب» و«حدود معروفة».

## OpenCode-only Cloudflare WARP proxy

The Bridge exposes three MCP tools:
- `opencode_proxy_status`: reports WARP installation, the local listener at `127.0.0.1:40000`, a TLS-verified HTTPS probe, and whether the three proxy variables are present in `service/OpenCodeAgent.xml`. It never returns proxy values or credentials.
- `opencode_proxy_enable`: refuses unless WARP is detected, the local endpoint is listening, and the HTTPS probe succeeds with normal TLS certificate verification. It backs up the original Agent service XML under `.service/proxy-backups/` and adds only `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` to **OpenCodeAgent**. It does not touch the Bridge, tunnel, Windows global proxy, or other services.
- `opencode_proxy_disable`: restores only the entries owned by this Bridge; it refuses if another actor changed those values.

**Important:** enable/disable only write the Agent service XML. They return `restartRequired: true`; restart `OpenCodeAgent` explicitly to apply or remove the setting. No automatic activation is tied to HTTP 429, free quota, or account usage limits. A proxy can improve network reachability, but it does not reset account/provider quotas or grant access to another region.

The WARP Local Proxy must be installed and configured separately by the user. The expected local endpoint is `http://127.0.0.1:40000`. Public anonymous proxies are not supported. Keep TLS verification enabled.

Cloudflare One Local Proxy Mode documents a 10-second request timeout in some configurations. Long-running LLM streams may therefore be interrupted; verify your particular WARP profile before relying on it for streaming.

Tests:
```powershell
node scripts/proxy-manager-test.mjs
node scripts/core-test.mjs
```

