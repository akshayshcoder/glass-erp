import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, errorMessage } from '../../api/client';
import { useAuth } from '../../app/auth';
import { Button, ErrorBanner, Input } from '../../components/ui';

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-xl font-semibold text-brand-700">Glass ERP</p>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
          <p className="mt-1 mb-5 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signedIn') return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(login.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Use the login ID and password provided by your shop owner or admin."
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Input
          label="Phone or email"
          autoComplete="username"
          autoFocus
          required
          value={login}
          onChange={(e) => setLogin(e.target.value)}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', phone: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signedIn') return <Navigate to="/" replace />;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await register({
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        password: form.password,
      });
      navigate('/shops', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(err.fieldErrors);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Input
          label="Your name"
          autoFocus
          required
          value={form.fullName}
          onChange={set('fullName')}
          error={errors.fullName}
        />
        <Input
          label="Mobile number"
          inputMode="tel"
          autoComplete="tel"
          required
          value={form.phone}
          onChange={set('phone')}
          error={errors.phone}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters"
          value={form.password}
          onChange={set('password')}
          error={errors.password}
        />
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
