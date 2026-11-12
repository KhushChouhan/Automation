'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SchedulingControl({
  enabled,
  version,
  compact = false,
}: {
  enabled: boolean;
  version: number;
  compact?: boolean;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const nextEnabled = !enabled;
  async function update() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled,
          expectedVersion: version,
          ...(nextEnabled ? { confirmation } : {}),
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const result = (await response.json()) as { error?: string; selectionQueued?: boolean };
      setMessage(
        response.ok
          ? nextEnabled
            ? result.selectionQueued
              ? 'Enabled. Backlog scheduling queued.'
              : 'Enabled. The worker will schedule on its next cycle.'
            : 'Scheduling paused. Existing reservations are unchanged.'
          : (result.error ?? 'Update failed'),
      );
      if (response.ok) router.refresh();
    } catch {
      setMessage('Request unavailable. Refresh before trying again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={compact ? 'scheduling-control is-compact' : 'scheduling-control'}>
      {nextEnabled ? (
        <label>
          Type ENABLE SCHEDULING to confirm
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
          />
        </label>
      ) : null}
      <button
        type="button"
        disabled={busy || (nextEnabled && confirmation !== 'ENABLE SCHEDULING')}
        onClick={() => void update()}
      >
        {nextEnabled ? 'Enable automatic scheduling' : 'Pause automatic scheduling'}
      </button>
      <p role="status">{busy ? 'Saving…' : message}</p>
    </div>
  );
}
