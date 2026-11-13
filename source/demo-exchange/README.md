# NEXORA Exchange Sim (Experimental)

منصة تداول تجريبية محلية (محاكاة) لاختبار وحدات NEXORA (إصدار الأصول، التسعير، المطابقة، المحافظ، الفهرسة) بواجهة شبيهة بمنصات التداول (Spot demo).

> **تنبيه:** محاكاة محلية فقط — لا أموال حقيقية، لا أصول حقيقية، لا بيانات سوق حية، لا حفظ/وصاية، ولا نشر عام.

## التشغيل (محلي)

```bash
node source/demo-exchange/server.mjs
```

ثم افتح: `http://127.0.0.1:4173`

متغير اختياري:
- `PORT=4173` (افتراضي)

## الميزات (MVP تجريبي)
- أسواق/أصول محاكاة (XAUUSD, BTCUSD, EURUSD)
- دفتر أوامر (Bids/Asks) وصفقات حديثة
- إنشاء أوامر Limit (Buy/Sell) مع مطابقة محاكاة
- محافظ/أرصدة/مراكز وPnL تقريبي (محاكاة)
- تحديث سعر Mark (محاكاة) وإيداع تجريبي
- واجهة Web محلية بسيطة

## APIs (محلية)
- `GET /api/health`
- `GET /api/markets`
- `GET /api/orderbook?instrument=XAUUSD`
- `GET /api/trades?instrument=XAUUSD`
- `GET /api/portfolio?account=alice`
- `POST /api/orders`
- `POST /api/orders/cancel`
- `POST /api/deposit`
- `POST /api/price`
- `GET /api/snapshot`

## القيود
- مطابقة وتنفيذ محاكاة داخل الذاكرة (in-memory) لأغراض الاختبار.
- لا يوجد مصادقة إنتاجية، لا KYC/AML، لا سيولة حقيقية، ولا تكامل سوق حي.
- ليس بديلاً عن منصة تداول إنتاجية (Binance/Bybit)؛ هو نموذج تجريبي لاختبار المشروع.
