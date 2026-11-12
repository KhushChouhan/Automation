'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function VideoInputControls({
  videoId,
  currentTitle,
  currentFace,
}: {
  videoId: string;
  currentTitle: string | null;
  currentFace: string | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(currentTitle ?? '');
  const [face, setFace] = useState(currentFace ?? '');
  const [busy, setBusy] = useState<'title' | 'face' | null>(null);
  const [message, setMessage] = useState('');

  async function save(field: 'title' | 'face', value: string) {
    setBusy(field);
    setMessage('');
    try {
      const response = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId, field, value: value.trim() }),
        signal: AbortSignal.timeout(12_000),
      });
      const result = (await response.json()) as { error?: string };
      setMessage(
        response.ok
          ? `${field === 'face' ? 'Face' : 'Title'} saved. Approval reset to Pending.`
          : (result.error ?? 'Update failed'),
      );
      if (response.ok) router.refresh();
    } catch {
      setMessage('API unavailable. Refresh before trying again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="video-input-controls">
      <label>
        Title
        <input
          value={title}
          maxLength={500}
          placeholder="Enter the human-owned title"
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy !== null}
        />
      </label>
      <button
        type="button"
        disabled={busy !== null || !title.trim() || title.trim() === (currentTitle ?? '')}
        onClick={() => void save('title', title)}
      >
        {busy === 'title' ? 'Saving title…' : 'Save title'}
      </button>
      <label>
        Face name or ID
        <input
          value={face}
          maxLength={100}
          placeholder="Example: Meera"
          onChange={(event) => setFace(event.target.value)}
          disabled={busy !== null}
        />
      </label>
      <button
        type="button"
        disabled={busy !== null || !face.trim() || face.trim() === (currentFace ?? '')}
        onClick={() => void save('face', face)}
      >
        {busy === 'face' ? 'Saving face…' : 'Save face'}
      </button>
      <p role="status" className="control-message">
        {message}
      </p>
    </div>
  );
}
