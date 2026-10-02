import { describe, expect, it, vi } from 'vitest';
import {
  inlineVariables,
  mergeVariableHistory,
  pruneVariableValues,
  pushVariableHistory,
  rawVariablesIn,
  runBound,
  unresolvedVariables,
  variableProblem,
} from './query-variables';

const t = (value: string) => ({ mode: 'text' as const, value });

describe('variableProblem', () => {
  it('names what is missing, invalid or conflicting', () => {
    expect(variableProblem('select :a', {})).toBe('Fill in :a first');
    expect(variableProblem('select :a', { a: { mode: 'number', value: 'x' } })).toBe(
      ':a — Enter a number',
    );
    expect(variableProblem('select $1, :a', { a: t('x') })).toMatch(/\$1/);
    expect(variableProblem('select :a', { a: t('x') })).toBeNull();
    expect(variableProblem('select 1', {})).toBeNull();
    expect(unresolvedVariables('select :a, :b', { a: t('x') })).toEqual(['b']);
  });
});

describe('inlineVariables / rawVariablesIn', () => {
  it('writes literals inline for preview and gate checks', () => {
    expect(
      inlineVariables('delete from t where n = :n and id = :id', {
        n: t("o'k"),
        id: { mode: 'number', value: '5' },
      }),
    ).toBe("delete from t where n = 'o''k' and id = 5");
    expect(inlineVariables('select :a', {})).toBe('select :a');
  });
  it('reports raw variables', () => {
    expect(
      rawVariablesIn('select * from :tbl where a = :a', {
        tbl: { mode: 'raw', value: 'x' },
        a: t('1'),
      }),
    ).toEqual(['tbl']);
  });
});

describe('runBound', () => {
  it('runs a statement without variables as written', async () => {
    const exec = vi.fn(async () => 'ok');
    await runBound('select 1', {}, exec);
    expect(exec).toHaveBeenCalledWith('select 1', undefined);
  });

  it('binds values as parameters', async () => {
    const exec = vi.fn(async () => 'ok');
    await runBound('select * from t where a = :a', { a: t('x') }, exec);
    expect(exec).toHaveBeenCalledWith('select * from t where a = $1', ['x']);
  });

  it('refuses to run with a missing value', async () => {
    const exec = vi.fn(async () => 'ok');
    await expect(runBound('select :a', {}, exec)).rejects.toThrow('Fill in :a first');
    expect(exec).not.toHaveBeenCalled();
  });

  it('retries with a literal when the parameter type cannot be inferred', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const exec = async (sql: string, params: unknown[] | undefined) => {
      calls.push([sql, params]);
      if (params) throw new Error('could not determine data type of parameter $1');
      return 'ok';
    };
    await expect(runBound("select :'a'", { a: t('hi') }, exec)).resolves.toBe('ok');
    expect(calls).toEqual([
      ['select $1', ['hi']],
      ["select 'hi'", undefined],
    ]);
  });

  it('inlines only the variable the server complained about', async () => {
    const calls: string[] = [];
    const exec = async (sql: string, params: unknown[] | undefined) => {
      calls.push(`${sql} | ${JSON.stringify(params)}`);
      if (sql.includes('$2')) throw new Error('could not determine data type of parameter $2');
      return 'ok';
    };
    await runBound('select :a, :b', { a: t('1'), b: t('2') }, exec);
    expect(calls).toEqual(['select $1, $2 | ["1","2"]', 'select $1, \'2\' | ["1"]']);
  });

  it('rethrows unrelated errors and does not loop forever', async () => {
    const boom = vi.fn(async () => {
      throw new Error('syntax error at or near ")"');
    });
    await expect(runBound('select :a', { a: t('x') }, boom)).rejects.toThrow('syntax error');
    expect(boom).toHaveBeenCalledTimes(1);
    const stubborn = vi.fn(async () => {
      throw new Error('could not determine data type of parameter $1');
    });
    await expect(runBound('select :a', { a: t('x') }, stubborn)).rejects.toThrow(
      'could not determine',
    );
    expect(stubborn).toHaveBeenCalledTimes(2);
  });
});

describe('variable history', () => {
  it('keeps newest first, deduped and capped; ignores null and blank', () => {
    let h: Record<string, string[]> = {};
    for (const v of ['a', 'b', 'a', 'c']) h = pushVariableHistory(h, 'x', t(v), 3);
    expect(h.x).toEqual(['c', 'a', 'b']);
    h = pushVariableHistory(h, 'x', t('d'), 3);
    expect(h.x).toEqual(['d', 'c', 'a']);
    expect(pushVariableHistory(h, 'x', { mode: 'null', value: '' })).toBe(h);
    expect(pushVariableHistory(h, 'x', t('  '))).toBe(h);
    expect(pushVariableHistory(h, 'x', t('d'), 3)).toBe(h);
  });

  it('merges the values of a run into the history', () => {
    const h = mergeVariableHistory({}, ['a', 'b'], { a: t('1'), b: { mode: 'null', value: '' } });
    expect(h).toEqual({ a: ['1'] });
    expect(mergeVariableHistory(h, ['a'], { a: t('1') })).toBe(h);
  });

  it('prunes values to the names in use', () => {
    expect(pruneVariableValues({ a: t('1'), b: t('2') }, ['b'])).toEqual({ b: t('2') });
  });
});
