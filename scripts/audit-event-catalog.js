#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app/package.json'));
const yaml = requireFromApp('js-yaml');

const catalogPath = path.join(root, 'contracts/events/event-catalog.yaml');
const catalog = yaml.load(fs.readFileSync(catalogPath, 'utf8'));

const errors = [];
const expect = (condition, message) => {
  if (!condition) errors.push(message);
};

expect(catalog.asyncapi === '2.6.0', 'asyncapi version must be 2.6.0');
expect(typeof catalog.info?.title === 'string', 'info.title is required');
expect(
  /^\d+\.\d+\.\d+$/.test(catalog.info?.version ?? ''),
  'info.version must be semver-like',
);
expect(
  catalog['x-event-types']?.length > 0,
  'x-event-types index is required',
);

const messages = catalog.components?.messages ?? {};
const messageTypes = Object.keys(messages);
expect(
  JSON.stringify(catalog['x-event-types']) === JSON.stringify(messageTypes),
  'x-event-types must exactly match components.messages keys',
);
expect(
  new Set(messageTypes).size === messageTypes.length,
  'event types must be unique',
);

for (const type of messageTypes) {
  expect(/^[A-Z][A-Za-z0-9]+$/.test(type), `event type ${type} must be PascalCase`);
  const message = messages[type];
  expect(
    message.name === type,
    `message ${type}.name must equal the component key`,
  );
  expect(
    message.contentType === 'application/cloudevents+json',
    `message ${type} must use CloudEvents content type`,
  );
  expect(
    message['x-cloud-events']?.specversion === '1.0',
    `message ${type} must declare CloudEvents 1.0`,
  );
  expect(
    /^com\.ewoh\./.test(message['x-cloud-events']?.type ?? ''),
    `message ${type} must use com.ewoh.* type prefix`,
  );
  expect(
    String(message['x-cloud-events']?.source ?? '').includes('{orgId}'),
    `message ${type} source must carry orgId resource attribute`,
  );
  expect(
    message.payload?.type === 'object' &&
      typeof message.payload?.properties === 'object' &&
      Object.keys(message.payload?.properties ?? {}).length > 0,
    `message ${type} payload must be a non-empty object schema`,
  );
  expect(
    (message.payload?.required ?? []).includes('orgId') &&
      (message.payload?.required ?? []).includes('occurredAt'),
    `message ${type} payload must require orgId and occurredAt`,
  );
}

for (const [channel, value] of Object.entries(catalog.channels ?? {})) {
  const ref = value?.publish?.message?.$ref ?? value?.subscribe?.message?.$ref;
  expect(
    /^#\/components\/messages\/[A-Za-z0-9]+$/.test(ref ?? ''),
    `channel ${channel} must reference a message`,
  );
  const type = ref?.split('/').pop();
  expect(
    type && messages[type],
    `channel ${channel} references missing message ${type}`,
  );
}

if (errors.length > 0) {
  console.error('EVENT CATALOG AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Event catalog audit: ${catalog.asyncapi} | ${catalog.info.version} | ` +
    `${messageTypes.length} messages | ${Object.keys(catalog.channels ?? {}).length} channels`,
);
