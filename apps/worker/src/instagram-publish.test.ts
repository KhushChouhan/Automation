import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@gcs/config';
import type { PrismaClient } from '@gcs/database';
import {
  instagramReelCapabilityMatrix,
  type InstagramPublisher,
  type MediaStorage,
} from '@gcs/integrations';

const persistence = vi.hoisted(() => ({
  claimScheduledPublish: vi.fn(),
  markContainerRequested: vi.fn(),
  markPublishContainerProcessing: vi.fn(),
  markPublishRequested: vi.fn(),
  notePublishReconciliationCheck: vi.fn(),
  persistPublishMediaId: vi.fn(),
  recordPublishContainer: vi.fn(),
  recordSuccessfulPost: vi.fn(),
  requirePublishReconciliation: vi.fn(),
}));

vi.mock('@gcs/database', () => ({
  ...persistence,
  beginContentGeneration: vi.fn(),
  beginMediaPreparation: vi.fn(),
  completeContentGeneration: vi.fn(),
  completeMediaPreparation: vi.fn(),
  failMediaPreparation: vi.fn(),
  markContentScheduled: vi.fn(),
  markMediaCleaned: vi.fn(),
  recordContentGenerationFailure: vi.fn(),
}));
vi.mock('./phase3.js', () => ({ createMediaStorage: vi.fn() }));

import { createInstagramPublishProcessors } from './instagram-publish.js';

type PublishJob = Parameters<ReturnType<typeof createInstagramPublishProcessors>['publish']>[0];

const scheduleId = 'schedule-test-1';
const attemptId = 'attempt-test-1';
const videoId = 'GCS-0099';
const containerId = 'fake-container-1';
const acceptedMediaId = 'fake-meta-media-1';

interface OrchestrationState {
  claim: 'NEW' | 'RECONCILE_REQUIRED' | 'POSTED';
  containerId: string | null;
  mediaId: string | null;
  acceptedByFakeMeta: boolean;
  recordedPosts: number;
}

function config(publishingEnabled: boolean) {
  return loadConfig({
    NODE_ENV: 'test',
    INSTAGRAM_PUBLISHING_ENABLED: publishingEnabled ? 'true' : 'false',
    META_ACCESS_TOKEN: 'fake-token-never-sent',
    INSTAGRAM_ACCOUNT_ID: '12345678901',
  });
}

function fakePublisher(state: OrchestrationState) {
  const capability = {
    configured: true,
    authenticated: true,
    accountAccessible: true,
    publishingPermission: true,
    tokenExpiresAt: null,
    graphApiVersion: 'v25.0',
    publishingEnabled: true,
    authPath: 'INSTAGRAM_LOGIN' as const,
    account: { id: '12345678901', username: 'fake-account', accountType: 'BUSINESS' as const },
    configuredAccountMatches: true,
    permissions: [
      { permission: 'instagram_business_basic' as const, state: 'GRANTED' as const },
      { permission: 'instagram_business_content_publish' as const, state: 'GRANTED' as const },
    ],
    tokenExpiry: { state: 'UNKNOWN' as const, expiresAt: null },
    capabilities: instagramReelCapabilityMatrix,
  };
  const getContainerStatus = vi.fn<InstagramPublisher['getContainerStatus']>(() =>
    Promise.resolve({ containerId, status: 'FINISHED' }),
  );
  const publisher = {
    validateConfiguration: () => capability,
    validateToken: vi.fn(() => Promise.resolve(capability.account)),
    getAuthenticatedInstagramAccount: vi.fn(() => Promise.resolve(capability.account)),
    verifyConfiguredAccountId: vi.fn(() => Promise.resolve(true)),
    checkRequiredPermissions: vi.fn(() => Promise.resolve(capability.permissions)),
    checkTokenExpiry: vi.fn(() => Promise.resolve(capability.tokenExpiry)),
    checkPublishingCapability: vi.fn(() => Promise.resolve(capability)),
    checkPublishingLimit: vi.fn(() =>
      Promise.resolve({ supported: true, allowed: true, quotaUsage: 0, quotaTotal: 100 }),
    ),
    createReelContainer: vi.fn(() => Promise.resolve({ containerId })),
    getContainerStatus,
    publishContainer: vi.fn(() => {
      state.acceptedByFakeMeta = true;
      return Promise.reject(new Error('simulated timeout after fake Meta accepted media'));
    }),
    getPublishedMedia: vi.fn(() =>
      Promise.resolve({ mediaId: acceptedMediaId, permalink: 'https://fake.invalid/reel/1' }),
    ),
    reconcilePublish: vi.fn(() =>
      Promise.resolve(
        state.acceptedByFakeMeta
          ? { mediaId: acceptedMediaId, permalink: 'https://fake.invalid/reel/1' }
          : null,
      ),
    ),
  } satisfies InstagramPublisher;
  return publisher;
}

