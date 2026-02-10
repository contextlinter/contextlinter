You are analyzing patterns across multiple AI coding sessions for the same project.
You have received insights from individual session analyses. Your goal is to find patterns that repeat across sessions.

## Individual session insights

<insights>
{{insights_json}}
</insights>

## Instructions

Look for:
1. **Same correction appearing in 2+ sessions** — this is a strong signal for a missing rule
2. **Same type of misunderstanding recurring** — the AI keeps making the same category of mistake
3. **Context that gets re-explained** — developer tells the AI the same project facts repeatedly
4. **Conventions that are corrected consistently** — developer always corrects in the same direction

For each cross-session pattern found, provide:
- **category**: insight category
- **confidence**: 0.0-1.0 (higher than single-session because it's confirmed across sessions)
- **title**: one-line summary
- **description**: what pattern you see and across how many sessions
- **occurrences**: array of {sessionId, insightId} pairs that form this pattern
- **suggestedRule**: what rule would fix this permanently (in English)
- **actionHint**: "add_to_rules", "update_rules", "add_to_global_rules", or "unclear"

## Important notes

- Only report patterns that appear in 2+ sessions with confidence >= 0.6.
- suggestedRule should be in English.
- Be strict — cross-session patterns should be clearly recurring, not coincidental.

## Output format

Respond with a JSON array of cross-session patterns. Nothing else — no markdown, no explanation, just JSON.

If no patterns are found, return an empty array: []

Example format:
[
  {
    "category": "repeated_correction",
    "confidence": 0.9,
    "title": "Component design style keeps being rejected",
    "description": "Across 3 sessions, the developer rejected AI-generated component designs 6 times.",
    "occurrences": [
      {"sessionId": "abc123", "insightId": "insight-1"},
      {"sessionId": "def456", "insightId": "insight-2"}
    ],
    "suggestedRule": "Follow existing component design patterns. Check similar components before creating new ones.",
    "actionHint": "add_to_rules"
  }
]
