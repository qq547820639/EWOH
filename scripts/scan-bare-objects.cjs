/* 扫描 openapi YAML 中裸 type:object（无 properties/additionalProperties）的 schema 节点。 */
const fs = require('fs');
const path = require('path');
const yaml = require(path.join(__dirname, '..', 'ewoh-spark-app', 'node_modules', 'js-yaml'));

const files = process.argv.slice(2);
for (const file of files) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const bare = [];
  const walk = (node, trail) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${trail}[${i}]`));
      return;
    }
    if (node.$ref !== undefined) return;
    const typeOk = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
    if (
      typeOk
      && !node.properties
      && node.additionalProperties === undefined
      && !node.allOf && !node.oneOf && !node.anyOf
    ) {
      bare.push(trail);
    }
    for (const [k, v] of Object.entries(node)) walk(v, trail ? `${trail}.${k}` : k);
  };
  walk(doc, '');
  console.log(`\n=== ${path.basename(file)}: ${bare.length} bare object schemas ===`);
  for (const t of bare) console.log(t);
}
