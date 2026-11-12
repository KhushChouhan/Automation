import { describe, expect, it } from 'vitest';
import {
  actionAvailability,
  type WorkflowAction,
  type WorkflowControlState,
} from './workflow-control-state';

const actions: WorkflowAction[] = [
  'generate',
  'regenerate',
  'retry-content',
  'prepare',
  'retry-media',
];

function state(overrides: Partial<WorkflowControlState> = {}): WorkflowControlState {
  return {
    videoId: 'GCS-0021',
    approvalStatus: 'APPROVED',
    workflowStatus: 'SCHEDULED',
    hasContent: true,
    hasSchedule: true,
    mediaStatus: 'PENDING',
    ...overrides,
  };
}

describe('workflow control availability', () => {
  it('blocks every operation before dashboard approval and automatic selection', () => {
    for (const action of actions) {
      expect(
        actionAvailability(
          action,
          state({ approvalStatus: 'PENDING', workflowStatus: 'WAITING_FACE', hasContent: false }),
        ).enabled,
      ).toBe(false);
    }
  });

  it('exposes generate/retry and only valid content/media operations for a scheduled video', () => {
    expect(actionAvailability('generate', state()).enabled).toBe(true);
    expect(actionAvailability('regenerate', state()).enabled).toBe(true);
    expect(actionAvailability('retry-content', state()).enabled).toBe(true);
    expect(actionAvailability('prepare', state()).enabled).toBe(true);
    expect(actionAvailability('retry-media', state()).enabled).toBe(false);
  });

  it('requires an existing version for regeneration and a schedule for media preparation', () => {
    expect(actionAvailability('regenerate', state({ hasContent: false })).enabled).toBe(false);
    expect(actionAvailability('prepare', state({ hasSchedule: false })).enabled).toBe(false);
  });

  it('enables only the safe media retry path after preparation fails', () => {
    const failed = state({ mediaStatus: 'FAILED' });
    expect(actionAvailability('prepare', failed).enabled).toBe(false);
    expect(actionAvailability('retry-media', failed).enabled).toBe(true);
  });

  it('allows a failed content job to be retried without weakening approval', () => {
    expect(
      actionAvailability(
        'retry-content',
        state({ workflowStatus: 'FAILED', hasContent: false, hasSchedule: false }),
      ).enabled,
    ).toBe(true);
    expect(
      actionAvailability(
        'retry-content',
        state({ approvalStatus: 'PENDING', workflowStatus: 'FAILED' }),
      ).enabled,
    ).toBe(false);
  });
});
