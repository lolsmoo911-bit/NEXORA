# NEXORA - Frankfurter Provider/Licensing Evidence

**Date:** 2026-11-01  
**Status:** Factual evidence note only. It does not decide D-008, grant data rights, or close any open decision.  
**Scope:** Current provisional MVP only: Frankfurter v2 blended daily FX reference rates; base `USD`; quotes `EUR`, `GBP`, `JPY`, `CHF`; `expand=providers`. Documentary review only.

---

## 1. Sources and retrieval

All times are UTC. Requests were unauthenticated and used no account. Raw captures are stored under `logs/` and are not edited.

| Source | URL | Retrieved | HTTP | Evidence file | SHA-256 |
|---|---|---|---|---|---|
| Frankfurter licence/terms page | https://frankfurter.dev/license/ | 2026-11-01T01:32:13Z | 200 | `frankfurter-license-20261101T013213Z.html` | `7caca1786d9ae713f5c28b180f34ea988fb7a65a2b74369cb9e300ff558fab4d` |
| Frankfurter home/API FAQ | https://frankfurter.dev/ | 2026-11-01T01:32:13Z | 200 | `frankfurter-home-20261101T013213Z.html` | `1e8718dac660cea52da895026378bcf8f334424ebd4667a01fcd38f3fb76384b` |
| Exact four-quote rates response | `https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR%2CGBP%2CJPY%2CCHF&expand=providers` | 2026-11-01T01:30:39Z | 200 | `frankfurter-rates-20261101T013039Z.json` | `ddbf8320d1ea5a7d6e64133d0cd9216ad3ebed69f18d615eab06f3f0806b9666` |
| Provider metadata | `https://api.frankfurter.dev/v2/providers` | 2026-11-01T01:30:39Z | 200 | `frankfurter-providers-20261101T013039Z.json` | `426b7ceb53750e9edd697f406b4e8c4e3c0042ad36243dc40f5a44e75c60165e` |

The licence page was also read through its rendered documentation at https://frankfurter.dev/license/. The provider-terms table is the table on that page. Provider names, terms status, and terms links below were matched from that table to the provider metadata by exact provider name.

## 2. Official statements

### 2.1 Software licence

> Frankfurter's code, docs, and Docker images are open source under the [MIT License](https://github.com/lineofflight/frankfurter/blob/main/LICENSE).

This is a software/artifact licence. It does not license the underlying rate data.

### 2.2 Blended API FAQ

> Yes. Blended rates are Frankfurter's own calculation and free to use. Direct queries to individual provider endpoints remain subject to each provider's terms.

> Yes. Storing daily observations locally for caching or historical analytics is encouraged to keep API traffic light.

> There are no quotas. Requests are rate-limited to prevent abuse, but there are no monthly or daily caps. For high-volume use, consider caching responses, self-hosting, or querying the datasets directly.

> Almost all are. Some sources provide weekly, monthly, or quarterly observations. These sources are excluded from the blended feed. Query them directly with the providers filter.

> The API returns mid-market rates. When a provider publishes bid and ask quotes instead of a reference rate, Frankfurter stores both and calculates the midpoint.

### 2.3 Data ownership, provider terms, and blended calculation

> Frankfurter doesn't own the rates, so it can't give you rights the provider doesn't. If a provider publishes terms of use, they apply.

> Blended rates are Frankfurter's own calculation, not an official rate from any institution.

> Rates and the API come as is, with no warranty. Rates can be late, missing, or revised.

## 3. Four-quote MVP observation

Exact request: `GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR%2CGBP%2CJPY%2CCHF&expand=providers`

The response was HTTP 200, JSON, four rows. Each row is a blended Frankfurter rate; the `providers` array lists provider records used in or excluded from that row's blend.

| Pair | Observation date | Blended rate | Provider records | Included | Excluded |
|---|---|---|---:|---:|---:|
| `USD/CHF` | 2026-10-31 | 0.82476 | 79 | 78 | 1 |
| `USD/EUR` | 2026-10-31 | 0.89485 | 89 | 88 | 1 |
| `USD/GBP` | 2026-10-31 | 0.74793 | 87 | 86 | 1 |
| `USD/JPY` | 2026-10-31 | 157.66 | 85 | 82 | 3 |

Unique provider keys observed in the captured response: **89**. This is a count of provider records, not a count of providers contributing to every pair. Keys with at least one `excluded: true` record: `BCC, CBG, CBM, CBTT`.

