# NEXORA — تدقيق البنية الأساسية (المرحلة 1)

**نوع الوثيقة:** تقرير تدقيق قراءة فقط (Read-Only Architecture Audit)  
**التاريخ:** 2026-11-10  
**الفرع المرجعي:** `replit-transfer-20261108` @ `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b`  
**النطاق:** السلسلة والإجماع، التوكنوميكس، العقود الذكية، محرك السوق، الجسر وAID، تكامل الشبكة الاختبارية، خريطة الاعتماديات، وتقييم المخاطر مرتبًا حسب الشدة.

---

## 0. الحكم التنفيذي

**NEXORA اليوم ليست بنية متكاملة، بل مجموعة جزر هندسية تعمل كل واحدة على حدة:**

- سلسلة اختبارية مبنية على `cosmos/evm` غير المعدّل، بأربعة مدققين على جهاز واحد.
- سبعة عقود Solidity اختبارية، غير مدققة، وبعضها يحتوي أخطاء مؤكدة.
- رياضيات سوق معزولة (سندات/FX) لا تتصل بالسلسلة ولا بالعقود.
- جسر MCP لتشغيل OpenCode، وليس جسرًا بين شبكات بلوكتشين.
- واجهات API تعرض السلسلة والوكيل، لكن أحدها يعرض وكيل OpenCode للإنترنت **دون مصادقة واردة**.

**أعلى خطر فعلي ليس في رياضيات البلوكتشين، بل في `opencodeProxy`:** أي شخص يستطيع الوصول إلى عنوان التطبيق العام يستطيع الوصول إلى OpenCode API/UI، وتشغيل الأدوات، وقراءة مساحة العمل، واستخدام جلسات الوكيل — لأن الـ proxy يحقن بيانات اعتماد OpenCode المحلية نيابةً عن العميل دون التحقق من هوية العميل.

**الجاهزية:**

| البوابة | الحالة | السبب المختصر |
|---|---|---|
| عرض Testnet | جزئي / تاريخي | سجل 632 epoch متسق داخليًا، لكن لا توجد عملية `evmd` أو مستمعات وقت التدقيق، ولا genesis مُلتزم لإعادة إنتاج `appHash` |
| Phase 1 — Market Data | غير مكتمل | شريحة FX محلية فقط؛ لا تغذية إنتاجية، لا ترخيص بيانات، لا ربط بالسلسلة |
| Phase 3 — Chain + Oracle | جزئي | السلسلة موجودة كـ testnet؛ لا أوراكل، لا مدققين موزعين، لا مفاتيح إنتاج |
| Mainnet | **غير جاهز** | لا توكنوميكس، لا تدقيق أمني، لا بنية تحتية موزعة، لا مفاتيح إنتاج |

---

## 1. المنهجية والقيود

### 1.1 ما تم فعله

- مراجعة ملفات الإعداد والكود والوثائق في الشجرة النشطة (`source/`, `apps/`, `artifacts/`, `tools/`, `docs/`).
- تشغيل اختبارات العقود وAID والسوق والجسر والفاوسيت وMarket Hub للتحقق من الأعداد.
- فحص سجل الشبكة الاختبارية (`source/testnet/ledger.json`) والحالة (`source/testnet/state.json`) حسابيًا.
- فحص العمليات والمستمعات (`ps`, `ss`) وقت التدقيق.
- اختبار سلوك `nexoraDiff({})` فعليًا على شجرة عمل غير نظيفة.
- قراءة `SPEC.md` و`AID/SPEC.md` ومقارنتها بالتنفيذ.

### 1.2 ما لم يتم فعله (حدود التدقيق)

- **لم يتم تعديل أي كود مصدري**، ولا أي عقد، ولا أي إعداد.
- لم يتم تنفيذ `git add` أو `commit` أو `push`، ولا تغيير فرع أو remote.
- لم يتم لمس `.migration-staging/old-project-backup/`.
- لم يتم نشر أو تشغيل أي خدمة، ولا تغيير Cloudflare/DNS/Tunnel.
- لم يتم كشف أي مفتاح أو token أو محتوى `.env`.
- لم يتم إضافة ثنائيات Foundry إلى Git.
- التدقيق **لا يثبت** سلامة التصميم الاقتصادي أو القانوني؛ هو يوثّق ما هو موجود وما هو مفقود وما هو خطر.

---

## 2. نظرة عامة على البنية

### 2.1 الشكل الفعلي

```
                    ┌──────────────────────────────────────────────┐
                    │  Apps / API Server (Express 5, TS)           │
                    │  artifacts/api-server/src/                   │
                    │  ├─ nexoraProxy   → CometBFT + EVM JSON-RPC  │
                    │  ├─ opencodeProxy → OpenCode API/UI (بلا auth)│
                    │  └─ nexoraFaucet  → توقيع وتحويل ANEX         │
                    └───────────────┬──────────────────────────────┘
                                    │ loopback
              ┌─────────────────────┴─────────────────────┐
              │                                           │
     ┌────────▼────────┐                        ┌─────────▼─────────┐
     │ 4 × evmd        │                        │ OpenCode server   │
     │ CometBFT 0.39.3 │                        │ 127.0.0.1:49374   │
     │ Cosmos SDK .54.3│                        └───────────────────┘
     │ EVM chain 902024│
     └────────┬────────┘
              │
     ┌────────▼─────────────────────────────────────────────────────┐
     │ Contracts (7)          AID (3 + JS)        Market (JS/Python)│
     │ TestSaleVault          AidRegistry         bond/daycount     │
     │ LinearVesting          AidFactory          FX daily reference│
     │ AssetRegistry          Aid                 (لا اتصال بالسلسلة)│
     │ VanityAsset / Token / Create2 / Greeter                      │
     └──────────────────────────────────────────────────────────────┘

     Bridge (MCP) ──► OpenCode ──► workspace     (ليس جسر بلوكتشين)
```

### 2.2 الخلاصة المعمارية

1. **المسار الحقيقي الوحيد من طرف إلى طرف** هو: `Apps → nexoraProxy → chain RPC`، و`Apps → opencodeProxy → OpenCode`.
2. **العقود لا تتصل بالسوق**: لا أوراكل، لا سعر على السلسلة، لا استهلاك لبيانات Market Hub.
3. **التوكنوميكس غائب**: لا يوجد نموذج عرض أو إصدار أو توزيع أو فائدة؛ `anex` مجرد denom للغاز.
4. **الجسر ليس جسرًا**: `source/bridge` أداة MCP لتشغيل OpenCode، وليست جسر أصول بين شبكات.
5. **الوثائق لا تعكس الواقع**: `docs/STATUS.md` يقول إن السلسلة غير موجودة، بينما `source/docs/STATUS.md` يقول إنها تعمل.

---

## 3. حالة المكونات (منفّذ / جزئي / غائب)

