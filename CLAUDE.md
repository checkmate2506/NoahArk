\# NoahArk Project Instructions



\## Project identity



Project name: NoahArk



Authoritative local repository:



D:\\Claude\\NoahArk



Authoritative GitHub repository:



https://github.com/checkmate2506/NoahArk



NoahArk is a new, independent, greenfield, multi-tenant business-management

platform.



It is not an extension of any existing CRM, POS or ERP solution.



\## Absolute repository boundary



Claude may work only inside:



D:\\Claude\\NoahArk



The following locations are explicitly prohibited:



\- D:\\CRM

\- D:\\POS

\- Any other folder under D:\\Claude

\- Any parent or sibling directory

\- Any Git repository other than NoahArk



Claude must never:



\- Search, list, read or inspect D:\\CRM or D:\\POS.

\- Search D:\\ or D:\\Claude for another implementation.

\- Read files from any sibling project.

\- Copy code, schemas, migrations, tests or configuration from another project.

\- Connect to another project's database or services.

\- Modify another repository.

\- Run Git commands against another repository.

\- Treat an existing CRM, POS or ERP as authoritative.

\- Add another repository as a package, workspace, dependency or submodule.



If NoahArk contains only a README and project instructions, that is intentional.



An empty or nearly empty repository is not permission to search elsewhere.



If information is missing, treat it as a greenfield design decision or ask the

user. Never obtain missing information by inspecting another local repository.



\## PMSuite reference restriction



PMSuite may be used only as a public functional and product reference:



\- https://pmsuite.co/

\- https://pmsuite.co/features

\- https://pmsuite.co/roadmap



Do not copy:



\- PMSuite's name

\- Branding

\- Marketing text

\- Source code

\- Proprietary assets

\- Screenshots

\- Exact visual design

\- Database structure



NoahArk must have an independently designed architecture, user experience and

brand identity.



\## Mandatory repository preflight



At the beginning of every phase, execute:



1\. git rev-parse --show-toplevel

2\. git remote get-url origin

3\. git branch --show-current

4\. git status --short

5\. git rev-parse HEAD



Required repository root:



D:/Claude/NoahArk



Required remote:



https://github.com/checkmate2506/NoahArk.git



If either value differs, stop immediately.



Do not search for the correct repository and do not inspect the current incorrect

repository.



\## Git restrictions



Unless explicitly authorised by the user for the current phase:



\- Do not commit.

\- Do not push.

\- Do not pull.

\- Do not merge.

\- Do not rebase.

\- Do not create or delete branches.

\- Do not modify stashes.

\- Do not deploy.

\- Do not create GitHub releases.

\- Do not change the Git remote.

\- Do not change repository settings.



Leave implementation work uncommitted for review.



\## Geographic product scope



NoahArk is a Southeast Asian business-management platform built specifically for:



1\. Singapore

2\. Malaysia

3\. Indonesia



These are the only supported countries in the approved product scope.



NoahArk is not:



\- A worldwide product

\- A generic global ERP

\- A country-neutral accounting system

\- Intended to support every currency, tax authority or payroll jurisdiction

\- Required to provide user-configurable statutory formulas for arbitrary countries



Do not propose worldwide localisation, generic country plugins or support for

countries outside Singapore, Malaysia and Indonesia.



Future country expansion is out of scope unless separately approved.



\## Legal-entity model



A tenant represents a subscribing customer or corporate group.



A tenant may contain one or more legal entities.



Every legal entity must have exactly one operating jurisdiction:



\- SG — Singapore

\- MY — Malaysia

\- ID — Indonesia



The legal entity's jurisdiction determines:



\- Registered identifiers

\- Functional currency

\- Accounting defaults

\- Tax configuration

\- Statutory invoice requirements

\- E-invoicing integration

\- Payroll rules

\- Employment contribution rules

\- Public holidays

\- Address structure

\- Document numbering

\- Statutory reports

\- Data-retention requirements

\- Default language

\- Default time zone



Country-sensitive transactions must belong to a legal entity. They must not rely

only on a tenant-level country setting.



A corporate group may contain, for example:



\- One Singapore company

\- One Malaysian company

\- One Indonesian company



These companies may share a tenant and authorised users, but their accounting

ledgers, tax registrations, payrolls, statutory submissions, document sequences

and base currencies must remain legally separated.



\## Supported country profiles



\### Singapore



Baseline support must consider:



\- Currency: SGD

