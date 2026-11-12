'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ApprovalControls({
  videoId,
  inputVersion,
}: {
  videoId: string;
  inputVersion: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function decide(decision: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({ videoId, decision, reason, expectedInputVersion: inputVersion }),
      });
      const result = (await response.json()) as { error?: string };
      setMessage(response.ok ? 'Decision saved' : (result.error ?? 'Decision failed'));
      if (response.ok) router.refresh();
    } catch {
      setMessage('Request unavailable. Refresh to check history before trying again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="approval-controls">
      <label htmlFor={`reason-${videoId}`}>Review reason (required for rejection or changes)</label>
      <textarea
        id={`reason-${videoId}`}
        value={reason}
        maxLength={1000}
        rows={3}
        onChange={(event) => setReason(event.target.value)}
        disabled={busy}
      />
      <div className="action-row">
        <button disabled={busy} onClick={() => void decide('APPROVED')}>
          Approve
        </button>
        <button disabled={busy || !reason.trim()} onClick={() => void decide('REJECTED')}>
          Reject
        </button>
        <button disabled={busy || !reason.trim()} onClick={() => void decide('CHANGES_REQUIRED')}>
          Request changes
        </button>
      </div>
      <p role="status">{busy ? 'Saving decision…' : message}</p>
    </div>
  );
}
