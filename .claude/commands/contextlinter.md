Review and apply ContextLinter suggestions to this project's rules files.

## Prerequisites

Run the analysis pipeline in your terminal first:
```
npx contextlinter analyze
```

## Steps

1. Check if suggestions exist:
   ```bash
   ls -t .contextlinter/suggestions/*.json 2>/dev/null | head -1
   ```

   If no files found, tell the user:
   > No suggestions found. Run this in your terminal first:
   > ```
   > npx contextlinter analyze
   > ```
   > This analyzes your Claude Code sessions and generates rule suggestions.
   > It takes a few minutes (one LLM call per session).
   Then STOP.

2. Read and parse the latest suggestion file (cat the file from step 1).
   Extract the `suggestions` array, `generatedAt`, and `stats`.

3. Show diagnostic summary:
   > **ContextLinter suggestions** (generated {relative time from generatedAt})
   > {stats.total} suggestions: {stats.byPriority.high} high, {stats.byPriority.medium} medium, {stats.byPriority.low} low priority
   > Types: {stats.byType.add} add, {stats.byType.update} update, {stats.byType.remove} remove

   If generatedAt is older than 7 days, warn:
   > These suggestions are from {date}. Consider running `npx contextlinter analyze` again for fresh analysis.

4. Filter to suggestions with `status === "pending"` only.
   If none remain, tell user: "All suggestions have been reviewed. Run `npx contextlinter analyze` again to generate new ones." Then STOP.

5. For each pending suggestion, present it showing:
   - [index/total] title
   - Type (ADD/UPDATE/REMOVE), target file (`targetFile`) + section (`targetSection`)
   - Priority + confidence
   - Diff: `diff.addedLines` as `+ line`, `diff.removedLines` as `- line`
   - Rationale (`rationale`)

6. For each suggestion, ask the user:
   - **Accept** — apply this change to the target file
   - **Reject** — skip this suggestion
   - **Edit** — modify the suggested text before applying

7. Apply accepted changes to the appropriate rules files:
   - For "add" suggestions: append to the target section (or end of file). Create file if needed.
   - For "update" suggestions: find the removedLines text and replace with addedLines
   - For "remove" suggestions: find and delete the removedLines text
   - Create parent directories as needed

8. Show a summary of what was changed and remind the user to review with `git diff`.
