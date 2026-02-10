import { describe, it, expect } from 'vitest';
import { parseMarkdown, extractFileImports } from '../parser.js';
import type { RuleScope } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FILE = '/project/CLAUDE.md';
const SCOPE: RuleScope = 'project';

function parse(md: string) {
  return parseMarkdown(md, FILE, SCOPE);
}

// ---------------------------------------------------------------------------
// Heading hierarchy
// ---------------------------------------------------------------------------

describe('heading hierarchy', () => {
  it('single # heading sets sectionHierarchy', () => {
    const rules = parse(`# Top Level\n\nSome rule here.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].sectionHierarchy).toEqual(['Top Level']);
    expect(rules[0].section).toBe('Top Level');
  });

  it('nested headings build sectionHierarchy in order', () => {
    const rules = parse(`\
# Project
## Testing
### Unit Tests

Always run unit tests before pushing.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].sectionHierarchy).toEqual(['Project', 'Testing', 'Unit Tests']);
    expect(rules[0].section).toBe('Unit Tests');
  });

  it('sibling headings replace, not append', () => {
    const rules = parse(`\
# Root
## Section A

Rule under A.

## Section B

Rule under B.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].sectionHierarchy).toEqual(['Root', 'Section A']);
    expect(rules[1].sectionHierarchy).toEqual(['Root', 'Section B']);
  });

  it('deeper heading under sibling does not carry stale hierarchy', () => {
    const rules = parse(`\
# Root
## A
### A-sub

Rule in A-sub.

## B

Rule in B.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].sectionHierarchy).toEqual(['Root', 'A', 'A-sub']);
    expect(rules[1].sectionHierarchy).toEqual(['Root', 'B']);
  });

  it('rule before any heading has empty sectionHierarchy', () => {
    const rules = parse(`A rule with no heading above it.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].sectionHierarchy).toEqual([]);
    expect(rules[0].section).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bullet points
// ---------------------------------------------------------------------------

describe('bullet points', () => {
  it('dash bullets parsed as separate rules', () => {
    const rules = parse(`\
- First rule
- Second rule
- Third rule`);
    expect(rules).toHaveLength(3);
    expect(rules[0].text).toBe('First rule');
    expect(rules[1].text).toBe('Second rule');
    expect(rules[2].text).toBe('Third rule');
  });

  it('asterisk bullets parsed as separate rules', () => {
    const rules = parse(`\
* Alpha
* Beta`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Alpha');
    expect(rules[1].text).toBe('Beta');
  });

  it('bullet points have format bullet_point', () => {
    const rules = parse(`- Use TypeScript`);
    expect(rules[0].format).toBe('bullet_point');
  });

  it('mixed - and * bullets both work', () => {
    const rules = parse(`\
- Dash bullet
* Star bullet`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Dash bullet');
    expect(rules[1].text).toBe('Star bullet');
  });
});

// ---------------------------------------------------------------------------
// Nested bullets
// ---------------------------------------------------------------------------

describe('nested bullets', () => {
  it('nested sub-bullets grouped with parent', () => {
    const rules = parse(`\
- Parent rule
  - Child detail one
  - Child detail two`);
    expect(rules).toHaveLength(1);
    expect(rules[0].text).toContain('Parent rule');
    expect(rules[0].text).toContain('Child detail one');
    expect(rules[0].text).toContain('Child detail two');
  });

  it('sibling top-level bullets after nested block are separate rules', () => {
    const rules = parse(`\
- First parent
  - Nested under first
- Second parent`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toContain('First parent');
    expect(rules[0].text).toContain('Nested under first');
    expect(rules[1].text).toBe('Second parent');
  });

  it('deeply nested bullets still grouped with top-level parent', () => {
    const rules = parse(`\
- Top level
  - Level 2
    - Level 3`);
    expect(rules).toHaveLength(1);
    expect(rules[0].text).toContain('Top level');
    expect(rules[0].text).toContain('Level 2');
    expect(rules[0].text).toContain('Level 3');
  });
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

describe('paragraphs', () => {
  it('single paragraph parsed as one rule', () => {
    const rules = parse(`This is a simple paragraph rule.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].text).toBe('This is a simple paragraph rule.');
    expect(rules[0].format).toBe('paragraph');
  });

  it('consecutive lines form one paragraph', () => {
    const rules = parse(`\
Line one of paragraph.
Line two of paragraph.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].text).toContain('Line one of paragraph.');
    expect(rules[0].text).toContain('Line two of paragraph.');
  });

  it('blank line separates two paragraphs', () => {
    const rules = parse(`\
First paragraph.

Second paragraph.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('First paragraph.');
    expect(rules[1].text).toBe('Second paragraph.');
  });
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe('fenced code blocks', () => {
  it('content inside ``` fences is NOT parsed as rules', () => {
    const rules = parse(`\
Some rule above.

\`\`\`
this should not become a rule
neither should this
\`\`\`

Some rule below.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Some rule above.');
    expect(rules[1].text).toBe('Some rule below.');
    const allText = rules.map((r) => r.text).join(' ');
    expect(allText).not.toContain('this should not become a rule');
  });

  it('code block with language tag skipped', () => {
    const rules = parse(`\
Rule before.

\`\`\`typescript
const x = 42;
\`\`\`

Rule after.`);
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.text)).not.toContain('const x = 42;');
  });

  it('```` (4 backticks) fence handled correctly', () => {
    const rules = parse(`\
Before.

\`\`\`\`
code inside quad fence
\`\`\`\`

After.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Before.');
    expect(rules[1].text).toBe('After.');
  });

  it('3-backtick close does NOT close a 4-backtick fence', () => {
    const rules = parse(`\
Before.

\`\`\`\`
still in code
\`\`\`
still in code too
\`\`\`\`

After.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Before.');
    expect(rules[1].text).toBe('After.');
  });

  it('tilde fence ~~~ is also recognized', () => {
    const rules = parse(`\
Rule.

~~~
inside tilde fence
~~~

Another rule.`);
    expect(rules).toHaveLength(2);
    const allText = rules.map((r) => r.text).join(' ');
    expect(allText).not.toContain('inside tilde fence');
  });
});

// ---------------------------------------------------------------------------
// Horizontal rules
// ---------------------------------------------------------------------------

describe('horizontal rules', () => {
  it('--- is skipped and not parsed as a rule', () => {
    const rules = parse(`\
Rule above.

---

Rule below.`);
    expect(rules).toHaveLength(2);
    expect(rules[0].text).toBe('Rule above.');
    expect(rules[1].text).toBe('Rule below.');
  });

  it('*** is skipped', () => {
    const rules = parse(`\
Above.

***

Below.`);
    expect(rules).toHaveLength(2);
  });

  it('___ is skipped', () => {
    const rules = parse(`\
Above.

___

Below.`);
    expect(rules).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Emphasis detection
// ---------------------------------------------------------------------------

describe('emphasis detection', () => {
  it.each([
    ['IMPORTANT: always run tests', 'important'],
    ['You MUST use TypeScript', 'important'],
    ['NEVER push directly to main', 'important'],
    ['CRITICAL: do not skip CI', 'important'],
    ['This is REQUIRED for all PRs', 'important'],
    ['YOU MUST follow the style guide', 'important'],
  ] as const)('%s → emphasis: %s', (text, expected) => {
    const rules = parse(`- ${text}`);
    expect(rules[0].emphasis).toBe(expected);
  });

  it.each([
    // "never", "do not", "don't" match EMPHASIS_PATTERNS (case-insensitive)
    // before falling through to NEGATIVE_PATTERNS, so they are 'important'
    ["never commit secrets", 'important'],
    ["do not use var", 'important'],
    ["don't skip linting", 'important'],
    // "avoid" only matches NEGATIVE_PATTERNS → 'negative'
    ["avoid global state", 'negative'],
  ] as const)('%s → emphasis: %s', (text, expected) => {
    const rules = parse(`- ${text}`);
    expect(rules[0].emphasis).toBe(expected);
  });

  it('text with no emphasis keywords → normal', () => {
    const rules = parse(`- Use consistent formatting`);
    expect(rules[0].emphasis).toBe('normal');
  });

  it('IMPORTANT takes precedence over negative patterns', () => {
    // "NEVER" matches both EMPHASIS_PATTERNS and NEGATIVE_PATTERNS
    // but emphasis check runs first
    const rules = parse(`- NEVER skip tests`);
    expect(rules[0].emphasis).toBe('important');
  });
});

// ---------------------------------------------------------------------------
// Format detection (command, emphatic)
// ---------------------------------------------------------------------------

describe('format detection', () => {
  it('backtick-prefixed text detected as command', () => {
    const rules = parse('- `pnpm test` should pass before merge');
    expect(rules[0].format).toBe('command');
  });

  it('rule starting with IMPORTANT is emphatic', () => {
    const rules = parse('IMPORTANT: never skip CI');
    expect(rules[0].format).toBe('emphatic');
  });

  it('rule starting with NEVER is emphatic', () => {
    const rules = parse('NEVER push force to main');
    expect(rules[0].format).toBe('emphatic');
  });

  it('plain paragraph is format paragraph', () => {
    const rules = parse('Use consistent naming conventions.');
    expect(rules[0].format).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// @import extraction
// ---------------------------------------------------------------------------

describe('@import extraction (inline)', () => {
  it('@path/to/file.md detected in rule text', () => {
    const rules = parse(`- See @docs/style-guide.md for details`);
    expect(rules[0].imports).toContain('docs/style-guide.md');
  });

  it('multiple @imports in one rule', () => {
    const rules = parse(`- Read @config/base.yaml and @config/overrides.json`);
    expect(rules[0].imports).toContain('config/base.yaml');
    expect(rules[0].imports).toContain('config/overrides.json');
  });

  it('@import inside backtick span is NOT extracted', () => {
    const rules = parse('- Use `@types/node` for type definitions');
    expect(rules[0].imports).toEqual([]);
  });
});

describe('@import extraction (file-level)', () => {
  it('extracts @import from normal lines', () => {
    const imports = extractFileImports(
      `See @docs/rules.md for more info.`,
      FILE,
    );
    expect(imports).toHaveLength(1);
    expect(imports[0].path).toBe('docs/rules.md');
    expect(imports[0].lineNumber).toBe(1);
  });

  it('does NOT extract @import from inside fenced code blocks', () => {
    const imports = extractFileImports(
      `\
Rule text.

\`\`\`
@config/secret.yaml
\`\`\`

Another line.`,
      FILE,
    );
    expect(imports).toHaveLength(0);
  });

  it('does NOT extract @import from backtick spans', () => {
    const imports = extractFileImports(
      'Use `@types/react` package.',
      FILE,
    );
    expect(imports).toHaveLength(0);
  });

  it('resolves import path relative to source file', () => {
    const imports = extractFileImports(
      `See @shared/utils.ts`,
      '/home/user/project/CLAUDE.md',
    );
    expect(imports[0].resolvedPath).toContain('shared/utils.ts');
  });
});

