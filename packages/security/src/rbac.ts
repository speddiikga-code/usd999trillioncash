import type { Role } from '@roos/shared';

export const PERMISSIONS = [
  'org:read',
  'org:write',
  'members:manage',
  'opportunity:read',
  'opportunity:write',
  'research:run',
  'build:run',
  'deploy:run',
  'experiment:read',
  'experiment:write',
  'revenue:read',
  'revenue:write',
  'lead:read',
  'lead:write',
  'lead:export',
  'campaign:write',
  'approval:read',
  'approval:decide',
  'agent:read',
  'agent:run',
  'agent:manage',
  'audit:read',
  'settings:read',
  'settings:write',
  'secrets:write',
  'policy:write',
  'report:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = [
  'org:read',
  'opportunity:read',
  'experiment:read',
  'revenue:read',
  'approval:read',
  'agent:read',
  'report:read',
  'settings:read',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS.filter((p) => p !== 'members:manage')),
  operator: new Set<Permission>([
    ...READ,
    'lead:read',
    'opportunity:write',
    'research:run',
    'build:run',
    'deploy:run',
    'experiment:write',
    'lead:write',
    'campaign:write',
    'agent:run',
    'revenue:write',
  ]),
  analyst: new Set<Permission>([...READ, 'lead:read', 'opportunity:write', 'research:run', 'agent:run']),
  viewer: new Set<Permission>(READ),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Roles may only grant roles at or below their own level. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, operator: 2, admin: 3, owner: 4 };
export function canGrantRole(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[target] && can(actor, 'members:manage');
}
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
