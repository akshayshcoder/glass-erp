import { z } from 'zod';
import { Email, NonEmpty, Phone } from '../http/validation.js';

const Password = z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters');

export const RegisterBody = z
  .object({
    fullName: NonEmpty,
    email: Email.optional(),
    phone: Phone.optional(),
    password: Password,
  })
  .refine((b) => b.email || b.phone, { message: 'Email or phone is required', path: ['phone'] });

export const LoginBody = z.object({
  /** Email address or phone number. */
  login: NonEmpty,
  password: z.string().min(1),
});

/** Browsers send nothing: the token comes from the httpOnly cookie instead. */
export const RefreshBody = z.object({ refreshToken: NonEmpty.optional() }).optional();

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