| المكوّن | الحالة | الدليل | اختبارات |
|---|---|---|---|
| إعداد السلسلة | منفّذ (config-only) | `source/chain/nexora-devnet.json`, `source/chain/upstream.md` | — |
| عقدة/إجماع | جزئي (testnet) | 4 مدققين على جهاز واحد؛ `source/ci/testnet/run-epoch.sh` | — |
| التوكنوميكس | **غائب** | `source/docs/economics.md`: "NO DECISIONS HAVE BEEN MADE" | — |
| العقود الذكية | منفّذ (testnet فقط) | 7 عقود في `source/contracts/src/` | 70 |
| AID | منفّذ | 3 عقود + مرجع JS | 45 Solidity + 40 JS |
| Asset Registry | منفّذ (testnet فقط) | `AssetRegistry.sol` | ضمن 70 |
| محرك السوق (رياضيات) | منفّذ (معزول) | `source/market/src/bond.mjs`, `daycount.mjs` | 41 |
| Market Data Hub (FX) | منفّذ (محلي) | `apps/market-data-hub/` | 89 |
| الجسر MCP | منفّذ (أداة تطوير) | `source/bridge/` | 76 |
| جسر OpenCode الموسّع | منفّذ (سطح أوسع) | `tools/opencode-bridge/` | 16 |
| API Server | منفّذ | `artifacts/api-server/src/` | 17 (faucet) |
| Oracle | **غائب** | لا عقد ولا خدمة تغذية | — |
| الحوكمة | وثائق فقط | `docs/SUBSYSTEM-OWNERSHIP.md` (الملاك TBD) | — |
| Mainnet | **غير جاهز** | `source/docs/MAINNET-READINESS-REPORT.md` | — |

---

## 4. السلسلة والإجماع

### 4.1 ما تم التحقق منه

| البند | القيمة | الدليل |
|---|---|---|
| Upstream | `cosmos/evm` v0.7.3 @ `c3ae9067a7eadcdea55a5192226916deb44c71c4` | `source/chain/upstream.md:17-19` |
| Cosmos SDK | v0.54.3 | `source/chain/upstream.md:39` |
| CometBFT | v0.39.3 | `source/chain/upstream.md:41` |
| Go | 1.25.9 | `source/chain/upstream.md:57` |
| Chain ID | `eip155:902024` / EVM `902024` (`0xDC388`) | `source/chain/nexora-devnet.json:3-5` |
| Denom | `anex`, 18 decimals, display `nex`, symbol `ANEX` | `source/chain/nexora-devnet.json:9-16` |
| Bech32 | `cosmos` (وليس `nexora`) | `source/chain/nexora-devnet.json:7-8` |
| Gas | min `1anex`، base fee يبدأ 2 gwei ويهبط نحو 1 gwei | `source/chain/nexora-devnet.json:17-25` |
| Block gas | 10,000,000 | `source/chain/nexora-devnet.json:27-29` |
| المدققون | 4 مدققين، 4000 power | `source/testnet/state.json` |
| Slash events | 0 | `source/testnet/state.json` |
| التضخم الحالي | `0.130418200467165228` (~13.04%) | `source/testnet/state.json` |
| العرض الحالي | `400168587278538416646516342 anex` (~400.17M) | `source/testnet/state.json` |

**السلسلة غير معدّلة**: لا يوجد كود سلسلة خاص بـ NEXORA في الشجرة النشطة؛ الموجود إعدادات وسكربتات فوق `evmd` الأصلي. هذا يقلل سطح الهجوم المخصص، لكنه يعني أن أي ترقية أو إصلاح للإجماع يعتمد على upstream.

### 4.2 نموذج الـ epoch — نقطة جوهرية

`source/ci/testnet/run-epoch.sh` يوضح أن الشبكة **ليست سلسلة مستمرة**:

- كل epoch يبدأ genesis جديدًا من حالة التطبيق السابقة.
- CometBFT يعود إلى height 1 في كل epoch.
- فقط **حالة التطبيق** تنتقل؛ عداد الكتل لا ينتقل.
- السجل يجمع `cumulativeBlocks` كمجموع ارتفاعات الـ epochs، وليس كارتفاع سلسلة واحدة.

**الأرقام الحالية:**

- `epoch = 632`
- `height = 29` (ارتفاع الـ epoch الحالي)
- `cumulativeBlocks = 20212` (مجموع كل الارتفاعات)
- `history.length = 632`، وتسلسل epochs من 1 إلى 632 صحيح
- مجموع `height` لكل السجل = 20212 (تحقق حسابي)
- `appHash` في السجل = `59B06BE2FBBA11731A3F671434AD322BC036AD808A69FA072E3AF2F6AC25AAB8`
- `state.height = 29` و`state.app_hash` يطابقان السجل وآخر history entry

**هذا اتساق داخلي جيد**، لكنه لا يعني أن هناك شبكة حية مستمرة. وقت التدقيق:

- لا توجد عملية `evmd` تعمل.
- لا توجد مستمعات على `26657` أو `8545`.
- لا يوجد `genesis.json` ملتزم في `source/testnet/` (الموجود فقط داخل `.migration-staging/old-project-backup/`، ولم يُلمس).
- لا يوجد `evmd` على `PATH`، والنسخة الموجودة في backup غير مستخدمة.

**النتيجة:** يمكن التحقق من اتساق السجل، لكن **لا يمكن إعادة إنتاج `appHash` من الشجرة النشطة** دون بناء upstream أو استخدام backup. أي ادعاء بـ "شبكة حية" أو "public RPC" وقت التدقيق غير قابل للتحقق.

### 4.3 مخاطر السلسلة والإجماع

- **H-06:** 4 مدققين على جهاز واحد، P2P على loopback، تحمل أعطال = 0. أي توقف للجهاز يوقف السلسلة. هذا عرض توضيحي وليس شبكة.
- **H-07:** نموذج epoch + غياب genesis/`evmd` يمنع التدقيق الخارجي المستقل ويجعل `appHash` غير قابل لإعادة الإنتاج من المستودع.
- **M-08:** `bech32_prefix = cosmos` يعني أن عناوين NEXORA تبدو كعناوين أي سلسلة Cosmos أخرى؛ خطر تمييز/UX.
- **M-09:** تضخم 13%→20% كافتراضي upstream دون سياسة وجهة واضحة.
- **إيجابي:** السلسلة غير معدّلة، والإعدادات موثقة، والسجل متسق، و0 slash events.

---

## 5. التوكنوميكس

### 5.1 الحالة الفعلية

`source/docs/economics.md` يبدأ بـ:

> **Status: NO DECISIONS HAVE BEEN MADE.**

ولا يوجد:

- نموذج عرض (supply model)
- جدول إصدار (issuance schedule)
- توزيعات (team/investors/treasury)
- vesting/unlock
- فائدة/utility
- سياسة رسوم (burn vs validator vs treasury)
- مكافآت مدققين
- حوكمة

`anex` هو **native denom** في Cosmos bank، وليس ERC-20. `NexoraTestToken` (NXIT) هو توكن اختباري منفصل للبيع، وليس ANEX.

### 5.2 الأرقام

- العرض في الحالة: ~400.17M ANEX.
- التضخم: ~13.04% حاليًا (الوثائق تصف 13%→20% كافتراضي).
- لا توجد سياسة واضحة لمصدر التضخم أو وجهته.
- لا توجد قيمة سوقية أو سعر أو سيولة؛ كل ذلك غير موجود.

### 5.3 الحكم

