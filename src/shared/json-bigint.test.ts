import { describe, expect, it } from 'vitest';
import {
  parseJsonKeepingBigInts,
  parseJsonReportingBigInts,
  prettyJsonText,
  topLevelJsonValue,
} from './json-bigint';

describe('parseJsonKeepingBigInts', () => {
  it('keeps an integer beyond 2^53 as its exact digits', () => {
    expect(parseJsonKeepingBigInts('{"id":9007199254740993,"n":[-9223372036854775808]}')).toEqual({
      id: '9007199254740993',
      n: ['-9223372036854775808'],
    });
  });

  it('leaves every other number alone', () => {
    expect(parseJsonKeepingBigInts('[1, -2, 1.5, 1e3, 9007199254740991, 0.1]')).toEqual([
      1, -2, 1.5, 1000, 9007199254740991, 0.1,
    ]);
    // A float that happens to be huge is not an integer literal: JSON.parse behaviour.
    expect(parseJsonKeepingBigInts('1e30')).toBe(1e30);
  });

  it('keeps strings that look like numbers, and rejects bad JSON like JSON.parse', () => {
    expect(parseJsonKeepingBigInts('"9007199254740993"')).toBe('9007199254740993');
    expect(() => parseJsonKeepingBigInts('{nope')).toThrow();
  });
});

describe('the text of a document, digit for digit', () => {
  const raw =
    '{"_index":"i","_id":"1","_source":{"id":9007199254740993,"name":"a \\"q\\" {x}","tags":[1,2,{"n":-9223372036854775808}],"empty":{},"none":[]},"found":true}';

  it('reports whether an integer had to be kept as text', () => {
    expect(parseJsonReportingBigInts('{"a":1}').kept).toBe(false);
    expect(parseJsonReportingBigInts(raw).kept).toBe(true);
  });

  it('extracts the value of a top-level key untouched', () => {
    expect(topLevelJsonValue(raw, '_source')).toBe(
      '{"id":9007199254740993,"name":"a \\"q\\" {x}","tags":[1,2,{"n":-9223372036854775808}],"empty":{},"none":[]}',
    );
    expect(topLevelJsonValue(raw, 'found')).toBe('true');
    expect(topLevelJsonValue(raw, '_id')).toBe('"1"');
    expect(topLevelJsonValue(raw, 'missing')).toBeNull();
    expect(topLevelJsonValue('[1]', 'a')).toBeNull();
  });

  it('indents without touching a number or a string', () => {
    const pretty = prettyJsonText(topLevelJsonValue(raw, '_source') as string);
    expect(pretty).toContain('"id": 9007199254740993,');
    expect(pretty).toContain('-9223372036854775808');
    expect(pretty).toContain('"empty": {}');
    expect(pretty).toContain('"none": []');
    // Same document as before, parsed with the same loss.
    expect(JSON.parse(pretty)).toEqual(JSON.parse(topLevelJsonValue(raw, '_source') as string));
    expect(pretty.split('\n').length).toBeGreaterThan(8);
  });
});
