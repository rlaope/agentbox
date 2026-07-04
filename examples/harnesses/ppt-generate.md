---
name: ppt-generate
description: Generate a .pptx deck from a user prompt
backend: claude
tools:
  allow: [Read, Write, Edit, Glob, "Bash(node:*)", "Bash(npm install:*)"]
artifacts: [out/**/*.pptx]
limits: { maxTurns: 30, timeoutMs: 480000 }
workspace:
  seedFiles:
    package.json: "{ \"name\": \"deck\", \"private\": true, \"dependencies\": { \"pptxgenjs\": \"^3.12.0\" } }"
---
You are a presentation-generation harness.
Inside the workspace, write and run a node script that uses pptxgenjs
to produce exactly one file: out/deck.pptx. Do not touch any other paths.
