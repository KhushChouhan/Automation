export const workflowStatuses = [
  'WAITING_VIDEO',
  'WAITING_FACE',
  'WAITING_TITLE',
  'WAITING_THUMBNAIL',
  'WAITING_APPROVAL',
  'READY',
  'SELECTED',
  'CONTENT_GENERATING',
  'CONTENT_READY',
  'SCHEDULED',
  'PUBLISHING',
  'POSTED',
  'FAILED',
  'RECONCILE_REQUIRED',
] as const;

export type WorkflowStatus = (typeof workflowStatuses)[number];

export const approvalStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED'] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];

export const publicationFailureClasses = [
  'TRANSIENT',
  'RATE_LIMIT',
  'AUTH',
  'VALIDATION',
  'PERMANENT',
  'UNKNOWN',
  'MANUAL_ACTION_REQUIRED',
] as const;

export type PublicationFailureClass = (typeof publicationFailureClasses)[number];

const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  WAITING_VIDEO: ['WAITING_FACE'],
  WAITING_FACE: ['WAITING_TITLE', 'WAITING_VIDEO'],
  WAITING_TITLE: ['WAITING_THUMBNAIL', 'WAITING_FACE', 'WAITING_VIDEO'],
  WAITING_THUMBNAIL: ['WAITING_APPROVAL', 'WAITING_TITLE', 'WAITING_FACE', 'WAITING_VIDEO'],
  WAITING_APPROVAL: [
    'READY',
    'WAITING_THUMBNAIL',
    'WAITING_TITLE',
    'WAITING_FACE',
    'WAITING_VIDEO',
  ],
  READY: [
    'SELECTED',
    'WAITING_APPROVAL',
    'WAITING_THUMBNAIL',
    'WAITING_TITLE',
    'WAITING_FACE',
    'WAITING_VIDEO',
  ],
  SELECTED: ['CONTENT_GENERATING', 'FAILED'],
  CONTENT_GENERATING: ['CONTENT_READY', 'FAILED'],
  CONTENT_READY: ['SCHEDULED', 'FAILED'],
  SCHEDULED: ['PUBLISHING', 'FAILED'],
  PUBLISHING: ['POSTED', 'FAILED', 'RECONCILE_REQUIRED'],
  POSTED: [],
  FAILED: ['READY', 'RECONCILE_REQUIRED'],
  RECONCILE_REQUIRED: ['POSTED', 'FAILED'],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
  }
}

export interface ReadinessInput {
  hasVideo: boolean;
  faceId: string | null;
  title: string | null;
  hasThumbnail: boolean;
  approvalStatus: ApprovalStatus;
}

/** Recalculate waiting status after an input change. Never apply to a posted record. */
export function deriveWorkflowStatus(input: ReadinessInput): WorkflowStatus {
  if (!input.hasVideo) return 'WAITING_VIDEO';
  if (!input.faceId) return 'WAITING_FACE';
  if (!input.title?.trim()) return 'WAITING_TITLE';
  if (!input.hasThumbnail) return 'WAITING_THUMBNAIL';
  if (input.approvalStatus !== 'APPROVED') return 'WAITING_APPROVAL';
  return 'READY';
}
