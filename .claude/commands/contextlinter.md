Run the ContextLinter analysis pipeline to suggest improvements to this project's rules files.

## Steps

1. Run the ContextLinter CLI to generate suggestions:
   ```bash
   npx contextlinter suggest --full --limit 10 --verbose
   ```

2. Read the latest suggestion set from `.contextlinter/suggestions/` (most recent JSON file).

3. Review each suggestion and present it to the user with the diff preview, showing:
   - The suggestion type (add/update/remove/consolidate)
   - Target file and section
   - The diff (lines to add/remove)
   - Confidence level and priority
   - Rationale

4. For each suggestion, ask the user:
   - **Accept** — apply this change to the target file
   - **Reject** — skip this suggestion
   - **Edit** — modify the suggested text before applying

5. Apply accepted changes to the appropriate rules files:
   - For "add" suggestions: create the file if needed, or append to the target section
   - For "update" suggestions: find and replace the old text with new text
   - For "remove" suggestions: find and delete the specified text
   - Create backup copies before modifying any file

6. Show a summary of what was changed.

## Notes
- If no suggestions are generated, tell the user their rules are up to date.
- Show the confidence level and rationale for each suggestion.
- When applying changes, create new files if they don't exist yet (e.g., .claude/rules/debugging.md).
- Create parent directories as needed.
- After applying, remind the user to review the changes with `git diff` and commit if satisfied.
