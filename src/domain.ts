export const statuses = ['Open', 'Assigned', 'In progress', 'Completed'] as const;
export type Status = (typeof statuses)[number];
export const priorities = ['Low', 'Normal', 'High', 'Urgent'] as const;
export type Priority = (typeof priorities)[number];
export const teams = ['Facilities', 'IT', 'People', 'Operations'] as const;
export type Team = (typeof teams)[number];
export const historyKinds = ['opened', 'status', 'assigned', 'priority', 'commented'] as const;
export type HistoryKind = (typeof historyKinds)[number];
export const sortKeys = ['updated', 'created', 'priority'] as const;
export type SortKey = (typeof sortKeys)[number];
export const sortOrders = ['asc', 'desc'] as const;
export type SortOrder = (typeof sortOrders)[number];

/** Which status may follow which. A status never skips a step. */
export const transitions: Record<Status, readonly Status[]> = {
  Open: ['Assigned'], Assigned: ['Open', 'In progress'], 'In progress': ['Assigned', 'Completed'], Completed: ['Open']
};
export const limits = {title: 100, description: 1000, comment: 2000, search: 100, pageDefault: 20, pageMax: 100} as const;
