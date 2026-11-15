export const roles = ['requester', 'agent', 'admin'] as const;
export type Role = (typeof roles)[number];
/** Agents and admins work the queue; requesters only deal with their own requests. */
export const isStaff = (role: Role): boolean => role !== 'requester';
