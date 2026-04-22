import { z } from "zod";

type ValidationSuccess<T> = {
  ok: true;
  data: T;
};

type ValidationFailure = {
  ok: false;
  response: Response;
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Parse a request body through Zod at the HTTP boundary.
 *
 * `request.json()` failures and schema failures are both client input errors,
 * so callers can return the bundled response instead of letting malformed JSON
 * bubble into a 500.
 */
export async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
): Promise<ValidationResult<z.infer<TSchema>>> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return validationFailure("Request body must be valid JSON.");
  }

  return parseUnknown(rawBody, schema);
}

/**
 * Validate already-parsed values such as route params and query strings.
 */
export function parseUnknown<TSchema extends z.ZodType>(
  value: unknown,
  schema: TSchema,
): ValidationResult<z.infer<TSchema>> {
  const result = schema.safeParse(value);

  if (!result.success) {
    return validationFailure("Invalid request.", result.error);
  }

  return {
    ok: true,
    data: result.data,
  };
}

function validationFailure(
  error: string,
  zodError?: z.ZodError,
): ValidationFailure {
  return {
    ok: false,
    response: Response.json(
      {
        error,
        ...(zodError ? { issues: formatIssues(zodError) } : {}),
      },
      { status: 400 },
    ),
  };
}

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}
