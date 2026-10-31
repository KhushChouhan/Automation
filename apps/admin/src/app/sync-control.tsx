'use client';

import { useState } from 'react';

export function SyncControl({ ready }: { ready: boolean }) {
  const [state, setState] = useState('');
  const [running, setRunning] = useState(false);

  async function runSync() {
    setRunning(true);
    setState('Queueing sync…');
    try {
      const response = await fetch('/api/google/sync', { method: 'POST' });
      const body = (await response.json()) as { queued?: boolean; error?: string };
      setState(response.ok && body.queued ? 'Sync queued' : (body.error ?? 'Could not queue sync'));
    } catch {
      setState('Could not reach the API');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="sync-action">
      <button type="button" onClick={() => void runSync()} disabled={!ready || running}>
        {running ? 'Queueing…' : 'Run Sync'}
      </button>
      <span aria-live="polite">
        {state || (ready ? 'Google is configured' : 'Configure Google to enable sync')}
      </span>
    </div>
  );
}
