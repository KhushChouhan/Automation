'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export function MetaStatusControl() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="meta-refresh"
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? 'Refreshing…' : 'Refresh configuration status'}
    </button>
  );
}
