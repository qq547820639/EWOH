/* CLI-604~607 批量修复：为 openapi YAML 中全部裸 type:object（无 properties/
 * additionalProperties）的 schema 节点补 additionalProperties: true；
 * 对 EXCEPTIONS 中有真实契约形状的节点注入 properties。
 *
 * 用法：node scripts/fix-bare-objects.cjs openapi/ewoh.yaml
 * 幂等：重复运行不产生变更。
 */
const fs = require('fs');
const path = require('path');
const YAML = require(path.join(__dirname, '..', 'ewoh-spark-app', 'node_modules', 'yaml'));

const strArray = { type: 'array', items: { type: 'string' } };

/* 有真实契约形状的例外节点（来源：contracts/agent/agent-manifest.schema.json、
 * shared/agent-manifest.ts、shared/reasoning-trace.ts）。 */
const EXCEPTIONS = {
  'components.schemas.AgentManifestInput.properties.writeScope': {
    properties: { tokens: strArray, commands: strArray },
  },
  'components.schemas.AgentManifestInput.properties.approvalRequirement': {
    properties: {
      autonomousLevel: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3'] },
      approvalRequiredFor: strArray,
    },
    required: ['autonomousLevel', 'approvalRequiredFor'],
  },
  'components.schemas.AgentManifestInput.properties.inputContract': {
    properties: { schemaRef: { type: 'string' } },
    required: ['schemaRef'],
  },
  'components.schemas.AgentManifestInput.properties.outputContract': {
    properties: { schemaRef: { type: 'string' } },
    required: ['schemaRef'],
  },
  'components.schemas.AgentManifestInput.properties.budget': {
    properties: {
      maxSteps: { type: 'integer', minimum: 1 },
      maxTokens: { type: 'integer', minimum: 1 },
      maxDurationSec: { type: 'integer', minimum: 1 },
    },
    required: ['maxSteps', 'maxTokens', 'maxDurationSec'],
  },
  'components.schemas.AgentManifestInput.properties.fallback': {
    properties: {
      onFailure: { type: 'string', enum: ['degrade', 'queue', 'abort'] },
    },
    required: ['onFailure'],
  },
  'components.schemas.ReasoningTrace.properties.factsRef': {
    properties: { snapshotVersion: { type: 'integer' }, eventIds: strArray },
    required: ['snapshotVersion', 'eventIds'],
  },
};

function get(node, key) {
  if (!node || typeof node.get !== 'function') return undefined;
  return node.get(key, true);
}

function main(file) {
  const src = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(src);
  let added = 0;
  let injected = 0;
  const trails = new Set();

  const isBareObject = (node) => {
    if (!node || !node.items || typeof node.get !== 'function') return false;
    if (get(node, '$ref') !== undefined) return false;
    const type = get(node, 'type');
    /* type: object（scalar）或 type: [ object, 'null' ]（seq）。 */
    const typeIsObject = type == null ? false
      : typeof type === 'object' && type.items
        ? type.items.some((t) => String(t.value) === 'object')
        : String(type.value ?? type) === 'object';
    if (!typeIsObject) return false;
    return (
      get(node, 'properties') === undefined
      && get(node, 'additionalProperties') === undefined
      && get(node, 'allOf') === undefined
      && get(node, 'oneOf') === undefined
      && get(node, 'anyOf') === undefined
    );
  };

  const walk = (node, trail) => {
    if (node == null) return;
    if (node.items && node.items.forEach) {
      if (isBareObject(node)) {
        trails.add(trail);
        const exception = EXCEPTIONS[trail];
        if (exception) {
          /* 深拷贝注入，避免同一 JS 对象被重复引用时 yaml 生成 &anchor/*alias。 */
          const clone = (v) => JSON.parse(JSON.stringify(v));
          if (exception.properties) node.set('properties', doc.createNode(clone(exception.properties)));
          if (exception.required) node.set('required', doc.createNode(clone(exception.required)));
          injected += 1;
        } else {
          node.set('additionalProperties', true);
          added += 1;
        }
      }
      node.items.forEach((item) => {
        if (!item.key) return;
        walk(item.value, trail ? `${trail}.${String(item.key)}` : String(item.key));
      });
    } else if (node.items && typeof node.items === 'object') {
      node.items.forEach((item, i) => {
        if (item && item.key) {
          walk(item.value, trail ? `${trail}.${String(item.key)}` : String(item.key));
        } else {
          walk(item, `${trail}[${i}]`);
        }
      });
    }
  };

  walk(doc.contents, '');
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  console.log(`${path.basename(file)}: additionalProperties +=${added}, properties 注入=${injected}, 覆盖例外=${Object.keys(EXCEPTIONS).filter((k) => trails.has(k)).length}/${Object.keys(EXCEPTIONS).length}`);
  const missed = Object.keys(EXCEPTIONS).filter((k) => !trails.has(k));
  if (missed.length) console.error('未命中例外（路径漂移？）:', missed);
}

for (const f of process.argv.slice(2)) main(f);
