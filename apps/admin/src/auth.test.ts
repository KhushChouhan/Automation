import { describe, expect, it } from 'vitest';
import { dashboardAuthenticated } from './auth';

describe('dashboard authentication', () => {
  const env = { DASHBOARD_USERNAME: 'reviewer', DASHBOARD_PASSWORD: 'browser-only-password' };
  it('fails closed without configured access and rejects malformed credentials', () => {
    expect(dashboardAuthenticated(null, env)).toBe(false);
    expect(dashboardAuthenticated('Basic !!!', env)).toBe(false);
    expect(dashboardAuthenticated(`Basic ${btoa('reviewer:browser-only-password')}`, {})).toBe(
      false,
    );
    expect(dashboardAuthenticated(`Bearer server-api-token`, env)).toBe(false);
  });
  it('accepts only the separate dashboard credentials', () => {
    expect(dashboardAuthenticated(`Basic ${btoa('reviewer:browser-only-password')}`, env)).toBe(
      true,
    );
    expect(dashboardAuthenticated(`Basic ${btoa('reviewer:browser-only-password!')}`, env)).toBe(
      false,
    );
    expect(dashboardAuthenticated(`Basic ${btoa('admin:browser-only-password')}`, env)).toBe(false);
  });
});