**C-02 (Critical):** لا يمكن تقييم أو تدقيق أو حوكمة توكن بدون توكنوميكس. أي حديث عن Mainnet أو بيع عام قبل هذه الوثيقة هو بناء على الرمل. المطلوب: charter توكنوميكس مع supply، allocation، vesting، utility، fee/burn، validator rewards، treasury، ومراجعة قانونية.

---

## 6. العقود الذكية

### 6.1 الجرد

| العقد | السطور | الغرض | ملاحظة |
|---|---:|---|---|
| `AssetRegistry.sol` | 298 | name → address + AID link | claim عام، `allNames` معطّل |
| `TestSaleVault.sol` | 208 | محاكاة بيع | `refundAll` خاطئ، owner withdraw |
| `LinearVesting.sol` | 135 | cliff + linear vesting | يحتاج تدقيق |
| `NexoraTestToken.sol` | 111 | ERC-20 اختباري | test-only |
| `Create2Deployer.sol` | 111 | CREATE2 forwarder | يحتاج تدقيق |
| `VanityAsset.sol` | 90 | ERC-20 بعنوان vanity | يحتاج تدقيق |
| `NexoraGreeter.sol` | 27 | مثال Phase 1 | بلا access control |

**الإجمالي:** 7 عقود، 979 سطرًا، 70 اختبار Forge ناجح (تم تشغيلها في هذه الجلسة).

### 6.2 Findings

#### H-02 — `TestSaleVault.refundAll` يحوّل كل الأموال إلى treasury ولا يعيد شيئًا للمشترين

**الدليل:** `source/contracts/src/TestSaleVault.sol:188-196`

```solidity
function refundAll() external onlyOwner nonReentrant {
    closed = true;
    uint256 perToken = sold == 0 ? 0 : address(this).balance / sold;
    (bool ok,) = treasury.call{value: address(this).balance}("");
    if (!ok) revert TransferFailed();
    emit ClosedSale();
    perToken; // computed for the off-chain report only
}
```

- يحسب `perToken` ثم **يتجاهله**.
- يرسل **كامل الرصيد** إلى `treasury`.
- لا يوجد أي تحويل إلى `purchased[msg.sender]` أو قائمة مشترين.
- لا يوجد اختبار لـ `refundAll` (تم البحث في `test/`؛ لا ذكر له).

**الأثر:** إذا أُعيد استخدام هذا العقد في بيع حقيقي، يخسر المشترون أموالهم. هو test-only، لكنه **High** لأن وظيفته المعلنة هي refund ولا يفعلها.

**الإصلاح المقترح:** إما حذف الدالة، أو تنفيذ pull-based refunds مع accounting لكل مشترٍ، أو تحويلها إلى treasury بشكل صريح مع تغيير الاسم/التعليق. والأهم: اختبار يثبت أن كل مشترٍ يستعيد ما دفعه.

#### M-01 — `_cost` يستخدم ضربًا غير محمي من overflow

**الدليل:** `source/contracts/src/TestSaleVault.sol:152-155`

```solidity
function _cost(uint256 tokens) private view returns (uint256) {
    unchecked {
        return (tokens * pricePerToken) / (10 ** uint256(token.decimals()));
    }
}
```

- `pricePerToken` يُمرر في constructor، و`tokens` يصل إلى `capTokens`.
- إذا كان السعر/السقف كبيرًا، يمكن أن يلتف الناتج إلى قيمة صغيرة، فيدفع المشتري أقل من المطلوب.
- في النشر الحالي (0.05e18 و1M token) لا يحدث overflow، لكن العقد عام.

**الإصلاح:** إزالة `unchecked` أو استخدام `mulDiv` من OpenZeppelin/Math، مع اختبار حدود.

#### M-02 — المالك يمكنه سحب كل الأموال في أي وقت

**الدليل:** `source/contracts/src/TestSaleVault.sol:171-176`

```solidity
function withdrawFunds(address payable to) external onlyOwner {
    uint256 bal = address(this).balance;
    (bool ok,) = to.call{value: bal}("");
    ...
}
```

- لا timelock، لا multisig، لا قيود على `to`.
- في محاكاة testnet هذا مقبول؛ في بيع حقيقي هو سطح rug-pull.

**الإصلاح:** multisig + timelock + سحب مقيد بالمبلغ المرفوع/غير المخصص، أو فصل treasury عن owner.

#### H-04 — `AssetRegistry.claim` عام وأول من يصل يفوز، دون إثبات ملكية

**الدليل:** `source/contracts/src/AssetRegistry.sol:270-288`

```solidity
/// Assert control of a registered address. Anyone may call this; it is a public claim.
function claim(string calldata name) external {
    bytes32 node = _node(name);
    if (!_assets[node].registered) revert NotRegistered(node);
    _assets[node].claimant = msg.sender;
    _assets[node].claimed = true;
    emit Claimed(name, node, msg.sender);
}

function linkAssetId(string calldata name, bytes32 assetId) external {
    ...
    if (a.claimed && a.claimant != msg.sender) revert Unauthorized();
    a.assetId = assetId;
    ...
}
```

- `claim` لا يتحقق من أن `msg.sender` يملك `contractAddress` أو يتحكم به.
- أي شخص يمكنه claim اسمًا مسجلًا، ثم يمنع المالك الحقيقي من `linkAssetId`.
- `register` نفسه عام first-come (سطور 238-268)، لذا يمكن حجز الأسماء قبل المالك.

**الأثر:** نظام التسمية قابل للاختطاف/الحجب. هذا **High** لأن AssetRegistry هو طبقة الهوية الإنسانية.

**الإصلاح:** ربط claim بإثبات ملكية (توقيع من owner، أو `msg.sender == contractAddress` حيث ينطبق، أو آلية challenge/optimistic)، أو جعل register+claim عملية واحدة مع إثبات.

#### M-03 — `linkAssetId` يمكن أن يضع AID عشوائيًا قبل claim

**الدليل:** نفس الملف، سطور 280-288. الشرط `if (a.claimed && a.claimant != msg.sender)` يعني: إذا لم يكن الاسم claimed، **أي شخص** يمكنه ربط أي `bytes32` به.

**الأثر:** مستهلك يقرأ الاسم قبل claim قد يحصل على AID خاطئ. **Medium**.

**الإصلاح:** منع `linkAssetId` قبل claim، أو تقييده بمسجل الاسم/المالك.

#### M-12 — `allNames` دائمًا reverts

**الدليل:** `source/contracts/src/AssetRegistry.sol:290-298`

```solidity
function allNames(uint256 offset, uint256 limit) external view returns (string[] memory) {
    Asset[] memory probe = new Asset[](limit);
    probe;
    revert("use event indexing");
}
```

- الدالة موجودة في ABI لكنها غير قابلة للاستخدام.
- التصميم الصحيح هو indexer فوق events، وهذا موثق، لكن وجود دالة دائمة الـ revert يضلل المتكاملين.

**الإصلاح:** حذفها من ABI أو إرجاع `NotSupported` واضح، وتوثيق indexer.

#### H-03 — `AidRegistry.register` يثق بـ `chainId` القادم من المستدعي

**الدليل:** `source/aid/src/AidRegistry.sol:76-91`

