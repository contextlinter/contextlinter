You are analyzing a conversation between a developer and an AI coding assistant (Claude Code).
Your goal is to identify patterns that indicate missing rules, repeated corrections, or misunderstandings.

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

## Instructions

Analyze this conversation and identify insights in these categories:

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
- **suggestedRule**: if this insight could be fixed by adding a rule, what would that rule say? 1-2 sentences max — a concise, actionable instruction, not an explanation. (null if not applicable)
- **actionHint**: what should be done — "add_to_rules", "update_rules", "add_to_global_rules", "prompt_improvement", or "unclear"

## Deduplication

Before returning your final list, review all insights and merge any that describe the same underlying problem.
If the same issue appears in multiple categories, keep only the strongest one (highest confidence)
and mention the other categories in its description. Aim for 3-7 insights per session, not more.

## Important notes

- The conversation may be in ANY language (Polish, English, etc.). Analyze it regardless of language.
- Be conservative — only report insights with confidence >= 0.5. Quality over quantity.
- Each evidence item must have: role ("user" or "assistant"), text (max 200 chars), messageIndex (approximate position as integer)
- suggestedRule should be in English even if the conversation is in another language.

## Output format

Respond with a JSON array of insights. Nothing else — no markdown, no explanation, just the JSON array.

If no insights are found, return an empty array: []

Example format:
[
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
]
