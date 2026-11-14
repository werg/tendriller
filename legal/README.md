# Reviewed legal pages

Place final, legally reviewed HTML here as `terms.html`, `privacy.html`,
`acceptable-use.html`, `copyright.html`, and `law-enforcement.html`.
The build copies them into the Worker assets. The service routes are `/terms`,
`/privacy`, `/acceptable-use`, `/copyright`, and `/law-enforcement`.
`scripts/check-legal.mjs` blocks staging and production deployment until all five
pages exist and pass basic completeness checks. The operator must confirm legal
approval before setting the GitHub Actions READY variables. See
`docs/LEGAL_REVIEW_BRIEF.md` for required subject matter.
