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
