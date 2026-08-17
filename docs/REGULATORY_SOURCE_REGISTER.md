# NoahArk — Regulatory Source Register

> Phase 0R.1 (source remediation). Governance of statutory/regulatory requirements
> for SG/MY/ID only. **No statutory formula has been invented or implemented.**
> Verification attempted: **2026-08-17**.

## 1. Source-type classification (applied to every row)

- `PRIMARY OFFICIAL` — government agency, statutory body, legislation portal or
  official technical SDK/API documentation, **whose retrieved content directly
  supports the assertion**.
- `SECONDARY — NOT AUTHORITATIVE` — commercial software vendors, accounting /
  consulting / law firms, blogs, news, aggregators. **Discovery reference only.
  Never the final authority.**
- `UNSOURCED` — asserted without a recorded source.
- `SOURCE INACCESSIBLE` — the primary URL is known, but content could not be
  retrieved (JS-rendered portal, 403/404, binary PDF). Treated as **unverified**.
- `SPECIALIST CONFIRMATION REQUIRED` — needs qualified tax/payroll/legal sign-off.

## 2. Requirement classification

`VERIFIED REQUIREMENT` · `PRELIMINARY REQUIREMENT` · `RESEARCH REQUIRED` ·
`SPECIALIST CONFIRMATION REQUIRED` · `FUTURE-DATED REQUIREMENT` · `OUT OF SCOPE`

**Rule:** an item is `VERIFIED` **only** where a `PRIMARY OFFICIAL` source was
retrieved and its content directly supports the assertion. Everything else is
unverified and **must not become an implementation requirement**.

## 3. Verification outcome summary (2026-08-17)

Automated retrieval of authority portals was largely unsuccessful: IRAS, IMDA,
MyInvois SDK sub-pages, MySST detail pages, CPF PDF and BPJS pages are
JS-rendered, bot-protected (403), moved (404) or binary. **Only the items in §4
were confirmed from primary sources.** All previously recorded rates, thresholds
and mandate dates that rested on secondary sources have been **removed from the
requirement documents** and downgraded here.

## 4. PRIMARY OFFICIAL — content retrieved and directly supporting

