import { describe, test, expect } from '@jest/globals';
import { buildWaterfallPivot } from '../../private/js/salesWaterfallPivot.js';

function row(overrides) {
  return {
    shipToParty: '0000302879',
    material: '31446702',
    materialDescription: 'DESC',
    idocNumber: '25753188',
    idocWeek: 202001,
    idocCreationDate: '2020-01-02',
    scheduleWeek: 202006,
    orderQty: 100,
    cumulativeRelease: 100,
    isCurrent: false,
    ...overrides,
  };
}

describe('buildWaterfallPivot', () => {
  test('collects distinct schedule weeks as sorted columns', () => {
    const { weeks } = buildWaterfallPivot([
      row({ scheduleWeek: 202008 }),
      row({ scheduleWeek: 202006 }),
      row({ scheduleWeek: 202007 }),
    ]);
    expect(weeks).toEqual([202006, 202007, 202008]);
  });

  test('drops rows with no schedule week', () => {
    const { rows } = buildWaterfallPivot([row({ scheduleWeek: 0 }), row({ scheduleWeek: null })]);
    expect(rows).toHaveLength(0);
  });

  test('groups by ship-to, material, idoc week/date and release (idoc number)', () => {
    const { rows } = buildWaterfallPivot([
      row({ idocNumber: 'IDOC1', scheduleWeek: 202006, orderQty: 100 }),
      row({ idocNumber: 'IDOC1', scheduleWeek: 202007, orderQty: 50 }),
      row({ idocNumber: 'IDOC2', scheduleWeek: 202006, orderQty: 200 }),
    ]);

    expect(rows).toHaveLength(2);
    const idoc1 = rows.find(r => r.idocNumber === 'IDOC1');
    expect(idoc1.cells.get(202006)).toBe(100);
    expect(idoc1.cells.get(202007)).toBe(50);
    const idoc2 = rows.find(r => r.idocNumber === 'IDOC2');
    expect(idoc2.cells.get(202006)).toBe(200);
  });

  test('sums OrderQty for rows sharing the same group and week in raw mode', () => {
    const { rows } = buildWaterfallPivot([
      row({ scheduleWeek: 202006, orderQty: 30 }),
      row({ scheduleWeek: 202006, orderQty: 20 }),
    ]);
    expect(rows[0].cells.get(202006)).toBe(50);
  });

  test('cumulative mode reads cumulativeRelease and keeps the high-water mark per cell', () => {
    const { rows } = buildWaterfallPivot(
      [
        row({ scheduleWeek: 202006, orderQty: 100, cumulativeRelease: 100 }),
        row({ scheduleWeek: 202006, orderQty: 20, cumulativeRelease: 120 }), // same group+week, later in the running total
      ],
      { cumulative: true }
    );
    expect(rows[0].cells.get(202006)).toBe(120);
  });

  test('labels a live/current-schedule row "Current" and keeps it separate from history idocs', () => {
    const { rows } = buildWaterfallPivot([
      row({ idocNumber: '25753188', isCurrent: false, scheduleWeek: 202006, orderQty: 100 }),
      row({ idocNumber: '25753188', isCurrent: true, scheduleWeek: 202006, orderQty: 10 }),
    ]);

    expect(rows).toHaveLength(2);
    const current = rows.find(r => r.isCurrent);
    expect(current.idocNumber).toBe('Current');
    expect(current.cells.get(202006)).toBe(10);
  });

  test('sorts rows by ship-to, material, idoc week, idoc date, then idoc number', () => {
    const { rows } = buildWaterfallPivot([
      row({ shipToParty: 'B', material: 'M1', idocNumber: 'I2', idocWeek: 202001, scheduleWeek: 202006 }),
      row({ shipToParty: 'A', material: 'M2', idocNumber: 'I1', idocWeek: 202001, scheduleWeek: 202006 }),
      row({ shipToParty: 'A', material: 'M1', idocNumber: 'I3', idocWeek: 202002, scheduleWeek: 202006 }),
      row({ shipToParty: 'A', material: 'M1', idocNumber: 'I1', idocWeek: 202001, scheduleWeek: 202006 }),
    ]);

    expect(rows.map(r => `${r.shipToParty}/${r.material}/${r.idocWeek}/${r.idocNumber}`)).toEqual([
      'A/M1/202001/I1',
      'A/M1/202002/I3',
      'A/M2/202001/I1',
      'B/M1/202001/I2',
    ]);
  });

  test('handles an empty/undefined row list', () => {
    expect(buildWaterfallPivot([])).toEqual({ weeks: [], rows: [] });
    expect(buildWaterfallPivot(undefined)).toEqual({ weeks: [], rows: [] });
  });
});