Observed provider keys are taken only from this exact response. They are not inferred from the global `/v2/providers` list or from currency-coverage metadata.

### 3.1 Excluded provider records in the capture

These records are present in the captured response but were not blended into the row's rate.

| Pair | Provider key | Provider date | Provider rate | State |
|---|---|---|---|---|
| `USD/CHF` | `CBTT` | 2026-10-28 | 0.7781 | `excluded: true` |
| `USD/EUR` | `CBTT` | 2026-10-30 | 0.80626 | `excluded: true` |
| `USD/GBP` | `CBTT` | 2026-10-30 | 0.70833 | `excluded: true` |
| `USD/JPY` | `BCC` | 2026-10-30 | 3677.78 | `excluded: true` |
| `USD/JPY` | `CBG` | 2026-10-29 | 1.5845 | `excluded: true` |
| `USD/JPY` | `CBM` | 2026-10-30 | 1.5733 | `excluded: true` |

The `Excluded?` column in the provider-record tables below is `Yes` only if at least one record for that key was excluded; it does not mean the provider was excluded from every pair.

## 4. Provider records observed in the captured four-quote response - licence-page status

The tables below contain only provider keys that appear in the exact captured four-quote response. The status and link are copied from the official Frankfurter licence-page provider-terms table. `Excluded?` means at least one record for that key had `excluded: true`; a provider may still have included records in other quote rows.

### 4.1 Observed providers with a linked Terms entry

