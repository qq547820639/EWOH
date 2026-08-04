'use strict';

const path = require('path');
const fs = require('fs');

const DIR = __dirname;

const SCHEMA_FILES = [
  'state.schema.json',
  'task-board.schema.json',
  'gate.schema.json',
  'risk.schema.json',
  'decision.schema.json',
  'evidence.schema.json',
  'release-manifest.schema.json',
];

/**
 * Map of schema $id -> schema object.
 */
const SCHEMAS = {};
for (const file of SCHEMA_FILES) {
  const schema = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  if (!schema.$id) {
    throw new Error(`Schema ${file} is missing $id`);
  }
  SCHEMAS[schema.$id] = schema;
}

/**
 * Try to load ajv from ewoh-spark-app/node_modules.
 * @returns {object|null} the ajv module or null if not resolvable.
 */
function loadAjv() {
  try {
    const { createRequire } = require('module');
    const sparkPkg = path.join(DIR, '..', '..', 'ewoh-spark-app', 'package.json');
    const req = createRequire(sparkPkg);
    return req('ajv');
  } catch (err) {
    return null;
  }
}

/**
 * Minimal structural validator fallback.
 * Checks `required` fields and `type` of each required property.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function structuralValidate(schema, document) {
  const errors = [];

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { valid: false, errors: [`expected object, got ${JSON.stringify(document)}`] };
  }

  const required = schema.required || [];
  for (const key of required) {
    if (!(key in document)) {
      errors.push(`missing required property "${key}"`);
      continue;
    }
    const propSchema = schema.properties && schema.properties[key];
    if (propSchema && propSchema.type) {
      const expected = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
      const actual = Array.isArray(document[key]) ? 'array' : typeof document[key];
      if (!expected.includes(actual)) {
        errors.push(`property "${key}" has type ${actual}, expected ${expected.join(' or ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a document against a schema by $id.
 * @param {string} schemaId e.g. 'ewoh:///artifact/state/v1'
 * @param {object} document the JSON document to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(schemaId, document) {
  const schema = SCHEMAS[schemaId];
  if (!schema) {
    return { valid: false, errors: [`unknown schema id "${schemaId}"`] };
  }

  const ajv = loadAjv();
  if (ajv) {
    try {
      const validator = new ajv({ allErrors: true }).compile(schema);
      const valid = validator(document);
      return {
        valid,
        errors: valid ? [] : (validator.errors || []).map((e) => `${e.instancePath} ${e.message}`),
      };
    } catch (err) {
      return {
        valid: false,
        errors: [`ajv validation error: ${err.message}`],
      };
    }
  }

  return structuralValidate(schema, document);
}

module.exports = { SCHEMAS, validate, loadAjv };