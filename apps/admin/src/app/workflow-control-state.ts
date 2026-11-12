export type WorkflowAction =
  'generate' | 'regenerate' | 'retry-content' | 'prepare' | 'retry-media';

export type WorkflowControlState = {
  videoId: string;
  approvalStatus: string;
  workflowStatus: string;
  hasContent: boolean;
  hasSchedule: boolean;
  mediaStatus: string;
};

export function actionAvailability(
  action: WorkflowAction,
  props: WorkflowControlState,
): { enabled: boolean; reason: string } {
  if (props.approvalStatus !== 'APPROVED')
    return { enabled: false, reason: 'Complete required inputs and approve this video first.' };
  const selected = ['SELECTED', 'CONTENT_READY', 'SCHEDULED'].includes(props.workflowStatus);
  if (action === 'retry-content' && props.workflowStatus === 'FAILED')
    return { enabled: true, reason: '' };
  if (!selected)
    return {
      enabled: false,
      reason: 'Automatic scheduling must select this approved video first.',
    };
  if (action === 'regenerate' && !props.hasContent)
    return { enabled: false, reason: 'Generate the first content version before regenerating.' };
  if (action === 'prepare' && (!props.hasContent || !props.hasSchedule))
    return { enabled: false, reason: 'Generated content and a schedule are required.' };
  if (action === 'prepare' && props.mediaStatus !== 'PENDING')
    return {
      enabled: false,
      reason:
        props.mediaStatus === 'READY'
          ? 'Durable media is already ready.'
          : 'Use Retry Media for a failed preparation.',
    };
  if (action === 'retry-media' && props.mediaStatus !== 'FAILED')
    return { enabled: false, reason: 'Retry is available only after media preparation fails.' };
  return { enabled: true, reason: '' };
}