// ---------------------------------------------------------------------------
// CRLF normalization
// ---------------------------------------------------------------------------

describe('CRLF handling', () => {
  it('CRLF in content is treated the same as LF', () => {
    // parseMarkdown receives already-normalized content from parseRulesFile,
    // but it should also work if content still has LF (split on \n).
    const lf = '- Rule one\n- Rule two\n- Rule three';
    const rulesLF = parse(lf);
    expect(rulesLF).toHaveLength(3);

    // Simulating what parseRulesFile does: normalize then parse
    const crlf = '- Rule one\r\n- Rule two\r\n- Rule three';
    const normalized = crlf.replace(/\r\n/g, '\n');
    const rulesCRLF = parse(normalized);
    expect(rulesCRLF).toHaveLength(3);
    expect(rulesCRLF.map((r) => r.text)).toEqual(rulesLF.map((r) => r.text));
  });
});

// ---------------------------------------------------------------------------
// Empty sections / blank lines
// ---------------------------------------------------------------------------

describe('empty sections and blank lines', () => {
  it('heading with no content produces no rules', () => {
    const rules = parse(`\
# Empty Section

## Also Empty

# Another Empty`);
    expect(rules).toHaveLength(0);
  });

  it('blank lines do not create rules', () => {
    const rules = parse(`\n\n\n\n`);
    expect(rules).toHaveLength(0);
  });

  it('file with only headings and blank lines produces no rules', () => {
    const rules = parse(`\
# Title

## Subtitle

`);
    expect(rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stable ID generation
// ---------------------------------------------------------------------------

describe('stable ID', () => {
  it('same content + file + line produces same ID', () => {
    const rules1 = parse('- Always use strict mode');
    const rules2 = parse('- Always use strict mode');
    expect(rules1[0].id).toBe(rules2[0].id);
  });

  it('different content produces different ID', () => {
    const rules1 = parse('- Rule A');
    const rules2 = parse('- Rule B');
    expect(rules1[0].id).not.toBe(rules2[0].id);
  });

  it('different source file produces different ID', () => {
    const r1 = parseMarkdown('- Same text', '/a/CLAUDE.md', SCOPE);
    const r2 = parseMarkdown('- Same text', '/b/CLAUDE.md', SCOPE);
    expect(r1[0].id).not.toBe(r2[0].id);
  });

  it('ID is a 16-char hex string', () => {
    const rules = parse('- Some rule');
    expect(rules[0].id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Line numbers
// ---------------------------------------------------------------------------

describe('line numbers', () => {
  it('lineStart and lineEnd are 1-based', () => {
    const rules = parse('First rule.');
    expect(rules[0].lineStart).toBe(1);
    expect(rules[0].lineEnd).toBe(1);
  });

  it('second rule has correct lineStart', () => {
    const rules = parse(`\
First rule.

Second rule.`);
    expect(rules[0].lineStart).toBe(1);
    expect(rules[0].lineEnd).toBe(1);
    expect(rules[1].lineStart).toBe(3);
    expect(rules[1].lineEnd).toBe(3);
  });

  it('multi-line paragraph spans correct range', () => {
    const rules = parse(`\
Line one of para.
Line two of para.
Line three of para.`);
    expect(rules).toHaveLength(1);
    expect(rules[0].lineStart).toBe(1);
    expect(rules[0].lineEnd).toBe(3);
  });

  it('bullet with nested children spans correct range', () => {
    const rules = parse(`\
- Parent bullet
  - Child one
  - Child two`);
    expect(rules).toHaveLength(1);
    expect(rules[0].lineStart).toBe(1);
    expect(rules[0].lineEnd).toBe(3);
  });

  it('rules after code block have correct line numbers', () => {
    const rules = parse(`\
- Rule before code

\`\`\`
some code
more code
\`\`\`

- Rule after code`);
    expect(rules).toHaveLength(2);
    expect(rules[0].lineStart).toBe(1);
    expect(rules[1].lineStart).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Scope and sourceFile passthrough
// ---------------------------------------------------------------------------

describe('metadata passthrough', () => {
  it('sourceFile is set from argument', () => {
    const rules = parseMarkdown('- A rule', '/custom/path.md', 'global');
    expect(rules[0].sourceFile).toBe('/custom/path.md');
  });

  it('sourceScope is set from argument', () => {
    const rules = parseMarkdown('- A rule', FILE, 'subdirectory');
    expect(rules[0].sourceScope).toBe('subdirectory');
  });
});

// ---------------------------------------------------------------------------
// Realistic combined fixture
// ---------------------------------------------------------------------------

describe('realistic CLAUDE.md fixture', () => {
  it('parses a realistic multi-section document correctly', () => {
    const md = `\
# Project Guidelines

## Code Style

- Use TypeScript strict mode for all files
- NEVER use \`any\` type — always provide proper types
  - Exception: third-party libraries without type defs
- Prefer \`const\` over \`let\`; never use \`var\`

## Testing

- \`pnpm test\` must pass before every commit
- IMPORTANT: always write tests for new features
- See @docs/testing-guide.md for conventions

\`\`\`bash
# Example test command
pnpm test --coverage
\`\`\`

## Deployment

---

### CI/CD

Deployments are handled through GitHub Actions.
Do not manually deploy to production.

### Release Process

- Tag releases with semantic versioning
  - Major: breaking changes
  - Minor: new features
  - Patch: bug fixes`;

    const rules = parse(md);

    // --- Counts ---
    // Code Style: 3 bullets (nested grouped into "NEVER use any")
    // Testing: 3 bullets
    // CI/CD: 1 paragraph (2 lines)
    // Release Process: 1 bullet (nested grouped)
    expect(rules.length).toBe(8);

    // --- Code Style section ---
    const strictMode = rules[0];
    expect(strictMode.text).toBe('Use TypeScript strict mode for all files');
    expect(strictMode.sectionHierarchy).toEqual(['Project Guidelines', 'Code Style']);
    expect(strictMode.format).toBe('bullet_point');
    expect(strictMode.emphasis).toBe('normal');

    const neverAny = rules[1];
    expect(neverAny.text).toContain('NEVER use `any` type');
    expect(neverAny.text).toContain('Exception');
    expect(neverAny.emphasis).toBe('important');

    const preferConst = rules[2];
    expect(preferConst.text).toContain('Prefer `const`');

    // --- Testing section ---
    const pnpmTest = rules[3];
    expect(pnpmTest.format).toBe('command');
    expect(pnpmTest.sectionHierarchy).toEqual(['Project Guidelines', 'Testing']);

    const important = rules[4];
    expect(important.emphasis).toBe('important');

    const importRule = rules[5];
    expect(importRule.imports).toContain('docs/testing-guide.md');

    // --- Code block should NOT appear as a rule ---
    const allText = rules.map((r) => r.text).join('\n');
    expect(allText).not.toContain('pnpm test --coverage');

    // --- CI/CD section ---
    const cicd = rules[6];
    expect(cicd.sectionHierarchy).toEqual([
      'Project Guidelines',
      'Deployment',
      'CI/CD',
    ]);
    expect(cicd.text).toContain('GitHub Actions');
    expect(cicd.emphasis).toBe('important'); // "Do not" matches EMPHASIS_PATTERNS (case-insensitive)

    // --- Release Process section ---
    const release = rules[7];
    expect(release.sectionHierarchy).toEqual([
      'Project Guidelines',
      'Deployment',
      'Release Process',
    ]);
    expect(release.text).toContain('semantic versioning');
    expect(release.text).toContain('Major');
  });
});

// ---------------------------------------------------------------------------
// HTML comments
// ---------------------------------------------------------------------------

describe('HTML comments', () => {
  it('lines starting with <!-- are skipped', () => {
    const rules = parse(`\
- Rule one
<!-- this is a comment -->
- Rule two`);
    expect(rules).toHaveLength(2);
    const allText = rules.map((r) => r.text).join(' ');
    expect(allText).not.toContain('comment');
  });
});
