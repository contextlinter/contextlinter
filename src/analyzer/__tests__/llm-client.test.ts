import { describe, it, expect } from 'vitest';
import { parseCliResponse, extractJsonFromText } from '../llm-client.js';

// ---------------------------------------------------------------------------
// extractJsonFromText
// ---------------------------------------------------------------------------

describe('extractJsonFromText', () => {
  it('parses clean JSON response', () => {
    const json = JSON.stringify([{ id: '1', title: 'Test insight' }]);
    const result = extractJsonFromText(json);
    expect(result).toEqual([{ id: '1', title: 'Test insight' }]);
  });

  it('parses JSON wrapped in markdown fences', () => {
    const text = '```json\n[{"id": "1", "title": "Test"}]\n```';
    const result = extractJsonFromText(text);
    expect(result).toEqual([{ id: '1', title: 'Test' }]);
  });

  it('parses JSON wrapped in plain markdown fences (no language tag)', () => {
    const text = '```\n[{"id": "1"}]\n```';
    const result = extractJsonFromText(text);
    expect(result).toEqual([{ id: '1' }]);
  });

  it('parses JSON with preamble text before the JSON array', () => {
    const text = 'Here are the insights I found:\n\n[{"id": "1", "title": "Test"}]';
    const result = extractJsonFromText(text);
    expect(result).toEqual([{ id: '1', title: 'Test' }]);
  });

  it('handles empty response gracefully', () => {
    expect(extractJsonFromText('')).toBeNull();
  });

  it('handles non-JSON response gracefully', () => {
    const result = extractJsonFromText('This is just plain text with no JSON at all.');
    expect(result).toBeNull();
  });

  it('parses a plain JSON object (not just arrays)', () => {
    const json = JSON.stringify({ key: 'value' });
    const result = extractJsonFromText(json);
    expect(result).toEqual({ key: 'value' });
  });
});

// ---------------------------------------------------------------------------
// parseCliResponse
// ---------------------------------------------------------------------------

describe('parseCliResponse', () => {
  it('parses CLI JSON output with result field', () => {
    const cliOutput = JSON.stringify({
      result: '[{"id": "1", "title": "Insight"}]',
    });
    const result = parseCliResponse(cliOutput);
    expect(result).toEqual([{ id: '1', title: 'Insight' }]);
  });

  it('unwraps CLI result containing markdown-fenced JSON', () => {
    const cliOutput = JSON.stringify({
      result: '```json\n[{"id": "2"}]\n```',
    });
    const result = parseCliResponse(cliOutput);
    expect(result).toEqual([{ id: '2' }]);
  });

  it('unwraps CLI result containing preamble text before JSON', () => {
    const cliOutput = JSON.stringify({
      result: 'Here are the results:\n[{"id": "3"}]',
    });
    const result = parseCliResponse(cliOutput);
    expect(result).toEqual([{ id: '3' }]);
  });

  it('falls back to direct extraction when raw is not CLI JSON', () => {
    const raw = '[{"id": "4"}]';
    const result = parseCliResponse(raw);
    expect(result).toEqual([{ id: '4' }]);
  });

  it('handles empty response gracefully', () => {
    expect(parseCliResponse('')).toBeNull();
  });

  it('handles non-JSON response gracefully (returns null, no crash)', () => {
    const result = parseCliResponse('Sorry, I cannot help with that.');
    expect(result).toBeNull();
  });

  it('handles whitespace-only response', () => {
    expect(parseCliResponse('   \n\t  ')).toBeNull();
  });
});
