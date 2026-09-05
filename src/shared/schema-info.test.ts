import { describe, expect, it } from 'vitest';
import { SchemaInfo } from './protocol';

const base = {
  schemas: [{ name: 'public' }],
  tables: [
    { schema: 'public', name: 'orders', kind: 'table' as const, rowCountEstimate: 10 },
  ],
  columns: [
    {
      schema: 'public',
      table: 'orders',
      name: 'status',
      dataType: 'order_status',
      ordinal: 1,
      isPrimaryKey: false,
      isNullable: false,
      hasDefault: false,
    },
  ],
};

describe('SchemaInfo (U34 extended introspection)', () => {
  it('defaults missing catalog arrays on legacy snapshots', () => {
    const parsed = SchemaInfo.parse(base);
    expect(parsed.foreignKeys).toEqual([]);
    expect(parsed.functions).toEqual([]);
    expect(parsed.enums).toEqual([]);
    expect(parsed.indexes).toEqual([]);
    expect(parsed.triggers).toEqual([]);
    expect(parsed.sequences).toEqual([]);
  });

  it('preserves functions, enums, indexes, triggers, and sequences', () => {
    const parsed = SchemaInfo.parse({
      ...base,
      functions: [
        {
          schema: 'public',
          name: 'next_order',
          identityArgs: '',
          returnType: 'bigint',
          language: 'sql',
          kind: 'function',
        },
      ],
      enums: [{ schema: 'public', name: 'order_status', labels: ['open', 'closed'] }],
      indexes: [
        {
          schema: 'public',
          table: 'orders',
          name: 'orders_pkey',
          definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
          isUnique: true,
          isPrimary: true,
          columns: ['id'],
        },
      ],
      triggers: [
        {
          schema: 'public',
          table: 'orders',
          name: 'orders_audit',
          timing: 'AFTER',
          events: 'INSERT/UPDATE',
          definition: 'CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION audit()',
          enabled: true,
        },
      ],
      sequences: [
        {
          schema: 'public',
          name: 'orders_id_seq',
          dataType: 'bigint',
          startValue: '1',
          incrementBy: '1',
        },
      ],
    });
    expect(parsed.functions[0]?.name).toBe('next_order');
    expect(parsed.enums[0]?.labels).toEqual(['open', 'closed']);
    expect(parsed.indexes[0]?.isPrimary).toBe(true);
    expect(parsed.triggers[0]?.events).toBe('INSERT/UPDATE');
    expect(parsed.sequences[0]?.dataType).toBe('bigint');
  });
});
