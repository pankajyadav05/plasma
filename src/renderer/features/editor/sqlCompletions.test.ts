import { describe, expect, it } from 'vitest';
import type { SchemaInfo } from '@shared/protocol';
import { enumLabelsForContext, labelsForDataType } from './enumCompletions';

const schema: SchemaInfo = {
  schemas: [{ name: 'public' }],
  tables: [{ schema: 'public', name: 'orders', kind: 'table', rowCountEstimate: null }],
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
    {
      schema: 'public',
      table: 'orders',
      name: 'id',
      dataType: 'bigint',
      ordinal: 2,
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: true,
    },
  ],
  foreignKeys: [],
  functions: [],
  enums: [{ schema: 'public', name: 'order_status', labels: ['open', 'paid', 'cancelled'] }],
  indexes: [],
  triggers: [],
  sequences: [],
};

describe('enumLabelsForContext', () => {
  it('suggests labels after column =', () => {
    expect(enumLabelsForContext(schema, 'WHERE status =', 'SELECT * FROM orders WHERE status =')).toEqual([
      'open',
      'paid',
      'cancelled',
    ]);
  });

  it('suggests labels after column IN (', () => {
    expect(
      enumLabelsForContext(schema, 'WHERE status IN (', 'SELECT * FROM orders WHERE status IN ('),
    ).toEqual(['open', 'paid', 'cancelled']);
  });

  it('suggests labels after IN ( with prior values', () => {
    expect(
      enumLabelsForContext(
        schema,
        "WHERE status IN ('open', ",
        "SELECT * FROM orders WHERE status IN ('open', ",
      ),
    ).toEqual(['open', 'paid', 'cancelled']);
  });

  it('returns null for non-enum columns', () => {
    expect(enumLabelsForContext(schema, 'WHERE id =', 'SELECT * FROM orders WHERE id =')).toBeNull();
  });

  it('matches qualified enum data types', () => {
    expect(labelsForDataType(schema.enums, 'public.order_status')).toEqual([
      'open',
      'paid',
      'cancelled',
    ]);
  });
});
