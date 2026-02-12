You are analyzing a conversation between a developer and an AI coding assistant (Claude Code).
Your goal is to identify patterns that indicate missing rules, repeated corrections, or misunderstandings,
AND generate concrete suggestions for improving the developer's AI rules files.

## Tool usage summary

<tool_usage>
{{tool_usage_summary}}
</tool_usage>

This shows how the AI used its tools during this session. High failure rates, repeated file reads,
or unusual tool patterns may indicate missing context or rules.

## Conversation

<conversation>
{{conversation}}
</conversation>

## Current rules files

<rules>
{{rules_content}}
</rules>

## Rules statistics

<rules_stats>
{{rules_stats}}
</rules_stats>

## Instructions

### Part 1: Analyze the conversation

Identify insights in these categories:

1. **missing_project_knowledge** — The developer explains something about their project that the AI should already know (architecture, conventions, tools, structure). Especially strong signal if the developer mentions rules files (CLAUDE.md, .cursorrules, etc.).

2. **repeated_correction** — The developer corrects the same type of behavior multiple times. Look for patterns, not just individual corrections.

3. **rejected_approach** — The developer explicitly rejects what the AI did or proposed and redirects to a different approach.

4. **intent_clarification** — The AI misunderstood the developer's intent. The developer had to clarify what they actually meant.

5. **convention_establishment** — The developer establishes a preference or convention, explicitly or through repeated corrections in the same direction.

6. **tool_command_correction** — The developer corrects tool usage, command, file path, or package choice.

7. **tool_usage_pattern** — The tool usage statistics reveal inefficient patterns. High read counts on the same file suggest missing context in rules. High bash failure rate suggests missing environment info. Excessive tool use with little progress suggests the AI is struggling.

For each insight found, provide:
- **category**: one of the categories above
- **confidence**: 0.0-1.0 (how certain you are this is a real pattern)
- **title**: one-line summary
- **description**: what happened and why it matters
- **evidence**: 1-3 short quotes from the conversation (max 200 chars each) with the role (user/assistant) and approximate position
- **suggestedRule**: if this insight could be fixed by adding a rule, what would that rule say? (null if not applicable)
- **actionHint**: what should be done — "add_to_rules", "update_rules", "add_to_global_rules", "prompt_improvement", or "unclear"

**Deduplication:** Review all insights and merge any that describe the same underlying problem.
If the same issue appears in multiple categories, keep only the strongest one.
Aim for 3-7 insights per session, not more.

### Part 2: Generate suggestions

For each insight from Part 1, decide what change to make to the rules files:

1. **Check if already covered.** If a rule already addresses this insight, mark the suggestion as skipped.

2. **If not covered, generate a suggestion:**
   - **type**: "add" (new rule), "update" (improve existing rule), "remove" (delete stale rule), "consolidate" (merge related rules), or "split" (move a section to its own file)
   - **targetFile**: which file to modify (e.g., "CLAUDE.md", ".claude/rules/architecture.md")
   - **targetSection**: which section (existing header or new one). Use null for file-level changes.
   - **title**: one-line summary of the change
   - **rationale**: why this change helps (reference evidence from the conversation)
   - **priority**: "high" (critical issue or repeated across conversation), "medium" (clear improvement), "low" (nice-to-have)
   - **content**: the exact markdown text to add, replace, or remove

3. **Consider splitting large files.** If a single rules file has more than 80 rules (check the statistics above), suggest "split" to move the largest sections into `.claude/rules/<section-name>.md` files.

Rules for generating good content:
- Keep rules concise — one clear instruction per rule, max 2-3 lines
- Use the same style as existing rules (if bullets, use bullets; if prose, use prose)
- Don't repeat information that's already in the rules
- Group related rules under the same section header
- If CLAUDE.md is already long (>200 rules), prefer adding to .claude/rules/ instead
- Write rules in the same language as the existing CLAUDE.md (if Polish, write in Polish; if English, English)
- Ensure code examples in suggested rules are consistent with the rule text

## Important notes

- The conversation may be in ANY language (Polish, English, etc.). Analyze it regardless of language.
- Be conservative — only report insights with confidence >= 0.5. Quality over quantity.
- Each evidence item must have: role ("user" or "assistant"), text (max 200 chars), messageIndex (approximate position as integer)
- suggestedRule and rule content should be in English even if the conversation is in another language.

## Output format

Respond with a JSON object containing both insights and suggestions. Nothing else — no markdown, no explanation, just the JSON object.

If no insights are found, return: {"insights": [], "suggestions": []}

```json
{
  "insights": [
    {
      "category": "missing_project_knowledge",
      "confidence": 0.85,
      "title": "Project is not a monorepo",
      "description": "The developer corrected the AI's assumption about the project structure.",
      "evidence": [
        {"role": "user", "text": "This is not a monorepo, each app is independent", "messageIndex": 5}
      ],
      "suggestedRule": "This project is NOT a monorepo. Each application is independent with its own dependencies.",
      "actionHint": "add_to_rules"
    }
  ],
  "suggestions": [
    {
      "type": "add",
      "targetFile": "CLAUDE.md",
      "targetSection": "Architecture",
      "title": "Document that project is not a monorepo",
      "rationale": "Developer corrected this assumption during the session",
      "priority": "high",
      "content": {
        "add": "This project is NOT a monorepo. Each application is independent with its own dependencies.",
        "remove": null
      },
      "insightIds": ["(id of the insight above)"],
      "skipped": false,
      "skipReason": null
    }
  ]
}
```

For "update" type: set "content.remove" to null. The tool reads the existing section content directly from the file. Provide only the new content in "content.add" — include the full replacement for the target section (heading + body).
For "consolidate", "remove" is an array of old rule texts and "add" is the merged rule.
For "split" type: "add" is the destination file path, "remove" is null.
For skipped insights, set "skipped": true and explain in "skipReason".