| Key | Provider | Observed quotes | Cadence | Provider date(s) | Excluded? | Licence-page status/link |
|---|---|---|---|---|---|---|
| `BANXICO` | Banco de México | EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.banxico.org.mx/footer-en/terms-and-conditions.html) |
| `BCCCD` | Banque Centrale du Congo | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bcc.cd/mentions-legales) |
| `BCEAO` | Banque Centrale des Etats de l'Afrique de l'Ouest | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bceao.int/fr/mentions-legales) |
| `BCRA` | Banco Central de la República Argentina | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bcra.gob.ar/aviso-legal/) |
| `BCU` | Banco Central del Uruguay | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bcu.gub.uy/Paginas/Condiciones-de-uso.aspx) |
| `BCV` | Banco Central de Venezuela | EUR, JPY | daily | 2026-10-30 | No | [Terms](https://www.bcv.org.ve/terminos-condiciones) |
| `BDL` | Banque du Liban | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bdl.gov.lb/disclaimer.php) |
| `BFM` | Banky Foiben'i Madagasikara | CHF, EUR, GBP, JPY | daily | 2026-10-26 | No | [Terms](https://www.banky-foibe.mg/mentions-legales) |
| `BM` | Banco de Mocambique | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bancomoc.mz/pt/informacao-legal/) |
| `BNRRW` | Banque Nationale du Rwanda | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bnr.rw/statuse) |
| `BOB` | Bank of Botswana | EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bankofbotswana.bw/content/disclaimer) |
| `BOC` | Bank of Canada | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.bankofcanada.ca/terms/) |
| `BOE` | Bank of England | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | [Terms](https://www.bankofengland.co.uk/legal) |
| `BOI` | Bank of Israel | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.boi.org.il/en/terms-of-use) |
| `BOJ` | Bank of Japan | EUR, JPY | daily | 2026-10-28 | No | [Terms](https://www.stat-search.boj.or.jp/info/api_notice_en.pdf) |
| `BOJA` | Bank of Jamaica | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://boj.org.jm/disclaimer/) |
| `BOMU` | Bank of Mauritius | CHF, EUR, GBP, JPY | daily | 2026-10-22 | No | [Terms](https://www.bom.mu/disclaimer) |
| `CBBH` | Central Bank of Bosnia and Herzegovina | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | [Terms](https://www.cbbh.ba/Content/Read/473) |
| `CBE` | Central Bank of Egypt | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | [Terms](https://www.cbe.org.eg/en/disclaimer) |
| `CBKKW` | Central Bank of Kuwait | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | [Terms](https://www.cbk.gov.kw/en/footer/disclaimer) |
| `CBN` | Central Bank of Nigeria | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.cbn.gov.ng/Legal.html) |
| `CBO` | Central Bank of Oman | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | [Terms](https://cbo.gov.om/Pages/Disclaimer.aspx) |
| `CBR` | Central Bank of Russia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.cbr.ru/eng/user_agreement/) |
| `CBSSC` | Central Bank of Seychelles | EUR, GBP | daily | 2026-10-30 | No | [Terms](https://www.cbs.sc/Disclaimer.html) |
| `CBTT` | Central Bank of Trinidad and Tobago | CHF, EUR, GBP | daily | 2026-10-28, 2026-10-30 | Yes | [Terms](https://www.central-bank.org.tt/copyright-notice/) |
| `CFETS` | China Foreign Exchange Trade System | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.chinamoney.com.cn/english/homflkdcm/) |
| `CNB` | Czech National Bank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.cnb.cz/en/footer/general-terms-and-conditions/) |
| `ECB` | European Central Bank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html) |
| `ESTV` | Swiss Federal Tax Administration | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | [Terms](https://www.admin.ch/gov/en/start/terms-and-conditions.html) |
| `FBIL` | Financial Benchmarks India | EUR, GBP, JPY | daily | 2026-10-23 | No | [Terms](https://www.fbil.org.in/#/termsandcondition) |
| `FRED` | Federal Reserve Bank of St. Louis | CHF, EUR, GBP, JPY | weekly | 2026-10-23 | No | [Terms](https://fred.stlouisfed.org/legal/) |
| `IMF` | International Monetary Fund | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.imf.org/en/about/copyright-and-terms) |
| `NB` | Norges Bank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.norges-bank.no/en/topics/Statistics/disclaimer/) |
| `NBS` | Narodna banka Srbije | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.nbs.rs/en/copyright/index.html) |
| `NBU` | Natsionalnyi Bank Ukrainy | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://bank.gov.ua/en/useterms) |
| `PMA` | Palestine Monetary Authority | CHF, EUR, GBP, JPY | daily | 2026-10-28 | No | [Terms](https://www.pma.ps/terms-of-use) |
| `RB` | Sveriges Riksbank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.riksbank.se/en-gb/about-the-website/terms-of-use/) |
| `RBA` | Reserve Bank of Australia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.rba.gov.au/copyright/) |
| `TCMB` | Türkiye Cumhuriyet Merkez Bankası | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | [Terms](https://www.tcmb.gov.tr/wps/wcm/connect/EN/TCMB+EN/Bottom+Menu/Other/Disclaimer) |

Subtotal: **39** observed provider keys with a linked Terms entry. The linked terms were not audited or accepted in this task; no permission or redistribution right is inferred.

### 4.2 Observed providers with "None published"

| Key | Provider | Observed quotes | Cadence | Provider date(s) | Excluded? | Licence-page status/link |
|---|---|---|---|---|---|---|
| `AMCM` | Autoridade Monetária de Macau | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BAM` | Bank Al-Maghrib | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BCB` | Banco Central do Brasil | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BCBO` | Banco Central de Bolivia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BCC` | Banco Central de Cuba | CHF, EUR, GBP, JPY | daily | 2026-10-30 | Yes | None published |
| `BCCH` | Banco Central de Chile | EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BCP` | Banco Central del Paraguay | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BCT` | Banque Centrale de Tunisie | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | None published |
| `BDI` | Banca d'Italia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BI` | Bank Indonesia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BNA` | Banco Nacional de Angola | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BNM` | Bank Negara Malaysia | CHF, EUR, GBP, JPY | daily | 2026-10-29, 2026-10-30 | No | None published |
| `BNR` | Banca Națională a României | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BOM` | Bank of Mongolia | CHF, EUR, GBP, JPY | monthly | 2026-10-26 | No | None published |
| `BOT` | Bank of Thailand | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `BOTA` | Bank of Tanzania | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | None published |
| `BOZ` | Bank of Zambia | EUR, GBP | daily | 2026-10-30 | No | None published |
| `BRB` | Banque de la Republique du Burundi | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBA` | Central Bank of Armenia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBAR` | Central Bank of the Republic of Azerbaijan | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBG` | Central Bank of The Gambia | CHF, EUR, GBP, JPY | daily | 2026-10-29, 2026-10-30 | Yes | None published |
| `CBI` | Central Bank of Iraq | CHF, EUR, GBP, JPY | daily | 2026-10-28 | No | None published |
| `CBK` | Central Bank of Kenya | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBM` | Central Bank of Myanmar | CHF, EUR, GBP, JPY | daily | 2026-10-30 | Yes | None published |
| `CBS` | Central Bank of Samoa | EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBSL` | Central Bank of Sri Lanka | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `CBU` | Central Bank of Uzbekistan | CHF, EUR, GBP, JPY | daily | 2026-10-22 | No | None published |
| `DAB` | Da Afghanistan Bank | CHF, EUR, GBP | daily | 2026-10-31 | No | None published |
| `DNB` | Danmarks Nationalbank | CHF, EUR, GBP, JPY | daily | 2026-10-29 | No | None published |
| `HNB` | Hrvatska Narodna Banka | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | None published |
| `LB` | Lietuvos Bankas | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `MAS` | Monetary Authority of Singapore | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `MNB` | Magyar Nemzeti Bank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBC` | National Bank of Cambodia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBE` | National Bank of Ethiopia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBG` | National Bank of Georgia | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBK` | National Bank of Kazakhstan | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBKR` | National Bank of the Kyrgyz Republic | CHF, EUR, GBP, JPY | daily | 2026-10-24, 2026-10-30 | No | None published |
| `NBM` | National Bank of Moldova | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBP` | Narodowy Bank Polski | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBRB` | Natsyyanalny Bank Respubliki Belarus | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `NBRM` | Narodna Banka na Republika Severna Makedonija | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | None published |
| `NBT` | National Bank of Tajikistan | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | None published |
| `NRB` | Nepal Rastra Bank | CHF, EUR, GBP, JPY | daily | 2026-10-31 | No | None published |
| `NRBT` | National Reserve Bank of Tonga | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `RBF` | Reserve Bank of Fiji | CHF, EUR, GBP, JPY | daily | 2026-10-27 | No | None published |
| `RBM` | Reserve Bank of Malawi | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `RBV` | Reserve Bank of Vanuatu | EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `SARB` | South African Reserve Bank | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |
| `SBI` | Seðlabanki Íslands | CHF, EUR, GBP, JPY | daily | 2026-10-30 | No | None published |

Subtotal: **50** observed provider keys with "None published" on the Frankfurter licence page. "None published" means no terms link was found on that page for that provider. It is not a grant, waiver, or evidence of public-domain status.

## 5. Bank of Algeria lookup row - not observed

Bank of Algeria is **not** in the captured four-quote response. It is recorded here only because the official licence-page provider-terms table lists it, and the exact status must not be mistaken for part of the MVP feed.

| Key | Provider | Observed in this capture? | Cadence metadata | Licence-page status/link |
|---|---|---|---|---|
| `BOA` | Bank of Algeria | **No - not observed in this capture** | monthly | None published |

The exact licence-page status is **"None published"**. That is only the absence of a published terms link on Frankfurter's page. It is not a grant of rights and not proof of public-domain status.

## 6. Retention and redistribution facts - and non-decisions

- **Software:** Frankfurter code, docs, and Docker images are MIT-licensed. This does not license rate data.
- **Blended API:** The FAQ says blended rates are Frankfurter's own calculation and free to use commercially. The same FAQ says direct provider endpoints remain subject to each provider's terms.
- **Caching:** The FAQ encourages storing daily observations locally for caching or historical analytics.
- **Quotas:** No fixed monthly or daily quotas; anti-abuse rate limiting applies.
- **Cadence:** Rates are usually daily; some providers publish weekly, monthly, or quarterly observations and are excluded from the blended feed.
- **Price type:** Mid-market; provider data is aggregated/blended unless explicitly filtered. Blended values are not an official rate from any institution.
- **Provider layer:** Frankfurter does not own the underlying rates and cannot grant provider rights. Provider terms apply where published.
- **Missing terms:** "None published" is not permission. It leaves the provider's terms unresolved.
- **No policy decision:** This note does not decide retention duration, display, derived use, or redistribution. **D-008 remains OPEN.** No provider filtering or redistribution is enabled.
- **Approval:** Legal/product owner approval is still required wherever provider terms remain unclear.

## 7. Unresolved items

- D-008: retention, display, derived use, and redistribution rights remain undecided.
- The 39 linked provider terms entries were not read, audited, or accepted; they may impose conditions not captured here.
- The 50 observed providers with "None published" have unresolved terms; absence of a link is not permission.
- Bank of Algeria is a lookup-only row, not an observed provider record in this capture.
- D-001 (final provider) and D-002 (final asset class) remain open; this is the provisional MVP only.
- Rates and the API are provided as-is with no warranty and may be late, missing, or revised.
- Provider terms can change; re-verify before any policy or product decision.

## 8. Scope guard

This review changed documentation only. It did not change application behavior, enable provider filtering, create a redistribution service, add trading/live-money functions, or close D-008.

No secrets are included in this note or in the raw captures.