```solidity
function register(bytes32 assetId, uint8 assetType, bytes32 assetKey, uint256 chainId) external {
    ...
    bytes32 computed = Aid.assetId(chainId, assetType, assetKey);
    if (computed != assetId) revert AidMetadataDoesNotMatchIdentifier(assetId, computed);
    ...
}
```

**المواصفة:** `source/aid/SPEC.md:95-98` تقول صراحة:

> A contract must not trust a caller-supplied chain id. It reads `block.chainid`.

**المشكلة:** العقد لا يقرأ `block.chainid` ولا يتحقق من `chainId == block.chainid`. يمكن تسجيل `assetId` محسوب لسلسلة أخرى (مثل Ethereum mainnet) على NEXORA. لا يمكن استبدال ID مسجل، لكن يمكن تلويث السجل وإرباك المستهلكين.

**الاختبار:** `source/aid/test/AidRegistry.t.sol:80-89` (`test_rejectsTheWrongChainId`) يختبر فقط عدم تطابق ID مع (type/key) — أي أنه يمرر `assetId` محسوبًا لـ chain 1 مع `chainId = CHAIN`، فيفشل بسبب عدم التطابق. **لا يوجد اختبار** يثبت رفض `chainId` أجنبي مع ID محسوب لنفس الـ chain الأجنبي.

**الأثر:** خرق مباشر للمواصفة، وتلويث محتمل للـ registry. **High**.

**الإصلاح:** `if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);` أو إزالة المعامل واستخدام `block.chainid` داخليًا. وإضافة اختبار `register(assetIdForChain1, ..., 1)` على chain 902024 يجب أن يرتفع.

#### M-04 — `AidFactory` يسمح بأخذ العنوان القانوني (CREATE2 front-running)

**الدليل:** `source/aid/src/AidFactory.sol:72-83`

```solidity
function deploy(bytes32 salt, bytes memory initCode) external payable returns (address) {
    return _deploy(salt, initCode);
}

function deployForAsset(bytes32 assetId, bytes memory initCode) external payable returns (address) {
    return _deploy(saltFor(assetId, keccak256(initCode)), initCode);
}
```

- لا access control.
- `saltFor` عامة وقابلة للحساب مسبقًا.
- العنوان يعتمد على `factory + salt + keccak256(initCode)`.
- أول من ينشر يحتل العنوان؛ العقد يرفض لاحقًا لأن العنوان يحمل code.
- إذا كان constructor يضبط owner = msg.sender، يمكن للمهاجم أن يصبح المالك.

**الأثر:** احتلال عنوان assetId/الملكية. **Medium** (testnet) و**High** إذا اعتُبر إنتاجيًا.

**الإصلاح:** تقييد `deployForAsset` بـ allowlist/توقيع، أو استخدام `CREATE3` مع مالك محدد، أو جعل النشر عبر registry يتحقق من claimant.

---

## 7. AID — طبقة هوية الأصول

### 7.1 الحالة

- `Aid.sol`: library للـ assetId (fixed-width encoding).
- `AidRegistry.sol`: تسجيل/سحب/تحقق.
- `AidFactory.sol`: نشر CREATE2.
- `aid.mjs`: مرجع JS.
- 45 اختبار Solidity + 40 اختبار JS = **85 اختبارًا ناجحًا**.

**ملاحظة توثيقية:** `source/aid/SPEC.md:3` يقول:

> **Status: specification only. Not implemented, not deployed, not audited.**

هذا **متعارض** مع وجود 3 عقود ومرجع JS و85 اختبارًا. الوثيقة قديمة/غير محدثة. هذا **Medium** لأنه يضلل المراجع.

### 7.2 نقاط القوة

- التشفير fixed-width، مع domain separator.
- اختبارات vectors بين Solidity وJS (تطبيقان مستقلان).
- registry يتحقق من أن metadata تعيد إنتاج assetId.
- first-claim-wins + retract final (مقصود).

### 7.3 نقاط الضعف

- **H-03:** `chainId` من المستدعي (أعلاه).
- **M-04:** CREATE2 front-running (أعلاه).
- **Medium:** `verify` يأخذ `chainId` من المستدعي أيضًا؛ قد يتحقق ضد سلسلة أجنبية.
- **Low/Medium:** لا توجد آلية إثبات ملكية للأصل؛ التسجيل مجرد claim، وهذا موثق لكنه ليس كافيًا لاستخدامات مالية.

---

## 8. محرك السوق

### 8.1 `source/market` — رياضيات معزولة

| البند | الحالة |
|---|---|
| السندات | straight fixed-rate coupons فقط |
| Day count | ACT/365F, ACT/360, 30/360 US, 30E/360 |
| غير مدعوم | ACT/ACT, ACT/ACT ICMA, business-day calendars, ex-coupon, stubs, floating, amortising, callable, convertible |
| الاختبارات | 41 ناجحًا |
| الاتصال بالسلسلة | **لا يوجد** |
| الاتصال بالعقود | **لا يوجد** |
| أوراكل | **لا يوجد** |

**الحكم:** مكتبة رياضية جيدة كبداية، لكنها ليست "محرك سوق" ولا تغذي أي شيء على السلسلة. لا يمكنها تسعير سند خزينة أمريكي بالعرف السوقي (ACT/ACT) — وهذا مذكور بصراحة في الكود.

### 8.2 `apps/market-data-hub` — شريحة FX محلية

- Python stdlib فقط.
- Frankfurter v2، بيانات يومية مرجعية (MID, non-executable).
- SQLite محلي، binds `127.0.0.1` فقط.
- 89 اختبارًا ناجحًا.
- لا scheduler، لا provider health إنتاجي، لا licensing matrix مكتمل، لا ربط بالسلسلة.
- `README` يصفها كـ MVP slice، وليس Phase 1 كامل.

**الحكم:** شريحة صحيحة الاتجاه، لكنها معزولة. **H-10:** لا يوجد أي مسار يربط بيانات السوق بالسلسلة أو بالعقود أو بالتسعير. أي حديث عن "سوق NEXORA" الآن هو وصف لطبقتين منفصلتين.

---

## 9. الجسر (Bridge)

### 9.1 `source/bridge` — MCP إلى OpenCode

- 9 أدوات: health, git status, diff, log, docs index, list sessions, task status, submit task, cancel task.
- لا shell تنفيذي.
- loopback افتراضيًا + Bearer auth.
- 76 اختبارًا ناجحًا.
- **ليس جسر بلوكتشين**: لا يحمل أصولًا ولا يتحقق من معاملات.

**H-09 (جزئي):** التسمية "bridge" مضللة في سياق البلوكتشين؛ يجب توثيقها كأداة تطوير.

### 9.2 `nexoraDiff({})` — خطأ مؤكد

**الدليل:** `source/bridge/src/repo.mjs:76-92`

```js
export async function nexoraDiff({ ref = 'HEAD', staged = false, path: sub } = {}, cfg = config) {
  ...
  const args = ['diff'];
  if (!staged) args.push('HEAD');
  args.push('--no-color', '--stat', '--patch');
  args.push(ref);
  ...
}
```

