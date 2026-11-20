# Legal review brief for public launch

This is a drafting brief, not published terms. A qualified reviewer must provide the operator's legal name and contact details, jurisdiction choices, a minimum age, and final text before `service_state` is opened in production.

## Service facts to verify against the code

- Anonymous agents can create pages; a signed-in GitHub or Google account with a matching verified email automatically claims a page by opening its link. An agent can make a claimed page resident.
- Page code is supplied through signed Chronolog publications and can change after claim. Publishing requires an explicit current device publisher grant and authorized private setup credential. Preparation can occur before claim within the unclaimed limits; claim adopts the prepared code and keys to the verified owner account. Owners can disconnect agents; agent-made guest invites require owner approval. Owners can make login-free display links.
- The service stores provider subjects and verified emails, hashed sessions and API keys, account and page indexes, signed application authority and publication records, immutable page-code assets in R2, host activity, report reasons, appeal reasons, and audit records. Application commands, database history, replicated content and live signals belong to peer-owned Chronolog sessions. Cloudflare processes requests and stores data.
- Whistle transcription runs in the browser after a deliberate model download. Audio is not sent to the Worker for transcription. Authored page code may explicitly share audio or other sensor data through its application session or external services; the application must disclose that behavior separately.
- Unclaimed pages expire after 24 hours. Claimed ad hoc pages expire after 24 hours idle; resident pages persist until deletion. Held pages are scheduled for deletion after 90 days; verify that alarm behavior in staging before promising this retention in legal text.
- Automatic holds can happen from reports; an account may be suspended after three unreversed holds. Owners see notices and can appeal from their authenticated dashboard, including while suspended. Admins can restore pages and disqualify the reports that caused a wrongful hold. No review response time is promised.
- There is no durable backup of a page's Durable Object data beyond Cloudflare platform recovery; D1 Time Travel is used for the account index. Verify the final backup claim with Cloudflare settings.

## Text to prepare and approve

1. Terms of service: operator identity, eligibility and age, user and agent responsibilities, content license needed to host pages, agent tokens, limits, suspension and deletion, appeals, disclaimers, liability, changes, and contact.
2. Acceptable use: phishing and password collection, malware, scams, spam, unlawful content, covert sensor collection, cryptomining, outbound abuse, and attempts to evade rate limits.
3. Privacy policy: controller identity and contact, each data category and purpose, legal basis, processor and international transfer details, retention, cookies and sessions, account and page export/deletion, rights requests, complaint route, and contact. The [European Commission's GDPR rights guide](https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en) describes access, erasure, portability and the response process.
4. Copyright policy: notice and counter-notice process, public contact details, and a designated agent if required. The [U.S. Copyright Office](https://www.copyright.gov/dmca-directory/) says public agent contact and directory designation are separate steps.
5. Law-enforcement request process: verification, scope, preservation, disclosure, and user notice policy.

The sign-in and dashboard link `/terms` and `/privacy`; those URLs must serve reviewed final text before claims are enabled. Account export and deletion are implemented locally, but their deployed behavior and the 90-day evidence alarm still need staging verification.
