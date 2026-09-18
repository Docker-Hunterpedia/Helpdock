import { z } from 'zod';

/**
 * The form's own schema. It stops at the shape a human can get wrong; the
 * credentials themselves are only ever judged by the api (`invalid-credentials`
 * comes back as one error for both fields, never "no such user").
 */
const emailSchema = z.email();

export const signInFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((value) => emailSchema.safeParse(value).success, 'invalid'),
  password: z.string().min(1, 'required'),
});

export type FieldIssue = 'required' | 'invalid';
export type SignInFormErrors = Partial<Record<'email' | 'password', FieldIssue>>;

const isFieldIssue = (message: string): message is FieldIssue =>
  message === 'required' || message === 'invalid';

/** Empty when the form may be submitted. First issue per field wins. */
export function validateSignInForm(values: {
  readonly email: string;
  readonly password: string;
}): SignInFormErrors {
  const result = signInFormSchema.safeParse(values);
  if (result.success) {
    return {};
  }

  const errors: SignInFormErrors = {};
  for (const issue of result.error.issues) {
    const [field] = issue.path;
    if (
      (field === 'email' || field === 'password') &&
      !(field in errors) &&
      isFieldIssue(issue.message)
    ) {
      errors[field] = issue.message;
    }
  }

  return errors;
}

/** The magic link only needs somewhere to send it. */
export function validateEmail(email: string): FieldIssue | undefined {
  return validateSignInForm({ email, password: 'ignored' }).email;
}
