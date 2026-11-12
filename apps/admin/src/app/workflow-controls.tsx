'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  actionAvailability,
  type WorkflowAction,
  type WorkflowControlState,
} from './workflow-control-state';

const actions = [
  ['generate', 'Generate Content'],
  ['regenerate', 'Regenerate Content'],
  ['retry-content', 'Retry Content'],
  ['prepare', 'Prepare Media'],
  ['retry-media', 'Retry Media'],
] as const;

export function WorkflowControls(props: WorkflowControlState) {
  const router = useRouter();
  const [running, setRunning] = useState<WorkflowAction | null>(null);
  const [message, setMessage] = useState('');

  async function run(action: WorkflowAction) {
    setRunning(action);
    setMessage('');
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: props.videoId, action }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = (await response.json()) as { queued?: boolean; error?: string };
      if (response.ok && result.queued) {
        setMessage(`${actions.find(([name]) => name === action)?.[1] ?? 'Operation'} queued.`);
        setTimeout(() => router.refresh(), 2_500);
      } else {
        setMessage(result.error ?? 'Request failed');
      }
    } catch {
      setMessage('API unavailable');
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="workflow-controls">
      <div>
        {actions.map(([action, label]) => {
          const availability = actionAvailability(action, props);
          return (
            <button
              key={action}
              type="button"
              disabled={running !== null || !availability.enabled}
              title={availability.reason || label}
              onClick={() => void run(action)}
            >
              {running === action ? 'Queueing…' : label}
            </button>
          );
        })}
      </div>
      <span aria-live="polite" className="control-message">
        {message}
      </span>
    </div>
  );
}
