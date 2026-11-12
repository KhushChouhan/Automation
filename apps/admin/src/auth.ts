export function dashboardAuthenticated(
  authorization: string | null,
  env: Record<string, string | undefined>,
): boolean {
  const password = env['DASHBOARD_PASSWORD'];
  // Keep dashboard credentials server-only; production access requires the configured password.
  const username = env['DASHBOARD_USERNAME'] || 'admin';
  if (!password || !authorization?.startsWith('Basic ')) return false;
  let supplied: string;
  try {
    supplied = atob(authorization.slice(6));
  } catch {
    return false;
  }
  const expected = `${username}:${password}`;
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < Math.max(supplied.length, expected.length); index++) {
    difference |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}
