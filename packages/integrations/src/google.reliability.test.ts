import { describe, expect, it, vi } from 'vitest';
import { GoogleIntegrationError, withGoogleRetry } from './index.js';

describe('Google retry reliability', () => {
  it('retries 429 rate limits with capped, deterministic backoff', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue('done');
    const sleep = vi.fn((milliseconds: number) => {
      void milliseconds;
      return Promise.resolve();
    });

    await expect(
      withGoogleRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 12,
        random: () => 1,
        sleep,
      }),
    ).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10, 12]);
  });

  it('does not retry authorization failures or expose provider payloads', async () => {
    const secretDetail = 'private provider body';
    const operation = vi.fn().mockRejectedValue({
      response: { status: 401, data: { error: { message: secretDetail } } },
    });
    const sleep = vi.fn((milliseconds: number) => {
      void milliseconds;
      return Promise.resolve();
    });

    await expect(withGoogleRetry(operation, { maxAttempts: 8, sleep })).rejects.toMatchObject({
      code: 'AUTH',
      message: 'Google authorization failed',
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops repeated transient failures at the configured attempt bound', async () => {
    const operation = vi.fn().mockRejectedValue({ response: { status: 503 } });
    const sleep = vi.fn((milliseconds: number) => {
      void milliseconds;
      return Promise.resolve();
    });

    await expect(withGoogleRetry(operation, { maxAttempts: 3, sleep })).rejects.toBeInstanceOf(
      GoogleIntegrationError,
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
