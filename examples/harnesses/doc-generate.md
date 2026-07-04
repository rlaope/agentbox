---
name: doc-generate
description: Generate a markdown document from a prompt
backend: pi
artifacts: [out/*.md]
limits: { timeoutMs: 180000 }
---
Write a markdown document covering the request to out/doc.md.
