Run the ContextLinter analysis pipeline and interactively apply suggestions to this project's rules files.

## Steps

1. Run the ContextLinter CLI:

   ```bash
   npx tsx src/index.ts run --format json
   ```

2. Parse the JSON output. If the output contains an `error` field, show it to the user and stop.

3. If `suggestions` array is empty, tell the user their rules are up to date.

4. For each suggestion, present it to the user showing:
   - The suggestion type (`type`: add/update/remove/consolidate/split)
   - Target file (`targetFile`) and section (`targetSection`)
   - The diff (`diff.addedLines` and `diff.removedLines`)
   - Confidence level (`confidence`) and priority (`priority`)
   - Rationale (`rationale`)

5. For each suggestion, ask the user:
   - **Accept** — apply this change to the target file
   - **Reject** — skip this suggestion
   - **Edit** — modify the suggested text before applying

6. Apply accepted changes to the appropriate rules files:
   - For "add" suggestions: create the file if needed, or append to the target section
   - For "update" suggestions: find and replace the old text with new text
   - For "remove" suggestions: find and delete the specified text
   - Create parent directories as needed

7. Show a summary of what was changed and remind the user to review with `git diff`.
