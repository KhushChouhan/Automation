import { describe, expect, it } from 'vitest';
import { normalizeGeneratedContent } from '../content.js';

describe('generated content validation', () => {
  it('normalizes and deduplicates hashtags without accepting empty output', () => {
    expect(
      normalizeGeneratedContent({
        caption: 'Jaipur location walkthrough.',
        hashtags: ['Jaipur', '#RealEstate', ' #jaipur '],
        cta: 'DM for verified details.',
      }),
    ).toEqual({
      caption: 'Jaipur location walkthrough.',
      hashtags: ['#Jaipur', '#RealEstate'],
      cta: 'DM for verified details.',
    });
    expect(() => normalizeGeneratedContent({ caption: 'x', hashtags: ['#'], cta: 'x' })).toThrow(
      'At least one',
    );
  });
});
