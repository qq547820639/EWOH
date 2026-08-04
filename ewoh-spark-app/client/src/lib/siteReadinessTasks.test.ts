import {
  openTasks,
  registerTask,
  tasksForStage,
  updateTask,
  signBusiness,
  EMPTY_APPROVAL,
} from './siteReadinessTasks';

describe('siteReadinessTasks', () => {
  it('registers tasks idempotently per stage+evidence', () => {
    const base = {
      stageId: 'F2' as const,
      evidenceId: 'F2.erp',
      label: 'ERP 连通',
      owner: '',
      deadline: '',
      status: 'open' as const,
    };
    let tasks = registerTask([], base);
    tasks = registerTask(tasks, base);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
  });

  it('updates owner and deadline and filters open tasks', () => {
    let tasks = registerTask([], {
      stageId: 'F2',
      evidenceId: 'F2.erp',
      label: 'ERP 连通',
      owner: '',
      deadline: '',
      status: 'open',
    });
    tasks = updateTask(tasks, tasks[0].id, { owner: '张三', deadline: '2026-08-10' });
    expect(tasks[0].owner).toBe('张三');
    expect(tasks[0].deadline).toBe('2026-08-10');
    tasks = updateTask(tasks, tasks[0].id, { status: 'done' });
    expect(openTasks(tasks)).toHaveLength(0);
    expect(tasksForStage(tasks, 'F2')).toHaveLength(1);
  });

  it('records a local business sign', () => {
    const approval = signBusiness(EMPTY_APPROVAL, '李四');
    expect(approval.businessSigner).toBe('李四');
    expect(approval.signedAt).toBeTruthy();
  });
});