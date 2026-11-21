/** An error the API returns to the client as `{ message }` with this status. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, `${what} not found`);
export const forbidden = (message: string) => new ApiError(403, message);
export const conflict = (message: string) => new ApiError(409, message);
export const badRequest = (message: string) => new ApiError(400, message);

/**
 * A validation problem in plain words. Messages written in the route (“Give the team a name”) are
 * kept; zod's built-in ones (“Too small: expected string to have >=1 characters”) become “Fill in
 * the season”, “Season is too long” and so on, named after the field.
 */
export function plainIssue(i: { code: string; path: PropertyKey[]; message: string; minimum?: unknown; maximum?: unknown; origin?: string; input?: unknown }): string {
  const builtIn = /^(Too small|Too big|Invalid|Required|Expected|Unrecognized)/i.test(i.message);
  if (!builtIn) return i.message;
  const key = [...i.path].reverse().find((p) => typeof p === 'string') as string | undefined;
  const field = key ? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Id$/, '').toLowerCase().trim() : 'this';
  const Field = field.charAt(0).toUpperCase() + field.slice(1);
  if (i.code === 'too_small') return i.origin === 'string' && Number(i.minimum) <= 1 ? `Fill in the ${field}` : i.origin === 'string' ? `${Field} is too short` : i.origin === 'array' ? `Add at least ${String(i.minimum)} to ${field}` : `${Field} must be at least ${String(i.minimum)}`;
  if (i.code === 'too_big') return i.origin === 'string' ? `${Field} is too long (at most ${String(i.maximum)} characters)` : i.origin === 'array' ? `Too many in ${field} (at most ${String(i.maximum)})` : `${Field} must be at most ${String(i.maximum)}`;
  if (i.code === 'invalid_type') return i.input === undefined ? `Fill in the ${field}` : `Check the ${field}`;
  if (i.code === 'invalid_value' || i.code === 'invalid_format') return `Choose a valid ${field}`;
  return `Check the ${field}`;
}
