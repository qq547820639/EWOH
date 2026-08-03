export const API_NAMESPACES = {
  organization: '/api/organization',
  workstation: '/api/workstation',
  task: '/api/tasks',
  resource: '/api/resource',
  control: '/api/control',
  eventRule: '/api/event-rules',
  model: '/api/models',
  knowledge: '/api/knowledge',
  notification: '/api/notifications',
  system: '/api/system',
} as const;

export type ApiNamespace = keyof typeof API_NAMESPACES;

export const API_NAMESPACE_LIST = Object.keys(API_NAMESPACES) as ApiNamespace[];
