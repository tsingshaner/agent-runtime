---
"@qingshaner/runtime": minor
---

Retain submitted user text on all new Runs and expose nullable `requestText` in Run queries so clients can restore chat history after refresh. Existing runs without retained input return null; Request ID deduplication remains unchanged.
