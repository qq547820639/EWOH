import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  GitBranch,
  Plus,
  Play,
  Trash2,
  Pencil,
  X,
  Factory,
  User,
  Clock,
  AlertTriangle,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { nanoid } from 'nanoid';
import { orchestrateTask } from '@client/src/api/gamification';
import { getCurrentOperator } from '@client/src/lib/auth';
import type {
  SpatialEntity,
  ProcessNode,
  TaskOrchestrationResult,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { UI_ARIA_LABELS } from '../../../lib/a11y';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@client/src/components/ui/dialog';

interface TaskOrchestrationPanelProps {
  entities: SpatialEntity[];
}

interface NodeEditorState {
  open: boolean;
  node: ProcessNode | null;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 96;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 32;

function makeDefaultNode(order: number): ProcessNode {
  return {
    nodeId: nanoid(8),
    name: `工序 ${order}`,
    order,
    assignedWorkstationId: null,
    assignedPersonId: null,
    estimatedTakt: 60,
    dependencies: [],
  };
}

function bottleneckHighlight(
  simulation: TaskOrchestrationResult['simulation'] | null,
  workstationId: string | null | undefined,
): boolean {
  if (!simulation || !workstationId) return false;
  return simulation.bottleneckWorkstationId === workstationId;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

const TaskOrchestrationPanel = ({
  entities,
}: TaskOrchestrationPanelProps): React.ReactElement => {
  const workstations = useMemo(
    () => entities.filter((e) => e.entityType === 'workstation'),
    [entities],
  );
  const persons = useMemo(
    () => entities.filter((e) => e.entityType === 'person'),
    [entities],
  );

  const [nodes, setNodes] = useState<ProcessNode[]>([
    makeDefaultNode(1),
    makeDefaultNode(2),
    makeDefaultNode(3),
  ]);
  const [orderId, setOrderId] = useState<string>(`ORD-${nanoid(6)}`);
  const [productCode, setProductCode] = useState<string>('P-A001');
  const [quantity, setQuantity] = useState<number>(100);
  const [result, setResult] = useState<TaskOrchestrationResult | null>(null);
  const [editor, setEditor] = useState<NodeEditorState>({ open: false, node: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => a.order - b.order);
  }, [nodes]);

  const orchestrateMutation = useMutation({
    mutationFn: () =>
      orchestrateTask({
        orderId,
        productCode,
        quantity,
        nodes,
        operator: getCurrentOperator(),
      }),
    onSuccess: (data) => {
      setResult(data);
      setNodes(data.nodes ?? nodes);
      toast.success('节拍模拟完成');
    },
    onError: () => {
      toast.error('节拍模拟失败');
    },
  });

  const handleAddNode = () => {
    const nextOrder = nodes.length + 1;
    setNodes((prev) => [...prev, makeDefaultNode(nextOrder)]);
  };

  const handleDeleteNode = (nodeId: string) => {
    setNodes((prev) => {
      const next = prev.filter((n) => n.nodeId !== nodeId);
      return next.map((n, idx) => ({ ...n, order: idx + 1 }));
    });
    if (selectedId === nodeId) setSelectedId(null);
  };

  const handleSaveNode = (updated: ProcessNode) => {
    setNodes((prev) => prev.map((n) => (n.nodeId === updated.nodeId ? updated : n)));
    setEditor({ open: false, node: null });
  };

  const handleSimulate = () => {
    if (nodes.length === 0) {
      toast.error('请先添加工序');
      return;
    }
    orchestrateMutation.mutate();
  };

  // Layout: simple horizontal flow with wrap. Each node gets x/y.
  const layout = useMemo(() => {
    const perRow = 4;
    return sortedNodes.map((node, idx) => {
      const row = Math.floor(idx / perRow);
      const col = idx % perRow;
      return {
        node,
        x: col * (NODE_WIDTH + NODE_GAP_X),
        y: row * (NODE_HEIGHT + NODE_GAP_Y),
      };
    });
  }, [sortedNodes]);

  const totalWidth = Math.max(
    ...layout.map((l) => l.x + NODE_WIDTH),
    NODE_WIDTH,
  );
  const totalHeight = Math.max(
    ...layout.map((l) => l.y + NODE_HEIGHT),
    NODE_HEIGHT,
  );

  const entityName = (
    type: 'workstation' | 'person',
    id: string | null | undefined,
  ): string => {
    if (!id) return '未分配';
    const list = type === 'workstation' ? workstations : persons;
    return list.find((e) => e.entityId === id)?.name ?? id;
  };

  const simulation = result?.simulation ?? null;

  return (
    <div className="h-full flex flex-col bg-[hsl(220_14%_14%)] text-white">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <GitBranch className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-xs font-medium text-white/80">任务编排</span>
        <div className="w-px h-4 bg-white/10" />
        <Input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="工单ID"
          className="h-6 w-32 text-[10px] bg-white/5 border-white/10 text-white"
        />
        <Input
          value={productCode}
          onChange={(e) => setProductCode(e.target.value)}
          placeholder="产品编码"
          className="h-6 w-28 text-[10px] bg-white/5 border-white/10 text-white"
        />
        <Input
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value) || 0)}
          placeholder="数量"
          className="h-6 w-20 text-[10px] bg-white/5 border-white/10 text-white"
        />
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2"
          onClick={handleAddNode}
        >
          <Plus className="w-3 h-3" />
          添加工序
        </Button>
        <Button
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={handleSimulate}
          disabled={orchestrateMutation.isPending}
        >
          <Play className="w-3 h-3" />
          {orchestrateMutation.isPending ? '模拟中...' : '节拍模拟'}
        </Button>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {sortedNodes.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-white/70">
            点击「添加工序」创建工序节点
          </div>
        ) : (
          <div
            className="relative"
            style={{ width: totalWidth + 24, height: totalHeight + 24 }}
          >
            {/* SVG dependency lines */}
            <svg
              className="absolute inset-0 pointer-events-none"
              width={totalWidth + 24}
              height={totalHeight + 24}
            >
              {layout.map(({ node, x, y }) => {
                return (node.dependencies ?? []).map((depId) => {
                  const dep = layout.find((l) => l.node.nodeId === depId);
                  if (!dep) return null;
                  const x1 = dep.x + NODE_WIDTH / 2;
                  const y1 = dep.y + NODE_HEIGHT;
                  const x2 = x + NODE_WIDTH / 2;
                  const y2 = y;
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${depId}-${node.nodeId}`}
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      stroke="rgba(255,255,255,0.25)"
                      strokeWidth={1.5}
                      fill="none"
                      markerEnd="url(#arrow)"
                    />
                  );
                });
              })}
              <defs>
                <marker
                  id="arrow"
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.4)" />
                </marker>
              </defs>
            </svg>

            {/* Nodes */}
            {layout.map(({ node, x, y }) => {
              const isBottleneck = bottleneckHighlight(
                simulation,
                node.assignedWorkstationId,
              );
              const isSelected = selectedId === node.nodeId;
              const depNames = (node.dependencies ?? [])
                .map(
                  (d) =>
                    sortedNodes.find((n) => n.nodeId === d)?.name ?? d,
                )
                .join(', ');
              return (
                <div
                  key={node.nodeId}
                  className={cn(
                    'group absolute rounded-lg border bg-white/5 p-2 cursor-pointer transition-colors',
                    isBottleneck
                      ? 'border-red-500/60 bg-red-500/10'
                      : isSelected
                        ? 'border-cyan-500/60 bg-cyan-500/5'
                        : 'border-white/10 hover:border-white/30',
                  )}
                  style={{
                    left: x,
                    top: y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                  }}
                  onClick={() => setSelectedId(node.nodeId)}
                >
                  <div className="flex items-center gap-1">
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 border-white/20 text-white/60"
                    >
                      #{node.order}
                    </Badge>
                    <span className="text-[11px] font-medium text-white/90 truncate flex-1">
                      {node.name}
                    </span>
                    {isBottleneck && (
                      <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                    )}
                  </div>

                  <div className="mt-1 space-y-0.5 text-[10px] text-white/60">
                    <div className="flex items-center gap-1">
                      <Factory className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">
                        {entityName('workstation', node.assignedWorkstationId)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <User className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">
                        {entityName('person', node.assignedPersonId)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 shrink-0" />
                      <span className="tabular-nums">
                        节拍 {node.estimatedTakt ?? '—'}s
                      </span>
                    </div>
                  </div>

                  {depNames && (
                    <div className="mt-1 text-[9px] text-white/60 truncate">
                      依赖: {depNames}
                    </div>
                  )}

                  <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      className="p-0.5 rounded hover:bg-white/10"
                      aria-label={UI_ARIA_LABELS.editProcess}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditor({ open: true, node });
                      }}
                    >
                      <Pencil className="w-2.5 h-2.5 text-white/60" />
                    </button>
                    <button
                      className="p-0.5 rounded hover:bg-white/10"
                      aria-label={UI_ARIA_LABELS.deleteProcess}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteNode(node.nodeId);
                      }}
                    >
                      <Trash2 className="w-2.5 h-2.5 text-red-400" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Simulation result */}
      <div className="shrink-0 border-t border-white/10 p-2 max-h-[100px] overflow-y-auto">
        {!simulation ? (
          <div className="text-[10px] text-white/60">
            点击「节拍模拟」运行节拍仿真。
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Activity className="w-3 h-3 text-cyan-400" />
              <span className="text-[10px] text-white/80">模拟结果</span>
              <div className="flex items-center gap-3 ml-auto text-[10px]">
                <span className="text-white/70">
                  产量/h:{' '}
                  <span className="text-white/90 tabular-nums">
                    {simulation.throughputPerHour}
                  </span>
                </span>
                <span className="text-white/70">
                  完成:{' '}
                  <span className="text-white/90 tabular-nums">
                    {formatDuration(simulation.estimatedCompletionSec)}
                  </span>
                </span>
                {simulation.bottleneckWorkstationName && (
                  <Badge className="text-[9px] px-1.5 py-0 bg-red-500/20 text-red-400 border-red-500/30">
                    <AlertTriangle className="w-2.5 h-2.5" />
                    {simulation.bottleneckWorkstationName}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {simulation.stationTakts.map((s) => (
                <div
                  key={s.workstationId}
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] border',
                    s.isBottleneck
                      ? 'bg-red-500/15 text-red-300 border-red-500/40'
                      : 'bg-white/5 text-white/70 border-white/10',
                  )}
                >
                  {s.isBottleneck ? (
                    <AlertTriangle className="w-2.5 h-2.5" />
                  ) : (
                    <CheckCircle2 className="w-2.5 h-2.5 text-green-400" />
                  )}
                  <span className="truncate max-w-[80px]">{s.workstationName}</span>
                  <span className="tabular-nums text-white/70">{s.taktSec}s</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Node editor dialog */}
      <Dialog
        open={editor.open}
        onOpenChange={(open) => !open && setEditor({ open: false, node: null })}
      >
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Pencil className="w-3.5 h-3.5" />
              编辑工序
            </DialogTitle>
            <DialogDescription className="text-white/70">
              修改工序名称、顺序、分配工位/人员与节拍。
            </DialogDescription>
          </DialogHeader>
          {editor.node && (
            <NodeEditor
              key={editor.node.nodeId}
              initial={editor.node}
              nodes={nodes}
              workstations={workstations}
              persons={persons}
              onSave={handleSaveNode}
              onCancel={() => setEditor({ open: false, node: null })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface NodeEditorProps {
  initial: ProcessNode;
  nodes: ProcessNode[];
  workstations: SpatialEntity[];
  persons: SpatialEntity[];
  onSave: (node: ProcessNode) => void;
  onCancel: () => void;
}

function NodeEditor({
  initial,
  nodes,
  workstations,
  persons,
  onSave,
  onCancel,
}: NodeEditorProps): React.ReactElement {
  const [name, setName] = useState(initial.name);
  const [order, setOrder] = useState(initial.order);
  const [workstationId, setWorkstationId] = useState<string>(
    initial.assignedWorkstationId ?? '',
  );
  const [personId, setPersonId] = useState<string>(initial.assignedPersonId ?? '');
  const [takt, setTakt] = useState<number>(initial.estimatedTakt ?? 60);
  const [deps, setDeps] = useState<string[]>(initial.dependencies ?? []);

  const candidateDeps = nodes.filter((n) => n.nodeId !== initial.nodeId);

  const toggleDep = (id: string) => {
    setDeps((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-white/70">工序名称</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 text-xs bg-white/5 border-white/10 text-white"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/70">顺序</label>
          <Input
            type="number"
            value={order}
            onChange={(e) => setOrder(Number(e.target.value) || 1)}
            className="h-7 text-xs bg-white/5 border-white/10 text-white"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/70">分配工位</label>
          <select
            value={workstationId}
            onChange={(e) => setWorkstationId(e.target.value)}
            className="h-7 w-full text-xs bg-white/5 border border-white/10 rounded-md text-white px-2"
          >
            <option value="">未分配</option>
            {workstations.map((w) => (
              <option key={w.entityId} value={w.entityId}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/70">分配人员</label>
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className="h-7 w-full text-xs bg-white/5 border border-white/10 rounded-md text-white px-2"
          >
            <option value="">未分配</option>
            {persons.map((p) => (
              <option key={p.entityId} value={p.entityId}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/70">预计节拍(秒)</label>
          <Input
            type="number"
            value={takt}
            onChange={(e) => setTakt(Number(e.target.value) || 0)}
            className="h-7 text-xs bg-white/5 border-white/10 text-white"
          />
        </div>
      </div>

      <div>
        <label className="text-[10px] text-white/70">前置工序依赖</label>
        <div className="mt-1 max-h-24 overflow-y-auto rounded-md border border-white/10 bg-white/5 p-1.5 space-y-1">
          {candidateDeps.length === 0 ? (
            <div className="text-[10px] text-white/60">无可用前置工序</div>
          ) : (
            candidateDeps.map((d) => (
              <label
                key={d.nodeId}
                className="flex items-center gap-1.5 text-[10px] text-white/70 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={deps.includes(d.nodeId)}
                  onChange={() => toggleDep(d.nodeId)}
                  className="w-3 h-3"
                />
                <span className="truncate">
                  #{d.order} {d.name}
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          <X className="w-3 h-3" />
          取消
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onSave({
              ...initial,
              name: name.trim() || initial.name,
              order,
              assignedWorkstationId: workstationId || null,
              assignedPersonId: personId || null,
              estimatedTakt: takt,
              dependencies: deps,
            })
          }
        >
          保存
        </Button>
      </DialogFooter>
    </div>
  );
}

export default TaskOrchestrationPanel;