- الافتراضي `ref = 'HEAD'` و`staged = false` → الأمر: `git diff HEAD --no-color --stat --patch HEAD`.
- `git diff HEAD ... HEAD` يقارن HEAD بنفسه → **صفر بايت**.
- تم التحقق عمليًا: `nexoraDiff({})` أعاد `bytes 0` على شجرة عمل غير نظيفة.

**الأثر:** أداة المراجعة الأساسية لا ترى التغييرات غير المرحّلة. **Medium**.

**الإصلاح:** إذا لم يُمرر `ref`، لا تضف `ref` إلى args؛ استخدم `git diff HEAD` فقط. وإضافة اختبار افتراضي على شجرة dirty.

### 9.3 `tools/opencode-bridge` — سطح أوسع

- 19 أداة، تشمل shell/write/screenshot/OAuth.
- 16 اختبار core ناجحًا.
- ليس مربوطًا بـ `api-server`، لكنه خدمة منفصلة؛ إذا شُغّلت وعُرضت، فهي سطح هجوم أكبر بكثير من `source/bridge`.
- تكرار مع `source/bridge` → خطر drift.

**التوصية:** توحيد الجسرين في أداة واحدة بصلاحيات صريحة، أو حذف/أرشفة أحدهما. لا تشغيل `tools/opencode-bridge` على واجهة عامة دون OAuth صارم وscopes.

### 9.4 تكرار بوابات RPC

الملفات الموجودة:

- `nexora-rpc-gateway.mjs` (root)
- `source/scripts/nexora-rpc-gateway.mjs`
- `source/scripts/nexora-proxy-express.ts`
- `artifacts/api-server/src/nexoraProxy.ts` (النشط)

**المشكلة:** أربع نسخ (أو ثلاث عائلات) من نفس الفكرة، مع اختلافات طفيفة (4599 vs 4597 بايت في gateway). أي إصلاح أمني في واحدة لا ينتقل للأخرى. **Medium**.

---

## 10. التطبيقات والواجهات (API Server)

### 10.1 ترتيب التركيب

`artifacts/api-server/src/app.ts`:

```ts
app.use(cors());                 // سطر 31
app.use(nexoraProxy);            // سطر 38
app.use(opencodeProxy);          // سطر 44
app.use(express.json());         // سطر 46
app.use(express.urlencoded(...));
app.use(nexoraFaucet);           // سطر 52
app.use("/api", router);         // سطر 54
```

### 10.2 C-01 — `opencodeProxy` بلا مصادقة واردة (Critical)

**الدليل:** `artifacts/api-server/src/opencodeProxy.ts:144-170`

- يستقبل أي مسار لا يبدأ بـ `/api/nexora`.
- لا يفحص `Authorization` أو session أو IP.
- يمرر الطلب إلى `TARGET_URL` (افتراضي `http://127.0.0.1:49374`).
- يحقن `Authorization: Basic opencode:<password>` نيابةً عن العميل (سطور 77-81).
- يمرر WebSocket upgrades بنفس المنطق (سطور 176-237).

**الأثر:** أي شخص يصل إلى عنوان التطبيق العام يمكنه:

- فتح OpenCode UI/API.
- عرض الجلسات والـ transcript.
- إرسال مهام للوكيل (والوكيل يملك أدوات/Shell حسب إعداد OpenCode).
- قراءة/كتابة ملفات مساحة العمل، وربما الوصول إلى أسرار البيئة.

**هذا أخطر بكثير من أي خطأ في العقود.** يجب فصله أو تأمينه قبل أي نشر.

**الإصلاح الفوري:**

1. إزالة `app.use(opencodeProxy)` من الخادم العام، أو
2. وضعها خلف auth قوي (OAuth/JWT + allowlist + rate limit) على مسار منفصل، أو
3. ربطها بـ loopback فقط وعدم نشرها عبر Replit dev domain.

### 10.3 H-01 — `nexoraProxy` يمرر JSON-RPC كاملًا بما فيه الكتابة

**الدليل:** `artifacts/api-server/src/nexoraProxy.ts`

- التعليق في السطور 12-17 يقول "READ ONLY".
- لكن السطور 175-179 تمرر أي method/body إلى CometBFT وEVM.
- السطر 157 يقول صراحة: `"evmSide": "full JSON-RPC forwarded, including eth_sendRawTransaction"`.

**الأثر:** يمكن لأي عميل إرسال معاملات موقعة، نشر عقود، واستدعاء `broadcast_tx_*` على CometBFT. لا يسرق المفاتيح، لكنه يكسر افتراض "read-only" ويفتح relay/spam/mempool abuse. **High**.

**الإصلاح:** allowlist صريح:

