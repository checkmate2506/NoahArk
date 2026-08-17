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



\## Product architecture principles



\- Greenfield modular-monolith architecture.

\- TypeScript strict mode.

\- PostgreSQL as the authoritative transactional database.

\- Multi-tenant isolation from the first migration.

\- Server-side RBAC and field-level controls.

\- Immutable audit events for sensitive operations.

\- Database transactions for multi-record business operations.

\- Idempotency for retryable financial and workflow operations.

\- Database constraints for critical invariants.

\- Double-entry accounting.

\- Posted financial records corrected through reversal, not destructive editing.

\- Sensitive HR and payroll information protected separately.

\- Automated unit, integration, security and tenant-isolation tests.

\- Singapore localisation supported without hard-coding the platform to one country.

\- No module is complete merely because screens and CRUD APIs exist.