\- Time zone: Asia/Singapore

\- Business identifier: UEN

\- GST registration and GST accounting

\- IRAS reporting requirements

\- InvoiceNow and Peppol readiness

\- CPF employer and employee contributions

\- Skills Development Levy

\- Foreign Worker Levy where applicable

\- Self-Help Group contributions where applicable

\- Payroll and payslip requirements

\- IR8A and applicable employment-income reporting

\- Singapore public holidays

\- Singapore address formats

\- PDPA-aligned handling of personal information



\### Malaysia



Baseline support must consider:



\- Currency: MYR

\- Time zone: Asia/Kuala\_Lumpur

\- Business registration identifiers

\- Tax Identification Number

\- SST configuration and reporting

\- LHDN/HASiL MyInvois e-Invoice integration

\- Invoice, credit-note, debit-note and refund-note requirements

\- EPF/KWSP

\- SOCSO/PERKESO

\- Employment Insurance System

\- PCB/MTD payroll deductions

\- HRD Corp levy where applicable

\- Malaysian payroll and payslip requirements

\- Federal and state public holidays

\- Malaysian address and state codes

\- PDPA-aligned handling of personal information



\### Indonesia



Baseline support must consider:



\- Currency: IDR

\- Time zones:

&#x20; - Asia/Jakarta

&#x20; - Asia/Makassar

&#x20; - Asia/Jayapura

\- Business and taxpayer identifiers, including applicable NPWP/NIK information

\- PPN/VAT

\- Applicable withholding-tax categories

\- PPh 21 payroll withholding

\- DJP Coretax and applicable electronic tax-invoice requirements

\- BPJS Kesehatan

\- BPJS Ketenagakerjaan

\- THR requirements

\- Indonesian payroll and payslip requirements

\- Indonesian public and collective holidays

\- Indonesian address hierarchy

\- Personal-data protection requirements



\## Supported languages



The initial application-language scope is:



\- English

\- Bahasa Melayu

\- Bahasa Indonesia



English may be the initial development and administration language.



Do not add arbitrary worldwide languages during the foundation phases.



The architecture must distinguish:



\- User-interface language

\- Customer-facing document language

\- Employee communication language

\- Legal-entity jurisdiction

\- Transaction currency



Changing a display language must not change accounting or statutory behaviour.



\## Currency scope



Primary functional currencies are:



\- SGD

\- MYR

\- IDR



The accounting architecture must support:



\- One functional currency per legal entity

\- Transactions in SGD, MYR and IDR

\- Exchange rates

\- Foreign-currency gains and losses

\- Country-appropriate decimal and display behaviour

\- Exchange-rate source and effective date

\- Locked rates on posted transactions

\- Consolidated group reporting with explicit translation rules



Do not design an unrestricted worldwide currency catalogue during the initial

implementation.



\## Regulatory implementation rule



Statutory rates, thresholds, contribution tables, tax codes, submission schemas

and effective dates must never be permanently hard-coded into business logic.



They must be:



\- Versioned

\- Effective-dated

\- Jurisdiction-specific

\- Tested against official examples

\- Traceable to an authoritative government source

\- Capable of supporting corrections and retrospective payroll calculations

\- Protected against unauthorised modification



However, this requirement must not become a generic worldwide rule engine.

Configuration is restricted to Singapore, Malaysia and Indonesia.



Claude must not invent statutory formulas.



Before implementing a statutory calculation or submission integration, Claude

must identify the currently applicable official specification and record:



\- Issuing authority

\- Source URL

\- Publication or specification version

\- Effective date

\- Implementation assumptions

\- Test examples

\- Known future changes



\## Product architecture principles



\- Greenfield modular-monolith architecture

\- TypeScript strict mode

\- PostgreSQL as the authoritative transactional database

\- Multi-tenant and multi-legal-entity support from the first migration

\- Strict legal-entity separation for accounting, tax and payroll

\- Server-side RBAC and field-level controls

\- Immutable audit events for sensitive operations

\- Database transactions for multi-record operations

\- Idempotency for financial and statutory submissions

\- Database constraints for critical invariants

\- Double-entry accounting

\- Posted financial records corrected through controlled reversals

\- Sensitive HR and payroll information protected separately

\- Automated unit, integration, security and tenant-isolation tests

\- Deep compatibility with Singapore, Malaysia and Indonesia

\- No worldwide or arbitrary-country scope

\- No module considered complete merely because screens and CRUD APIs exist