- EVM: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_getCode`, `eth_getBalance`, `eth_getLogs`...
- CometBFT: `status`, `block`, `validators`, `tx`, `net_info`...
- رفض كل ما عدا ذلك بـ 403، مع اختبارات.

### 10.4 H-05 — Faucet: تجاوز rate limit عبر `X-Forwarded-For`

**الدليل:** `artifacts/api-server/src/nexoraFaucet.ts:46-52`

```ts
function clientKey(req: Request) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}
```

- `X-Forwarded-For` header يتحكم به العميل مباشرة.
- لا يوجد `app.set("trust proxy", ...)` في `app.ts`.
- كل قيمة XFF جديدة = مفتاح rate-limit جديد.
- `COOLDOWN_MS = 60_000`, `MAX_PER_REQUEST = 1000 ANEX`, `DEFAULT_PAYOUT = 100 ANEX` (سطور 40-42).
- `lastRequest` في الذاكرة فقط (سطر 44) → restart يصفّر الحدود.
- حساب واحد يمول كل الطلبات.

**الأثر:** يمكن استنزاف رصيد الفاوسيت، وتجويع الغاز للشبكة الاختبارية. **High** (تشغيليًا).

**الإصلاح:**

- استخدم `req.socket.remoteAddress` فقط، أو `trust proxy` مع قائمة proxies موثوقة.
- أضف حدًا يوميًا عالميًا + حدًا لكل عنوان وجهة + تخزينًا دائمًا.
- أضف challenge/PoW أو تسجيل دخول خفيف إن أمكن.
- راقب رصيد الفاوسيت وأنبه عند الانخفاض.

### 10.5 إيجابيات Faucet

- رفض التشغيل إذا لم يكن chain ID هو testnet (سطور 79-93).
- POST فقط (95-102).
- تحقق من العنوان ورفض zero address (116-124).
- `nexoraFaucetMount` غير متزامن ويستخدم `await` و`next(e)` (تم إصلاحه سابقًا).
- redaction للأسرار في catch.
- 17 اختبارًا ناجحًا.

هذه تحسينات حقيقية، لكنها لا تعالج تجاوز XFF.

### 10.6 M-07 — CORS مفتوح

`app.use(cors())` في `app.ts:31` يسمح لأي أصل (origin) باستدعاء الـ API، بما في ذلك الفاوسيت. مع أن الفاوسيت لا يعتمد على cookies، فإن CORS المفتوح يزيد سطح إساءة الاستخدام ويسهل هجمات القياس/الاستنزاف من صفحات طرف ثالث.

**الإصلاح:** تقييد origins المعروفة، أو تعطيل CORS للمسارات الحساسة.

---

## 11. تكامل الشبكة الاختبارية

### 11.1 التحقق الحسابي

تم التحقق من:

- `epoch = 632`، `height = 29`، `cumulativeBlocks = 20212`.
- `history` طوله 632، وتسلسل epochs صحيح.
- مجموع heights = 20212.
- `state.height` و`state.app_hash` يطابقان السجل وآخر history entry.
- 4 مدققين، 4000 power.
- 0 slash events.
- supply = 400,168,587.278538416646516342 ANEX.
- inflation = 0.130418200467165228.

**هذا اتساق داخلي جيد** ويستحق التسجيل كإنجاز.

### 11.2 لكن...

- الشبكة **ليست حية** وقت التدقيق: لا `evmd`، لا مستمعات.
- كل epoch يعيد التشغيل من height 1؛ `cumulativeBlocks` ليس ارتفاع سلسلة مستمرة.
- لا `genesis.json` في الشجرة النشطة.
- لا `evmd` على `PATH`.
- `source/docs/PUBLIC-ENDPOINTS.md` يصف endpoints عامة عبر tunnel مؤقت، لكنها غير قابلة للتحقق الآن، والوثيقة نفسها تقول إن الرابط يتغير ويموت عند سكون Repl.
- `source/docs/STATUS.md` يقول "testnet running at block >9,000" — هذا يتعارض مع سجل epoch الحالي (height 29) ويعتمد على عقدة حية أخرى غير موثقة في السجل.

**H-07:** عدم إمكانية إعادة إنتاج `appHash` من المستودع هو عيب تدقيقي جوهري. أي طرف خارجي لا يستطيع التحقق من أن الحالة المعلنة هي بالفعل نتيجة تنفيذ تلك المعاملات.

### 11.3 تعارض الوثائق

| الوثيقة | ما تقوله | التعارض |
|---|---|---|
| `docs/STATUS.md` (root) | "No chain source, chain build, or chain test is verified" | يناقض `source/docs/STATUS.md` |
| `source/docs/STATUS.md` | "Chain: Running... 4 validators" | يناقض الحالة وقت التدقيق (لا عملية) |
| `docs/SUBSYSTEM-OWNERSHIP.md` | blockchain "Not generated" | السلسلة موجودة كـ testnet |
| `source/aid/SPEC.md` | "specification only. Not implemented" | 3 عقود + 85 اختبارًا |
| `source/docs/MAINNET-READINESS-REPORT.md` | تقرير 2026-10-13 | أرقام/حالة قد تكون قديمة، لكن الـ blockers الأساسية ما زالت صحيحة |
| `docs/FOUNDATION-ARCHITECTURE-v1.md` | 2026-10-31 | يسبق عمل السلسلة والعقود؛ رؤية وليس حالة |

**H-08:** تعارض الحالة ليس مشكلة تجميلية. أي قرار استثماري/هندسي مبني على `docs/STATUS.md` سيكون خاطئًا. يجب توحيد مصدر حقيقة واحد، وتاريخ كل وثيقة، ووسم الوثائق القديمة كـ `STALE`.

---

## 12. خريطة الاعتماديات

### 12.1 الطبقات كما طُلب

```
Blockchain (L1)
   │  upstream cosmos/evm v0.7.3 + config
   ▼
Consensus
   │  CometBFT 0.39.3, 4 validators, 1 host, epoch harness
   ▼
Tokenomics
   │  ❌ غائب: لا supply/issuance/allocation/utility
   ▼
Contracts
   │  7 testnet contracts (sale, vesting, registry, AID, vanity)
   ▼
Market
   │  ❌ غير متصل: bond math + FX hub معزولان
   ▼
Bridge
   │  ❌ ليس جسر بلوكتشين: MCP إلى OpenCode
   ▼
Apps
       Express proxies + faucet + OpenCode UI
