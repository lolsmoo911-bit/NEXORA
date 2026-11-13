# NEXORA Chain-Backed Demo Exchange (Experimental)

منصة تداول تجريبية **متصلة بالشبكة الفعلية** — devnet محلي حقيقي (evmd، EVM chain `902024` / `0xdc388`) وعقود توكنات حقيقية على السلسلة (`AssetToken` ×4 + `MockOracle`)، بواجهة شبيهة بمنصات التداول (Spot demo).

> **تنبيه:** testnet/devnet محلي على `127.0.0.1` فقط — توكنات اختبار بلا قيمة، لا أموال حقيقية، لا أصول حقيقية، لا بيانات سوق حية مدفوعة، لا حفظ/وصاية، ولا نشر عام.

## البنية (نمط البورصات الحقيقية)

| الطبقة | التنفيذ |
|---|---|
| المطابقة (matching) | خارج السلسلة — `source/exchange/src/matching-engine.mjs` (دفتر أوامر في الذاكرة) |
| الأرصدة | **على السلسلة** — `eth_call balanceOf` هو مصدر الحقيقة (لا بيانات محفظة وهمية) |
| الإيداع | **على السلسلة** — `mint` حقيقي من مفاتيح الـ admin مع txHash |
| التسوية عند كل تنفيذ | **على السلسلة** — تحويلان ERC20 حقيقيان (quote + base) مع txHash لكل تنفيذ |
| الأسعار (Mark) | **على السلسلة** — `MockOracle.pushPrice` معاملات حقيقية (مقياس 10^8) |
| سيولة صانع السوق | حساب `mm` يوفر أوامر تقييدية على الجانبين (keeper يُعيد التسعير) |

- كل معاملات المفاتيح المُدارة من السيرفر تمر عبر طابور تسلسلي لتفادي سباقات الـ nonce.
- الحجوزات (locks): كل أمر مفتوح يحجز nUSD (شراء) أو توكن الأصل (بيع) في الذاكرة، والتحقق يتم مقابل رصيد السلسلة الفعلي قبل القبول.
- مفاتيح حسابات العرض (alice/bob/mm) اختبارية مولدة محليًا وتبقى في `/tmp` (ملف الحالة) ولا تُكشف عبر الـ API أبدًا.

## التشغيل (محلي)

```bash
# 1) تهيئة الشبكة + نشر العقود + السك (idempotent — يتجاوز العمل إذا كانت الشبكة تعمل)
node source/demo-exchange/chain/bootstrap.mjs        # (--force لإعادة التهيئة)

# 2) تشغيل المنصة
node source/demo-exchange/server.mjs
```

ثم افتح: `http://127.0.0.1:4173`

متغيرات اختيارية:
- `PORT=4173`
- `CHAIN_STATE=/tmp/opencode/demo-chain-state.json`
- `CAST_BIN` (مسار cast)

ملف الحالة (`/tmp/opencode/demo-chain-state.json`) يحتوي عناوين العقود وحسابات العرض والأوراكل ويُنشأ من bootstrap فقط.

## الحسابات التجريبية

| الحساب | الدور |
|---|---|
| `alice`, `bob` | متداولون |
| `mm` | صانع سوق (سيولة على الجانبين) |
| `dev0` | admin/operator (mint + أوراكل) — يُستخدم داخليًا |
| `mykey` | validator (خارج نطاق التداول) |

## الميزات
- أسواق على توكنات حقيقية: nXAU/nUSD، nBTC/nUSD، nEUR/nUSD (العملة النقدية nUSD)
- دفتر أوامر وصفقات حديثة **مع txHash لكل تسوية**
- أوامر Limit (Buy/Sell) مع تحقق أرصدة on-chain وحجوزات
- إيداع = mint حقيقي على السلسلة (nUSD/nXAU/nBTC/nEUR)
- دفع سعر Mark → معاملة `MockOracle.pushPrice` حقيقية
- محافظ تقرأ من السلسلة + تتبع متوسط تكلفة/PnL في الذاكرة من الصفقات
- واجهة Web محلية تعرض chainId والعقود والأرصدة on-chain وtxHashes

## APIs (محلية)
- `GET /api/health` — وضع chain: chainId 902024، الكتلة، عناوين العقود
- `GET /api/markets` — الأسواق مع سعر الـ mark (من الأوراكل أو آخر صفقة)
- `GET /api/orderbook?instrument=XAUUSD`
- `GET /api/trades?instrument=XAUUSD` — كل تنفيذ مع `settlement.{quote,base}.txHash`
- `GET /api/portfolio?account=alice` — أرصدة on-chain + مراكز + PnL
- `GET /api/network` — نفس معلومات health
- `POST /api/orders` `{account, instrument, side, price, quantity}`
- `POST /api/orders/cancel` `{orderId}`
- `POST /api/deposit` `{account, symbol, amount}` → mint حقيقي
- `POST /api/price` `{instrument, price}` → pushPrice حقيقي

## القيود
- المطابقة داخل الذاكرة: إعادة تشغيل السيرفر تعيد بناء الدفتر من keeper، لكن مراكز/متوسط التكلفة والصفقات القديمة تُفقد (الأرصدة على السلسلة تبقى مصدر الحقيقة).
- التسوية متزامنة (تحويلان لكل تنفيذ) — مناسبة للعرض، ليست للأداء الإنتاجي.
- لا مصادقة إنتاجية، لا KYC/AML، لا سيولة حقيقية، لا تكامل سوق حي.
- ليس بديلاً عن منصة تداول إنتاجية (Binance/Bybit)؛ نموذج تجريبي لاختبار سلسلة NEXORA وتوكناتها.
