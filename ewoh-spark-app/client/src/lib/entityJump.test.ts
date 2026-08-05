import { entityRoute, jumpTo } from './entityJump';

describe('entityJump (UX-001 跨实体跳转)', () => {
  it('maps every entity type to an existing route', () => {
    expect(entityRoute('alert')).toBe('/alerts');
    expect(entityRoute('device')).toBe('/devices');
    expect(entityRoute('person')).toBe('/personnel');
    expect(entityRoute('workorder')).toBe('/scheduling');
    expect(entityRoute('process')).toBe('/operations');
    expect(entityRoute('quality')).toBe('/alerts');
    expect(entityRoute('replay')).toBe('/digital-world');
    expect(entityRoute('event')).toBe('/events');
  });

  it('returns the base list route when no id is given', () => {
    expect(jumpTo('device')).toBe('/devices');
  });

  it('appends an encoded id for detail jumps', () => {
    expect(jumpTo('device', 'DEV-7')).toBe('/devices/DEV-7');
    expect(jumpTo('workorder', 'WO 1001')).toBe('/scheduling/WO%201001');
    expect(jumpTo('alert', 'A-1')).toBe('/alerts/A-1');
  });
});