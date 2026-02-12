You are generating concrete changes to a developer's AI rules files (CLAUDE.md).
You have insights from analyzing their coding sessions and the current state of their rules.

## Current rules files

<rules>
{{rules_content}}
</rules>

## Rules statistics

<rules_stats>
{{rules_stats}}
</rules_stats>

{{existing_suggestions_summary}}

## Insights to address

<insights>
{{insights_json}}
</insights>

## Instructions

For each insight, decide what change to make:

1. **Check if already covered.** If a rule already addresses this insight, respond with "skip" and explain why.

1b. **Check against already generated suggestions.** If the "Already generated suggestions" section above is present and a suggestion very similar to one listed there would be produced, set "skipped": true and "skipReason": "similar to already generated: <title>".

2. **If not covered, generate a suggestion:**
   - **type**: "add" (new rule), "update" (improve existing rule), "remove" (delete stale rule), "consolidate" (merge related rules), or "split" (move a section to its own file)
   - **targetFile**: which file to modify (e.g., "CLAUDE.md", ".claude/rules/architecture.md")
   - **targetSection**: which section (existing header or new one). Use null for file-level changes.
   - **title**: one-line summary of the change
   - **rationale**: why this change helps (reference sessions/evidence)
   - **priority**: "high" (cross-session pattern or critical), "medium" (clear improvement), "low" (nice-to-have)
   - **content**: the exact markdown text to add, replace, or remove

3. **Consider splitting large files.** Check the rules statistics above. If a single rules file has more than 80 rules, suggest "split" to move the largest, most self-contained sections into `.claude/rules/<section-name>.md` files. Pick sections that are coherent topics (e.g., "Architecture", "Testing", "Deployment"). For split suggestions:
   - **type**: "split"
   - **targetFile**: the source file (e.g., "CLAUDE.md")
   - **targetSection**: the section heading to extract
   - **content.add**: the destination file path (e.g., ".claude/rules/architecture.md")
   - **content.remove**: null (section content is extracted automatically)
   - **insightIds**: [] (split suggestions are structural, not insight-driven)

Rules for generating good content:
- Keep rules concise — one clear instruction per rule, max 2-3 lines
- Use the same style as existing rules (if bullets, use bullets; if prose, use prose)
- Don't repeat information that's already in the rules
- Group related rules under the same section header
- If CLAUDE.md is already long (>200 rules), prefer adding to .claude/rules/ instead
- Write rules in the same language as the existing CLAUDE.md (if Polish, write in Polish; if English, English)
- Ensure code examples in suggested rules are consistent with the rule text. If the rule says "use X directly", code examples must import from X, not from a wrapper. Do not contradict the rule's own instruction in an example.

## Output format

Respond with a JSON array of suggestions. Each suggestion:

Example — **add** (new rule, "remove" is null):
```json
{
  "type": "add",
  "targetFile": "CLAUDE.md",
  "targetSection": "Architecture",
  "title": "Document me-web as Vite CSR app",
  "rationale": "Developer corrected this assumption in 3 sessions",
  "priority": "high",
  "content": {
    "add": "me-web is a Vite CSR app, NOT Next.js. Do not use Next.js-specific packages in me-web.",
    "remove": null
  },
  "insightIds": ["id1", "id2"],
  "skipped": false,
  "skipReason": null
}
```

Example — **update** (replace section content — provide only the new text, the tool reads existing content from the file automatically):
```json
{
  "type": "update",
  "targetFile": "CLAUDE.md",
  "targetSection": "Toaster setup - SSR vs CSR",
  "title": "Fix Toaster import to use sonner",
  "rationale": "Contradictory import caused confusion across 2 sessions",
  "priority": "high",
  "content": {
    "add": "## Toaster setup - SSR vs CSR\n\nimport { Toaster } from 'sonner';",
    "remove": null
  },
  "insightIds": ["id3"],
  "skipped": false,
  "skipReason": null
}
```

Example — **split** (move section to dedicated file):
```json
{
  "type": "split",
  "targetFile": "CLAUDE.md",
  "targetSection": "Architecture",
  "title": "Move \"Architecture\" section to .claude/rules/architecture.md",
  "rationale": "CLAUDE.md has 133 rules. Moving the 24-rule \"Architecture\" section to a dedicated file improves maintainability.",
  "priority": "medium",
  "content": {
    "add": ".claude/rules/architecture.md",
    "remove": null
  },
  "insightIds": [],
  "skipped": false,
  "skipReason": null
}
```

For "update" type: set "content.remove" to null. The tool reads the existing section content directly from the file. Provide only the new content in "content.add" — include the full replacement for the target section (heading + body).

For "consolidate", "remove" is an array of old rule texts and "add" is the merged rule.
For "split" type: "add" is the destination file path, "remove" is null. The section content is extracted automatically from the source file.
For skipped insights, set "skipped": true and explain in "skipReason".

Return ONLY the JSON array, no markdown fences, no explanation.
