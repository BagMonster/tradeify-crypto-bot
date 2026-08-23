# D-038 CI note

The production-grid branch is intentionally opened as a draft pull request to `main` so the existing GitHub Actions workflow executes its syntax and test jobs before any merge or deployment decision. The draft PR is not an activation approval and must not be merged merely because CI is green.