| # | Country | Requirement | Primary source | What the source directly supports | Class |
|---|---|---|---|---|---|
| P1 | SG | CPF contribution rates | [cpf.gov.sg — How much CPF contributions to pay](https://www.cpf.gov.sg/employer/employer-obligations/how-much-cpf-contributions-to-pay) | Rates **effective 1 Jan 2026**, monthly wages > $750: ≤55 → 17% employer / 20% employee (37%); >55–60 → 16%/18% (34%); >60–65 → 12.5%/12.5% (25%); >65–70 → 9%/7.5% (16.5%); >70 → 7.5%/5% (12.5%). New rates apply from the first day of the month after the 55th/60th/65th/70th birthday. | VERIFIED |
| P2 | SG | CPF future change | same as P1 | A further increase to CPF contribution rates **from 1 Jan 2027** | VERIFIED / FUTURE-DATED |
| P3 | MY | SST changes from 1 Jul 2025 | [mof.gov.my — press release](https://www.mof.gov.my/portal/en/news/press-release/targeted-revision-of-sales-tax-rate-and-expansion-of-service-tax-scope-effective-1-july-2025) | Sales Tax rate **unchanged for essential goods**; **5% or 10%** on discretionary/non-essential goods. Service Tax scope expanded to **leasing/rental, construction, financial services, private healthcare, education, beauty**. **No prosecution or penalties until 31 Dec 2025** for complying businesses. Release states detailed thresholds/exemptions follow in subsidiary legislation/guidelines. | VERIFIED |
| P4 | MY | SST framework update date | [mysst.customs.gov.my](https://mysst.customs.gov.my/) | "Starting from **1 July 2025**, Malaysia's SST framework will be updated to broaden the tax base" | VERIFIED (date/intent only) |
| P5 | ID | Coretax operative | [pajak.go.id](https://www.pajak.go.id/en) | Coretax is the DJP system in operational use (annual return filing via Coretax; account activation references) | VERIFIED (existence/status only) |
| P6 | SG | InvoiceNow endpoint year | [iras.gov.sg newsroom (COS 2026)](https://www.iras.gov.sg/news-events/newsroom/committee-of-supply-2026--extension-of-gst-invoicenow-requirement-to-all-gst-registered-businesses-by-april-2031) | IRAS-published page title: *Extension of GST InvoiceNow Requirement to All GST-registered Businesses by April 2031*. **Title-level only — body not retrieved**, so intermediate phase dates remain unverified. | PRELIMINARY |
| P7 | SG | InvoiceNow framework exists | [imda.gov.sg](https://www.imda.gov.sg/how-we-can-help/nationwide-e-invoicing-framework) | IMDA runs the Nationwide E-Invoicing Initiative / InvoiceNow; a Technical Playbook exists. **No PINT SG version retrieved.** | PRELIMINARY |
| P8 | MY | MyInvois SDK exists | [sdk.myinvois.hasil.gov.my](https://sdk.myinvois.hasil.gov.my/) | Official SDK documents APIs for taxpayer ERP integration with MyInvois. **No phases/lifecycle/version retrieved.** | PRELIMINARY |

## 5. SOURCE INACCESSIBLE — primary URL known, content not retrievable

These must be manually verified (human browser / official PDF / direct request)
before the corresponding country phase begins.

| Country | Requirement | Primary URL | Retrieval result |
|---|---|---|---|
| SG | **Current GST rate & treatments** | iras.gov.sg → GST → Current GST rates | Nav-only (JS-rendered) |
| SG | GST InvoiceNow phase detail | iras.gov.sg → GST InvoiceNow Requirement | Nav-only |
| SG | CPF **Ordinary/Additional Wage ceilings** | cpf.gov.sg rate tables (PDF) | Binary PDF, not parsed |
| SG | SDL / FWL / SHG / IR8A-AIS | ssg.gov.sg, mom.gov.sg, iras.gov.sg | Not retrieved |
| MY | SST rates by class & registration thresholds | mysst.customs.gov.my → SST Orders / Guides | Detail pages not retrieved |
| MY | MyInvois phases, document types, cancellation window | sdk.myinvois.hasil.gov.my/einvoicingoverview, /documents | **404 / 403** |
| MY | EPF / SOCSO / EIS / PCB-MTD / HRD Corp schedules | kwsp.gov.my, perkeso.gov.my, hasil.gov.my, hrdcorp.gov.my | Not retrieved |
| ID | **PPN rate & effective-rate (DPP) mechanism** | pajak.go.id → tax rates / PP 1/2025 | Not retrieved |
| ID | Faktur Pajak / Coretax schema, NSFP, lifecycle | coretaxdjp.pajak.go.id | Not retrieved |
| ID | PPh 21 TER tables & PTKP (PMK 168/2023) | pajak.go.id / MoF legislation portal | Not retrieved |
| ID | BPJS Kesehatan & Ketenagakerjaan rates | bpjs-kesehatan.go.id, bpjsketenagakerjaan.go.id | **404** |
| ID | THR | kemnaker.go.id | Not retrieved |
| SG/MY/ID | Data-protection & retention obligations | pdpc.gov.sg, pdp.gov.my, ID legislation portal | Not retrieved |

## 6. SECONDARY — NOT AUTHORITATIVE (discovery references only)

The following were used **only to locate topics and authorities** during Phase 0R.
They are **not authoritative** and **no requirement may rest on them**. Every figure
previously drawn from these has been removed from the requirement documents.

- Commercial tax/e-invoicing vendors and aggregators (e.g. Avalara, Comarch,
  Pagero/Thomson Reuters, vatcalc, VATupdate, ClearTax, invoicing-guide sites).
- Accounting / consulting / corporate-services firms (e.g. Hawksford, Acclime,
  AYP, Papaya Global, payroll-calculator sites).
- Law-firm and professional commentary (e.g. CMS, DLA Piper, Rahmat Lim,
  Christopher & Lee Ong, Schinder, ARMA Law).
- News/blog articles.

**Figures removed as secondary-only (must not be implemented):** SG CPF Ordinary
Wage ceiling values; SG InvoiceNow intermediate phase dates; MY service-tax
6%/8% rates and "Group H"; MY SST registration thresholds; MY MyInvois phase
dates, RM1m exemption and Phase-4 relaxation to 2027; MY EPF/SOCSO/EIS/HRD Corp
percentages and wage ceilings; ID PPN 12% headline and ~11% effective rate; ID
PPh 21 TER details; ID BPJS percentages; ID NPWP-16/NIK effective date; ID UU PDP
enforcement date; MY PDPA amendment phase dates.

## 7. Requirements that must be confirmed before their country phase starts

**Singapore (before Phase 11 / 14)**
1. Current GST rate and treatment categories (IRAS) — *previously asserted as 9%;
   now unverified pending primary retrieval.*
2. GST InvoiceNow phased dates and per-business notification mechanism (IRAS).
3. InvoiceNow / Peppol **PINT SG** specification version (IMDA playbook).
4. CPF Ordinary & Additional Wage ceilings (CPF Board rate tables).
5. SDL rate/basis; FWL categories; SHG schedules; IR8A/AIS field spec.
6. PDPA obligations incl. cross-border transfer; statutory retention periods.

**Malaysia (before Phase 12 / 15)**
1. Service tax **rates** by group and **registration thresholds** (RMCD subsidiary
   legislation/guides) — MOF release confirms scope expansion but not rates.
2. Sales tax rate application by goods class (5%/10% confirmed as rate options).
3. MyInvois phases/thresholds, document types, validation, **cancellation window**,
   rejection/correction lifecycle, API version (MyInvois SDK).
4. EPF, SOCSO, EIS, PCB/MTD, HRD Corp current schedules and ceilings.
5. PDPA (as amended) obligations; statutory retention.

**Indonesia (before Phase 13 / 16)**
1. **PPN rate and the effective-rate (DPP nilai lain) mechanism** — highest risk;
   DJP/MoF regulation text required.
2. Coretax e-invoice schema, NSFP numbering, clearance API, channels and
   correction/cancellation lifecycle.
3. Withholding categories (PPh 21/23/26/4(2)) and bukti potong requirements.
4. PPh 21 TER tables and PTKP thresholds (effective-dated).
5. BPJS Kesehatan and Ketenagakerjaan contribution rates, bases and caps.
6. THR rules; NPWP/NIK/NITKU requirements; UU PDP obligations incl. cross-border;
   statutory retention.

## 8. Governance rules (standing)

For every regulatory requirement NoahArk implements, record: country · authority ·
requirement name · **official source URL** · document/API version · publication
date · effective date · date accessed · implementation impact · specialist
confirmation status · source-type classification.

Statutory rule sets are **versioned, effective-dated and platform-maintained**; the
exact configuration used in a completed calculation is preserved
(PAYROLL_ARCHITECTURE.md, ACCOUNTING_ARCHITECTURE.md).

**NoahArk does not claim compliance by listing a requirement.** No statutory
calculation or submission may be implemented until its source row here is
`PRIMARY OFFICIAL` **and** specialist-confirmed.
