import { getAllowedRoles, getVisibleNavGroups } from './navigation';

describe('navigation mobile workbench', () => {
  it('exposes mobile workbench to field roles', () => {
    expect(getAllowedRoles('/mobile-workbench')).toEqual(
      expect.arrayContaining([
        'global_admin',
        'dispatcher',
        'workshop_lead',
        'device_ops',
      ]),
    );
    const groups = getVisibleNavGroups(['workshop_lead']);
    const paths = groups.flatMap((group) => group.items.map((item) => item.to));
    expect(paths).toContain('/mobile-workbench');
  });
});
