'use client';

import { useState } from 'react';

const actions = [
  ['generate', 'Generate Content'],
  ['regenerate', 'Regenerate Content'],
  ['retry-content', 'Retry Content'],
  ['prepare', 'Prepare Media'],
  ['retry-media', 'Retry Media'],
] as const;

export function WorkflowControls({ videoId }: { videoId: string }) {
  const [running, setRunning] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  async function run(action: (typeof actions)[number][0]) {
    setRunning(action);
    setMessage('');
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId, action }),
      });
      const result = (await response.json()) as { queued?: boolean; error?: string };
      setMessage(response.ok && result.queued ? 'Queued' : (result.error ?? 'Request failed'));
    } catch {
      setMessage('API unavailable');
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="workflow-controls">
      <div>
        {actions.map(([action, label]) => (
          <button
            key={action}
            type="button"
            disabled={running !== null}
            onClick={() => void run(action)}
          >
            {running === action ? 'Queueing…' : label}
          </button>
        ))}
      </div>
      <span aria-live="polite">{message}</span>
    </div>
  );
}