```

### 12.2 مصفوفة الاعتماد الفعلية

| الطبقة | تعتمد على | متصلة بـ | الحالة |
|---|---|---|---|
| Blockchain | upstream `evmd`, genesis script | — | config-only |
| Consensus | Blockchain, 4 مفاتيح عامة | — | testnet, 1 host |
| Tokenomics | Blockchain denom | لا شيء | **غائب** |
| Contracts | EVM chain, Foundry | لا توكنوميكس، لا أوراكل | testnet |
| Market | بيانات FX/رياضيات | لا سلسلة، لا عقود | معزول |
| Bridge | OpenCode API | لا سلسلة، لا سوق | أداة تطوير |
| Apps | chain RPC + OpenCode | لا Market Hub | يعمل محليًا |

### 12.3 القراءة الحاسمة

- **لا يوجد مسار** من Market Hub إلى عقد أو أوراكل.
- **لا يوجد مسار** من Tokenomics إلى عقود أو مكافآت.
- **لا يوجد مسار** من AID/Registry إلى السوق أو التسعير.
- **المسار الوحيد** هو Apps → RPC → Chain، وApps → OpenCode.

لذلك، أي وصف لـ "NEXORA core architecture" يجب أن يقول بصراحة: **الطبقات موجودة كأجزاء، لكن التكامل غير موجود.**

---

## 13. جدول المخاطر مرتبًا حسب الشدة

### Critical

| ID | Finding | الدليل | الأثر | الإصلاح |
|---|---|---|---|---|
| **C-01** | `opencodeProxy` يعرض OpenCode للإنترنت بلا مصادقة واردة ويحقن Basic auth | `artifacts/api-server/src/opencodeProxy.ts:144-170, 176-237`; `app.ts:44` | تحكم كامل بالوكيل/الأدوات/مساحة العمل/الأسرار لأي زائر | إزالته من الخادم العام أو وضعه خلف OAuth/JWT + allowlist + rate limit |
| **C-02** | لا توكنوميكس: لا supply/issuance/allocation/vesting/utility/fee policy | `source/docs/economics.md:1-30`; `state.json` supply/inflation | لا أساس لتقييم/حوكمة/إطلاق؛ خطر قانوني وتنظيمي | charter توكنوميكس + مراجعة قانونية |
| **C-03** | لا تدقيق أمني مستقل؛ عقود test-only ومفاتيح mnemonics عامة | `source/docs/MAINNET-READINESS-REPORT.md:139-215`; `source/docs/STATUS.md` | لا يمكن التعامل مع قيمة حقيقية | تدقيق مستقل + إصلاح Critical/High + مفاتيح إنتاج |

### High

| ID | Finding | الدليل | الأثر | الإصلاح |
|---|---|---|---|---|
| **H-01** | `nexoraProxy` يمرر JSON-RPC كاملًا بما فيه `eth_sendRawTransaction` رغم ادعاء read-only | `nexoraProxy.ts:12-17, 157, 175-179` | relay/spam/نشر عقود/معاملات | allowlist للطرق القراءة فقط + اختبارات |
| **H-02** | `refundAll` يحوّل كل الرصيد إلى treasury ولا يعيد للمشترين | `TestSaleVault.sol:188-196` | خسارة أموال المشترين إذا أُعيد استخدامه | حذف/إصلاح + اختبار refund |
| **H-03** | `AidRegistry.register` يثق بـ `chainId` من المستدعي | `AidRegistry.sol:76-91`; `SPEC.md:95-98` | تلويث registry بـ IDs من سلاسل أخرى | `chainId == block.chainid` + اختبار |
| **H-04** | `AssetRegistry.claim` عام first-come دون إثبات ملكية | `AssetRegistry.sol:270-288` | اختطاف/حجب الأسماء | إثبات ملكية أو challenge |
| **H-05** | Faucet rate limit يعتمد على `X-Forwarded-For` القابل للتزوير | `nexoraFaucet.ts:46-52, 104-114` | استنزاف الفاوسيت/تجويع الغاز | remoteAddress/trusted proxy + حد يومي دائم |
| **H-06** | 4 مدققين على جهاز واحد، 0 fault tolerance | `source/docs/STATUS.md`; `MAINNET-READINESS §2.3` | توقف السلسلة عند عطل الجهاز | مدققون موزعون + مفاتيح منفصلة |
| **H-07** | Testnet بنموذج epoch؛ لا genesis/`evmd` في الشجرة النشطة | `run-epoch.sh:1-30`; لا genesis في `source/testnet` | لا يمكن إعادة إنتاج `appHash` أو تدقيق الحالة | commit genesis + pin binary + verify script |
| **H-08** | وثائق حالة متعارضة/قديمة | `docs/STATUS.md` vs `source/docs/STATUS.md`; `SUBSYSTEM-OWNERSHIP`; `AID/SPEC.md:3` | قرارات خاطئة وفقدان مصداقية | مصدر حقيقة واحد + وسم STALE |
| **H-09** | جسر ثانٍ بـ19 أداة (shell/write/screenshot/OAuth) وتكرار مع `source/bridge` | `tools/opencode-bridge/` | سطح هجوم أكبر إذا عُرض | توحيد/تقييد/عدم نشر |
| **H-10** | لا أوراكل ولا ربط بين Market Hub والسلسلة/العقود | `source/market`; `apps/market-data-hub` | لا تسعير on-chain؛ Phase 1 غير مكتمل | تصميم oracle + signed observations |

### Medium

| ID | Finding | الدليل | الأثر | الإصلاح |
|---|---|---|---|---|
| **M-01** | `_cost` ضرب غير محمي من overflow | `TestSaleVault.sol:152-155` | دفع أقل من المطلوب عند حدود كبيرة | `mulDiv`/إزالة unchecked |
| **M-02** | owner يسحب كل الأموال بلا timelock/multisig | `TestSaleVault.sol:171-176` | rug-pull إذا أُعيد استخدامه | multisig + timelock |
| **M-03** | `linkAssetId` عشوائي قبل claim | `AssetRegistry.sol:280-288` | AID خاطئ للمستهلكين | منع قبل claim |
| **M-04** | CREATE2 front-running في `AidFactory` | `AidFactory.sol:72-83` | احتلال عنوان/ملكية | تقييد النشر/توقيع |
| **M-05** | `nexoraDiff({})` يعيد 0 بايت | `repo.mjs:76-92` (تحقق عملي) | أداة مراجعة عمياء | إصلاح args + اختبار |
| **M-06** | Faucet in-memory cooldown + حساب واحد + لا حد يومي | `nexoraFaucet.ts:40-44, 104-114` | restart bypass/استنزاف | تخزين دائم + حدود |
| **M-07** | CORS مفتوح | `app.ts:31` | إساءة استخدام cross-origin | تقييد origins |
| **M-08** | `bech32_prefix = cosmos` | `nexora-devnet.json:7-8` | التباس عناوين/هوية | تغيير مبرمج أو توثيق واضح |
| **M-09** | تضخم 13%→20% بلا وجهة | `state.json`; `economics.md` | سياسة نقدية غير مقصودة | قرار صريح |
| **M-10** | فجوات اختبار: refundAll، foreign chainId، default diff، faucet ليس في CI | `test/`; `source/.github/workflows` | تراجعات | إضافة اختبارات + CI |
| **M-11** | تكرار بوابات RPC (4 نسخ) | `nexora-rpc-gateway.mjs`, `source/scripts/*`, `nexoraProxy.ts` | drift أمني | مصدر واحد |
| **M-12** | `allNames` دائمًا reverts | `AssetRegistry.sol:290-298` | API مضللة | حذف/توثيق indexer |

### Low

| ID | Finding | الدليل | الأثر | الإصلاح |
|---|---|---|---|---|
| **L-01** | `NexoraGreeter` بلا access control | `NexoraGreeter.sol:8-26` | لا شيء إذا test-only | حذف قبل الإطلاق |
| **L-02** | ملف backup `server.js.bak-20261102-timeout-units` | `tools/opencode-bridge/src/` | فوضى/التباس | أرشفة/حذف |
| **L-03** | `nexora.io` ليس ملكًا للمشروع | `source/docs/TOKEN-SALE-SIMULATION.md:9-17` | خطر علامة تجارية | اختيار اسم مملوك |
| **L-04** | لا `.github/workflows` في root؛ CI تحت `source/.github` | `source/.github/workflows` (10 ملفات) | اختبارات غير مربوطة | توحيد CI |
| **L-05** | تقرير Mainnet قديم الأرقام | `MAINNET-READINESS-REPORT.md` (2026-10-13) | تشويش | تحديث مع الحفاظ على الـ blockers |
| **L-06** | `secure-file-handoff` لا يعمل هنا لنقص `cryptography` | `tools/secure-file-handoff/tests/test_handoff.py:12` | بيئة غير مكتملة | تثبيت الاعتماديات |

---

## 14. خارطة الطريق

### P0 — احتواء أمني فوري (0–2 أسابيع)

**الهدف:** إزالة المخاطر التي يمكن استغلالها اليوم، دون بناء ميزات جديدة.

1. **`opencodeProxy`:** إزالته من الخادم العام أو وضعه خلف مصادقة قوية. حتى ذلك الحين، لا تعرض عنوان التطبيق للعامة.
2. **`nexoraProxy`:** allowlist للطرق القراءة فقط؛ حظر `eth_sendRawTransaction` و`broadcast_tx_*` و`unsafe_*`؛ اختبارات تثبت الرفض.
3. **Faucet:** إصلاح `clientKey`، إضافة حد يومي عالمي، تخزين دائم، ومراقبة الرصيد.
4. **`refundAll`:** إصلاح أو حذف + اختبار refund.
5. **`AidRegistry`:** `chainId == block.chainid` + اختبار سلسلة أجنبية.
6. **`AssetRegistry`:** إثبات ملكية claim أو آلية challenge؛ منع `linkAssetId` قبل claim.
7. **`nexoraDiff`:** إصلاح args + اختبار default dirty tree.
8. **الوثائق:** مصدر حقيقة واحد؛ وسم كل وثيقة قديمة بـ `STALE`؛ توحيد `docs/STATUS.md` و`source/docs/STATUS.md`.

**معيار الخروج:** لا سطح إداري/وكيل بلا مصادقة؛ لا كتابة عبر proxy "read-only"؛ لا تجاوز rate limit؛ كل الإصلاحات لها اختبارات.

### P1 — نزاهة وقابلية تدقيق (2–6 أسابيع)

1. **Genesis قابل لإعادة الإنتاج:** commit `genesis.json` (أو checksum + script)، تثبيت `evmd` binary/version، وسكربت `verify-apphash` يعيد إنتاج `appHash` من السجل.
2. **CI موحد:** تشغيل كل الاختبارات (بما فيها faucet) من root workflow؛ منع الدمج عند الفشل.
3. **تحليل ثابت:** Slither/Forge fuzz/invariant للعقود؛ property tests لـ AID.
4. **مراقبة:** chain height، faucet balance، proxy errors، OpenCode sessions؛ تنبيهات.
5. **توحيد البوابات/الجسور:** مصدر واحد لكل وظيفة؛ حذف النسخ والـ backup.
6. **توثيق تشغيلي:** runbook للطوارئ، مفاتيح، نسخ احتياطي، استعادة.

### P2 — إكمال البنية (6–12 أسبوعًا)

1. **توكنوميكس:** charter كامل + مراجعة قانونية.
2. **Oracle/Market:** signed observations، on-chain feed، staleness/quality، ربط Market Hub بالسلسلة.
3. **دورة حياة الأصل:** AID + Registry + sale/vesting + custody + governance.
4. **تدقيق مستقل:** قبل أي قيمة حقيقية؛ إصلاح Critical/High وإعادة تدقيق.
5. **شبكة موزعة:** مدققون على hosts/مشغلين منفصلين، مفاتيح HSM/KMS، نسخ احتياطي، disaster recovery.
6. **Mainnet gate:** لا إطلاق قبل استيفاء `MAINNET-READINESS-REPORT.md` كاملًا.

---

## 15. المرحلة التالية المقترحة

**Phase 2 — Security & Integrity Hardening (P0)**

**النطاق:**

- تأمين `opencodeProxy` و`nexoraProxy` والفاوسيت.
- إصلاح `refundAll` و`AidRegistry.chainId` و`AssetRegistry.claim/link`.
- إصلاح `nexoraDiff`.
- توحيد الوثائق ومصدر الحقيقة.
- إضافة اختبارات الانحدار وربطها بـ CI.

**معايير القبول:**

1. لا يمكن الوصول إلى OpenCode عبر الخادم العام دون مصادقة.
2. `nexoraProxy` يرفض كل طرق الكتابة بـ 403، مع اختبارات.
3. Faucet لا يمكن تجاوزه بتغيير header، وله حد يومي دائم.
4. `refundAll` يعيد لكل مشترٍ أو أُزيل، مع اختبار.
5. `AidRegistry` يرفض `chainId != block.chainid`، مع اختبار.
6. `AssetRegistry` لا يسمح بclaim/link دون إثبات، مع اختبارات.
7. `nexoraDiff({})` يعرض التغييرات غير المرحّلة، مع اختبار.
8. وثيقة حالة واحدة، وكل الوثائق القديمة موسومة.
9. كل الاختبارات تعمل من CI، ونتائجها موثقة.

**ما لن نفعله في Phase 2:** لا Mainnet، لا بيع عام، لا 24/7 hosting، لا تغيير Cloudflare/DNS، لا لمس backup.

---

## 16. ملاحق

### A. أوامر التحقق المستخدمة

```bash
# Contracts
cd source/contracts && PATH=/home/runner/workspace/.foundry/bin:$PATH forge test
# → 70 passed

# AID (Solidity)
cd source/aid && PATH=/home/runner/workspace/.foundry/bin:$PATH forge test
# → 45 passed

# AID (JS)
cd source/aid && node --test test/*.test.mjs
# → 40 passed

# Market
cd source/market && node --test test/*.test.mjs
# → 41 passed

# Bridge
cd source/bridge && node --test test/*.test.mjs
# → 76 passed

# Faucet
node --experimental-strip-types --test artifacts/api-server/tests/nexoraFaucet.test.ts
# → 17 passed

# Market Data Hub
cd apps/market-data-hub && python3 -m unittest discover -s tests -v
# → 89 passed

# OpenCode bridge core
cd tools/opencode-bridge && npm run test:core
# → 16 passed

# Cloudflare edge
cd tools/cloudflare-edge && npm test
# → 15 passed

# Proxy grabber
cd tools/proxy-grabber && python3 -m unittest test_proxy_grabber -v
# → 7 passed

# Testnet consistency
python3 - <<'PY'
import json
L=json.load(open('source/testnet/ledger.json'))
S=json.load(open('source/testnet/state.json'))
assert L['cumulativeBlocks']==sum(x['height'] for x in L['history'])
assert S['height']==L['height'] and S['app_hash']==L['appHash']
print('OK', L['epoch'], L['height'], L['cumulativeBlocks'])
PY
```

### B. جرد الاختبارات

| الحزمة | العدد | الحالة |
|---|---:|---|
| `source/contracts` | 70 | ناجح |
| `source/aid` (Solidity + JS) | 45 + 40 = 85 | ناجح |
| `source/market` | 41 | ناجح |
| `source/bridge` | 76 | ناجح |
| `artifacts/api-server` (faucet) | 17 | ناجح |
| `apps/market-data-hub` | 89 | ناجح |
| `tools/opencode-bridge` (core) | 16 | ناجح |
| `tools/cloudflare-edge` | 15 | ناجح |
| `tools/proxy-grabber` | 7 | ناجح |
| `tools/secure-file-handoff` | 9 | لم تعمل هنا لنقص `cryptography` |
| **الإجمالي المتحقق** | **416** | **ناجح** |

> ملاحظة: الأعداد أعلاه من تشغيل هذه الجلسة. `secure-file-handoff` يحتاج `cryptography` غير المثبتة في بيئة Python الحالية.

### C. ملفات مرجعية

- `source/chain/nexora-devnet.json` — إعدادات السلسلة.
- `source/chain/upstream.md` — إصدارات upstream.
- `source/testnet/ledger.json` — سجل 632 epoch.
- `source/testnet/state.json` — حالة التطبيق.
- `source/contracts/src/TestSaleVault.sol` — عقد البيع.
- `source/contracts/src/AssetRegistry.sol` — سجل الأسماء.
- `source/aid/src/AidRegistry.sol` — سجل AID.
- `source/aid/src/AidFactory.sol` — CREATE2.
- `source/bridge/src/repo.mjs` — أداة diff.
- `artifacts/api-server/src/opencodeProxy.ts` — proxy الوكيل.
- `artifacts/api-server/src/nexoraProxy.ts` — proxy السلسلة.
- `artifacts/api-server/src/nexoraFaucet.ts` — الفاوسيت.
- `docs/STATUS.md` و`source/docs/STATUS.md` — تعارض الحالة.
- `source/docs/MAINNET-READINESS-REPORT.md` — مصفوفة blockers.

### D. ما لم يتم فعله

- لا تعديل كود، لا commit، لا push.
- لا نشر، لا تشغيل خدمات، لا تغيير Cloudflare/DNS/Tunnel.
- لا كشف أسرار.
- لا لمس `.migration-staging/old-project-backup/`.
- لا إضافة ثنائيات Foundry إلى Git.

---

**نهاية التقرير — Phase 1 Audit.**