function mockDatabase(state: OrchestrationState) {
  const database = {
    schedule: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          id: scheduleId,
          scheduledAt: new Date('2026-10-28T13:30:00.000Z'),
          video: {
            id: 'video-row-1',
            videoId,
            manualActionReason: 'READY_FOR_PUBLISH_META_DISABLED',
          },
        }),
      ),
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          id: scheduleId,
          videoId: 'video-row-1',
          mediaAsset: {
            videoObjectKey: 'videos/gcs-0099.mp4',
            expiresAt: new Date('2020-01-01T00:00:00.000Z'),
          },
          video: {
            videoId,
            content: [{ caption: 'A verified test caption', hashtags: ['#test'] }],
          },
        }),
      ),
    },
    publishAttempt: {
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          id: attemptId,
          scheduleId,
          containerId: state.containerId,
          mediaId: state.mediaId,
          schedule: { video: { videoId } },
        }),
      ),
    },
  };
  return database as unknown as PrismaClient;
}

function fakeStorage() {
  return {
    provider: 'fake',
    upload: vi.fn(),
    head: vi.fn(() =>
      Promise.resolve({
        key: 'videos/gcs-0099.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      }),
    ),
    createReadUrl: vi.fn(() =>
      Promise.resolve({
        url: 'https://fake.invalid/video.mp4',
        expiresAt: new Date('2026-10-28T16:00:00.000Z'),
      }),
    ),
    delete: vi.fn(),
  } satisfies MediaStorage;
}

function job(data: Record<string, unknown>, id = 'job-delivery-1'): PublishJob {
  return { id, data } as PublishJob;
}

function configureClaimLifecycle(state: OrchestrationState, existingContainer = false) {
  persistence.claimScheduledPublish.mockImplementation(() => {
    if (state.claim === 'POSTED')
      return Promise.resolve({ kind: 'POSTED', attempt: { id: attemptId } });
    if (state.claim === 'RECONCILE_REQUIRED')
      return Promise.resolve({
        kind: 'RECONCILE_REQUIRED',
        attempt: { id: attemptId, containerId: state.containerId, mediaId: state.mediaId },
      });
    return Promise.resolve({
      kind: 'CLAIMED',
      attempt: {
        id: attemptId,
        containerId: existingContainer ? state.containerId : null,
        mediaId: state.mediaId,
      },
      leaseToken: 'lease-test-1',
    });
  });
  persistence.recordPublishContainer.mockImplementation(() => {
    state.containerId = containerId;
    return Promise.resolve({ id: attemptId, containerId });
  });
  persistence.markContainerRequested.mockResolvedValue({
    shouldSend: true,
    attempt: { id: attemptId, containerRequestedAt: new Date() },
  });
  persistence.markPublishContainerProcessing.mockResolvedValue({ id: attemptId });
  persistence.markPublishRequested.mockResolvedValue({
    shouldSend: true,
    attempt: { id: attemptId, containerId, status: 'PUBLISH_REQUESTED' },
  });
  persistence.requirePublishReconciliation.mockImplementation(() => {
    state.claim = 'RECONCILE_REQUIRED';
    return Promise.resolve({ id: attemptId });
  });
  persistence.notePublishReconciliationCheck.mockResolvedValue({ id: attemptId });
  persistence.recordSuccessfulPost.mockImplementation(() => {
    state.claim = 'POSTED';
    state.recordedPosts += 1;
    return Promise.resolve({ id: 'posting-history-1', instagramMediaId: acceptedMediaId });
  });
}

describe('Instagram worker publish orchestration contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('makes no publisher or claim calls while publishing is disabled', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    const publisher = fakePublisher(state);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(false), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      skipped: true,
      reason: 'Meta publishing is disabled',
      metaRequests: 0,
    });
    expect(persistence.claimScheduledPublish).not.toHaveBeenCalled();
    expect(publisher.createReelContainer).not.toHaveBeenCalled();
    expect(publisher.getContainerStatus).not.toHaveBeenCalled();
    expect(publisher.publishContainer).not.toHaveBeenCalled();
    expect(publisher.reconcilePublish).not.toHaveBeenCalled();
  });

  it('reconciles a timed-out fake publish on duplicate delivery without publishing twice', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    const publisher = fakePublisher(state);
    const database = mockDatabase(state);
    const storage = fakeStorage();

    persistence.claimScheduledPublish.mockImplementation(() => {
      if (state.claim === 'POSTED')
        return Promise.resolve({ kind: 'POSTED', attempt: { id: attemptId } });
      if (state.claim === 'RECONCILE_REQUIRED')
        return Promise.resolve({
          kind: 'RECONCILE_REQUIRED',
          attempt: { id: attemptId, containerId: state.containerId, mediaId: state.mediaId },
        });
      return Promise.resolve({
        kind: 'CLAIMED',
        attempt: { id: attemptId, containerId: null, mediaId: null },
        leaseToken: 'lease-test-1',
      });
    });
    persistence.recordPublishContainer.mockImplementation(() => {
      state.containerId = containerId;
      return Promise.resolve({ id: attemptId, containerId });
    });
    persistence.markContainerRequested.mockResolvedValue({
      shouldSend: true,
      attempt: { id: attemptId, containerRequestedAt: new Date() },
    });
    persistence.markPublishContainerProcessing.mockResolvedValue({ id: attemptId });
    persistence.markPublishRequested.mockResolvedValue({
      shouldSend: true,
      attempt: { id: attemptId, containerId, status: 'PUBLISH_REQUESTED' },
    });
    persistence.requirePublishReconciliation.mockImplementation(() => {
      state.claim = 'RECONCILE_REQUIRED';
      return Promise.resolve({ id: attemptId });
    });
    persistence.notePublishReconciliationCheck.mockResolvedValue({ id: attemptId });
    persistence.recordSuccessfulPost.mockImplementation(() => {
      state.claim = 'POSTED';
      state.recordedPosts += 1;
      return Promise.resolve({ id: 'posting-history-1', instagramMediaId: acceptedMediaId });
    });

    const processor = createInstagramPublishProcessors(database, config(true), {
      publisher,
      storage,
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/simulated timeout/);
    expect(state.claim).toBe('RECONCILE_REQUIRED');
    expect(persistence.markPublishRequested).toHaveBeenCalledTimes(1);
    expect(persistence.requirePublishReconciliation).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ reason: 'NETWORK_OR_TIMEOUT', attemptId }),
    );

    // BullMQ redelivers the same logical job. Durable state routes it to reconcile.
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    // A further duplicate after completion is a no-op.
    await expect(processor.publish(job({ scheduleId }))).resolves.toMatchObject({ skipped: true });

    expect(storage.createReadUrl).toHaveBeenCalledTimes(1);
    expect(storage.head).toHaveBeenCalledWith('videos/gcs-0099.mp4');
    expect(persistence.markContainerRequested).toHaveBeenCalledTimes(1);
    expect(publisher.createReelContainer).toHaveBeenCalledTimes(1);
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
    expect(publisher.reconcilePublish).toHaveBeenCalledTimes(1);
    expect(persistence.recordSuccessfulPost).toHaveBeenCalledTimes(1);
    expect(state.recordedPosts).toBe(1);
  });

  it('completes a fake publish successfully and turns duplicate deliveries into no-ops', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    const publisher = fakePublisher(state);
    publisher.publishContainer.mockImplementation(() => {
      state.acceptedByFakeMeta = true;
      return Promise.resolve({ mediaId: acceptedMediaId }) as never;
    });
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    await expect(processor.publish(job({ scheduleId }))).resolves.toMatchObject({ skipped: true });
    await expect(processor.publish(job({ scheduleId }, 'manual-retry-job'))).resolves.toMatchObject(
      {
        skipped: true,
      },
    );

    expect(publisher.createReelContainer).toHaveBeenCalledTimes(1);
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
    expect(publisher.reconcilePublish).not.toHaveBeenCalled();
    expect(persistence.recordSuccessfulPost).toHaveBeenCalledTimes(1);
    expect(state.recordedPosts).toBe(1);
  });

  it('creates a fresh just-in-time URL for READY media with a stale persisted expiry', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    persistence.claimScheduledPublish
      .mockResolvedValueOnce({
        kind: 'CLAIMED',
        attempt: { id: attemptId, containerId: null, mediaId: null },
        leaseToken: 'lease-test-1',
      })
      .mockResolvedValueOnce({ kind: 'BUSY', attempt: { id: attemptId } });
    const publisher = fakePublisher(state);
    publisher.getContainerStatus.mockResolvedValue({ containerId, status: 'IN_PROGRESS' });
    const database = mockDatabase(state);
    const storage = fakeStorage();
    const freshExpiry = new Date(Date.now() + 2 * 60 * 60_000);
    storage.createReadUrl.mockResolvedValue({
      url: 'https://fake.invalid/jit-video.mp4?signature=fake-fresh',
      expiresAt: freshExpiry,
    });
    const configWithTtl = loadConfig({
      NODE_ENV: 'test',
      INSTAGRAM_PUBLISHING_ENABLED: 'true',
      META_ACCESS_TOKEN: 'fake-token-never-sent',
      INSTAGRAM_ACCOUNT_ID: '12345678901',
      META_DELIVERY_URL_TTL_SECONDS: '3600',
    });
    const processor = createInstagramPublishProcessors(database, configWithTtl, {
      publisher,
      storage,
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      waiting: true,
      containerId,
    });
    await expect(
      processor.publish(job({ scheduleId }, 'duplicate-jit-job')),
    ).resolves.toMatchObject({ skipped: true });

    expect(vi.mocked(storage.createReadUrl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.createReadUrl)).toHaveBeenCalledWith('videos/gcs-0099.mp4', 3600);
    expect(publisher.createReelContainer).toHaveBeenCalledWith({
      videoUrl: 'https://fake.invalid/jit-video.mp4?signature=fake-fresh',
      caption: 'A verified test caption\n\n#test',
    });
    expect(publisher.createReelContainer).toHaveBeenCalledTimes(1);
    expect(publisher.publishContainer).not.toHaveBeenCalled();
  });

  it('does not request a container if fresh URL creation fails and safely resumes later', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    persistence.claimScheduledPublish
      .mockResolvedValueOnce({
        kind: 'CLAIMED',
        attempt: { id: attemptId, containerId: null, mediaId: null },
        leaseToken: 'lease-test-1',
      })
      .mockResolvedValueOnce({ kind: 'BUSY', attempt: { id: attemptId } })
      .mockResolvedValueOnce({
        kind: 'RESUMED',
        attempt: { id: attemptId, containerId: null, mediaId: null },
        leaseToken: 'lease-test-2',
      });
    const publisher = fakePublisher(state);
    publisher.getContainerStatus.mockResolvedValue({ containerId, status: 'IN_PROGRESS' });
    const storage = fakeStorage();
    storage.createReadUrl
      .mockRejectedValueOnce(new Error('simulated signer crash'))
      .mockResolvedValueOnce({
        url: 'https://fake.invalid/retried-jit-video.mp4?signature=fake-fresh',
        expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
      });
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage,
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/signer crash/);
    expect(persistence.markContainerRequested).not.toHaveBeenCalled();
    expect(persistence.requirePublishReconciliation).not.toHaveBeenCalled();
    expect(publisher.createReelContainer).not.toHaveBeenCalled();
    expect(publisher.publishContainer).not.toHaveBeenCalled();

    await expect(processor.publish(job({ scheduleId }, 'duplicate-during-lease'))).resolves.toEqual(
      {
        skipped: true,
        reason: 'Schedule is leased by another worker',
        metaRequests: 0,
      },
    );
    expect(storage.createReadUrl).toHaveBeenCalledTimes(1);
    await expect(processor.publish(job({ scheduleId }, 'retry-after-lease'))).resolves.toEqual({
      waiting: true,
      containerId,
    });

    expect(storage.createReadUrl).toHaveBeenCalledTimes(2);
    expect(persistence.markContainerRequested).toHaveBeenCalledTimes(1);
    expect(publisher.createReelContainer).toHaveBeenCalledTimes(1);
    expect(publisher.publishContainer).not.toHaveBeenCalled();
  });

  it('reuses an existing container after an IN_PROGRESS response', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state, true);
    const publisher = fakePublisher(state);
    publisher.getContainerStatus
      .mockResolvedValueOnce({ containerId, status: 'IN_PROGRESS' } as never)
      .mockResolvedValueOnce({ containerId, status: 'FINISHED' });
    publisher.publishContainer.mockResolvedValue({ mediaId: acceptedMediaId } as never);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      waiting: true,
      containerId,
    });
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    expect(publisher.createReelContainer).not.toHaveBeenCalled();
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
  });

  it('never creates another container after a lost response to the first create request', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    const publisher = fakePublisher(state);
    publisher.createReelContainer.mockRejectedValue(
      new Error('simulated network timeout while creating fake container'),
    );
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/timeout/);
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      reconciling: true,
      attemptId,
    });
    expect(persistence.requirePublishReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId,
        reason: 'CONTAINER_CREATE_OUTCOME_UNCERTAIN',
      }),
    );
    expect(publisher.createReelContainer).toHaveBeenCalledTimes(1);
    expect(publisher.publishContainer).not.toHaveBeenCalled();
  });

  it('does not repeat container creation when a durable request marker says the outcome is uncertain', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    persistence.markContainerRequested.mockResolvedValueOnce({
      shouldSend: false,
      attempt: { id: attemptId, containerRequestedAt: new Date() },
    });
    const publisher = fakePublisher(state);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      reconciling: true,
      attemptId,
    });
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      reconciling: true,
      attemptId,
    });
    expect(publisher.createReelContainer).not.toHaveBeenCalled();
    expect(publisher.publishContainer).not.toHaveBeenCalled();
  });

  it('holds a container with a terminal provider error for reconciliation', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    const publisher = fakePublisher(state);
    publisher.getContainerStatus.mockResolvedValue({
      containerId,
      status: 'ERROR',
      errorMessage: 'simulated invalid media',
    });
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      reconciling: true,
      attemptId,
    });
    expect(persistence.requirePublishReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId, reason: 'CONTAINER_NOT_READY' }),
    );
    expect(publisher.publishContainer).not.toHaveBeenCalled();
  });

  it.each([
    ['rate limit', new Error('fake provider rate limit'), 'UNKNOWN_PROVIDER_ERROR'],
    ['permission', new Error('fake provider permission denied'), 'UNKNOWN_PROVIDER_ERROR'],
    ['expired token', new Error('fake provider token expired'), 'UNKNOWN_PROVIDER_ERROR'],
    [
      'publishing limit',
      new Error('fake provider publishing limit reached'),
      'UNKNOWN_PROVIDER_ERROR',
    ],
    ['invalid media', new Error('fake provider rejected invalid media'), 'UNKNOWN_PROVIDER_ERROR'],
    ['network loss', new Error('fake network connection reset'), 'NETWORK_OR_TIMEOUT'],
    [
      'transient provider failure',
      new Error('fake provider temporarily unavailable'),
      'UNKNOWN_PROVIDER_ERROR',
    ],
  ])(
    'reconciles after a %s during publish without issuing a second publish',
    async (_label, error, reason) => {
      const state: OrchestrationState = {
        claim: 'NEW',
        containerId: null,
        mediaId: null,
        acceptedByFakeMeta: false,
        recordedPosts: 0,
      };
      configureClaimLifecycle(state);
      const publisher = fakePublisher(state);
      publisher.publishContainer.mockRejectedValue(error);
      publisher.reconcilePublish.mockResolvedValue(null);
      const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
        publisher,
        storage: fakeStorage(),
      });

      await expect(processor.publish(job({ scheduleId }))).rejects.toThrow();
      await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
        reconciling: true,
        attemptId,
      });

      expect(persistence.requirePublishReconciliation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ attemptId, reason }),
      );
      expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
      expect(publisher.reconcilePublish).toHaveBeenCalledTimes(1);
      expect(persistence.recordSuccessfulPost).not.toHaveBeenCalled();
    },
  );

  it('reconciles when media-ID persistence crashes after provider acceptance', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: true,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    persistence.persistPublishMediaId.mockRejectedValueOnce(new Error('simulated worker crash'));
    const publisher = fakePublisher(state);
    publisher.publishContainer.mockResolvedValue({ mediaId: acceptedMediaId } as never);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/worker crash/);
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
    expect(publisher.reconcilePublish).toHaveBeenCalledTimes(1);
    expect(persistence.recordSuccessfulPost).toHaveBeenCalledTimes(1);
  });

  it('reconciles after publish succeeds but published-media lookup crashes', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: acceptedMediaId,
      acceptedByFakeMeta: true,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    const publisher = fakePublisher(state);
    publisher.publishContainer.mockResolvedValue({ mediaId: acceptedMediaId } as never);
    publisher.getPublishedMedia.mockRejectedValueOnce(new Error('simulated media lookup crash'));
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/media lookup crash/);
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
    expect(publisher.reconcilePublish).toHaveBeenCalledTimes(1);
    expect(persistence.recordSuccessfulPost).toHaveBeenCalledTimes(1);
  });

  it('skips a concurrent duplicate claimed by another worker', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: false,
      recordedPosts: 0,
    };
    persistence.claimScheduledPublish.mockResolvedValue({
      kind: 'BUSY',
      attempt: { id: attemptId },
    });
    const publisher = fakePublisher(state);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).resolves.toMatchObject({ skipped: true });
    expect(publisher.createReelContainer).not.toHaveBeenCalled();
    expect(publisher.publishContainer).not.toHaveBeenCalled();
    expect(persistence.recordSuccessfulPost).not.toHaveBeenCalled();
  });

  it('reconciles a committed PostingHistory success after the worker loses its acknowledgment', async () => {
    const state: OrchestrationState = {
      claim: 'NEW',
      containerId: null,
      mediaId: null,
      acceptedByFakeMeta: true,
      recordedPosts: 0,
    };
    configureClaimLifecycle(state);
    persistence.recordSuccessfulPost.mockImplementationOnce(() => {
      state.claim = 'POSTED';
      state.recordedPosts += 1;
      return Promise.reject(new Error('simulated acknowledgment loss after commit'));
    });
    const publisher = fakePublisher(state);
    publisher.publishContainer.mockResolvedValue({ mediaId: acceptedMediaId } as never);
    const processor = createInstagramPublishProcessors(mockDatabase(state), config(true), {
      publisher,
      storage: fakeStorage(),
    });

    await expect(processor.publish(job({ scheduleId }))).rejects.toThrow(/acknowledgment loss/);
    await expect(processor.publish(job({ scheduleId }))).resolves.toEqual({
      posted: true,
      mediaId: acceptedMediaId,
    });
    await expect(processor.publish(job({ scheduleId }))).resolves.toMatchObject({ skipped: true });
    expect(publisher.publishContainer).toHaveBeenCalledTimes(1);
    expect(publisher.reconcilePublish).toHaveBeenCalledTimes(1);
    expect(persistence.recordSuccessfulPost).toHaveBeenCalledTimes(2);
  });
});
