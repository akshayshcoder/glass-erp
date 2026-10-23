import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Member, Role } from '../../api/types';
import { useAuth, useCan } from '../../app/auth';
import { useBranches } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';

/** What each role may do, in words the owner understands. */
export const ROLE_INFO: Record<Role, string> = {
  owner: 'Everything, including team and unlocking GST months',
  admin: 'Everything except managing owners',
  manager: 'Billing, purchases, returns, cancellations, stock',
  billing: 'Bills, quotations, receipts, customers',
  storekeeper: 'Products, stock and purchase entry',
  accountant: 'Read everything, lock GST months (for your CA)',
  viewer: 'Read only',
};
const ROLES = Object.keys(ROLE_INFO) as Role[];

export function TeamPage() {
  const { role: myRole, me } = useAuth();
  const canManage = useCan('manageTeam');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const { data: branches } = useBranches();
  const { data, isLoading, error } = useQuery({
    queryKey: ['members'],
    queryFn: () => api<{ items: Member[] }>('/v1/members').then((r) => r.items),
  });
  const branchName = (id: string) => branches?.find((b) => b.id === id)?.name ?? '?';

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="People who can sign in to this shop, and what they may do"
        actions={
          canManage && (
            <Button icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
              Add person
            </Button>
          )
        }
      />
      <Card>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <Table
            head={
              <>
                <Th>Name</Th>
                <Th>Phone / email</Th>
                <Th>Role</Th>
                <Th>Branches</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.map((m) => {
              const editable =
                canManage && m.userId !== me?.user.id && (m.role !== 'owner' || myRole === 'owner');
              return (
                <tr
                  key={m.id}
                  className={editable ? 'cursor-pointer hover:bg-slate-50' : ''}
                  onClick={() => editable && setEditing(m)}
                >
                  <Td className="font-medium text-slate-900">
                    {m.fullName} {m.userId === me?.user.id && <Badge>You</Badge>}
                  </Td>
                  <Td>{m.phone ?? m.email}</Td>
                  <Td>
                    <span className="capitalize">{m.role}</span>
                  </Td>
                  <Td>{m.branchIds ? m.branchIds.map(branchName).join(', ') : 'All'}</Td>
                  <Td>
                    {m.status === 'active' ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <Badge>Disabled</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <Card className="mt-6 p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Roles</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {ROLES.map((r) => (
            <div key={r}>
              <dt className="font-medium text-slate-900 capitalize">{r}</dt>
              <dd className="text-slate-500">{ROLE_INFO[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {(adding || editing) && (
        <MemberModal member={editing} onClose={() => (setAdding(false), setEditing(null))} />
      )}
    </>
  );
}

function MemberModal({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { role: myRole } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: branches } = useBranches();
  const [fullName, setFullName] = useState(member?.fullName ?? '');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(member?.role ?? 'billing');
  const [allBranches, setAllBranches] = useState(!member?.branchIds);
  const [branchIds, setBranchIds] = useState<string[]>(member?.branchIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = ROLES.filter((r) => r !== 'owner' || myRole === 'owner');

  async function save(e: FormEvent, status?: 'active' | 'disabled') {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const scope = { branchIds: allBranches ? null : branchIds };
    try {
      if (member) {
        await api(`/v1/members/${member.id}`, {
          method: 'PATCH',
          body: {
            version: member.version,
            role,
            ...(fullName.trim() && fullName.trim() !== member.fullName
              ? { fullName: fullName.trim() }
              : {}),
            ...(password ? { password } : {}),
            ...scope,
            ...(status && { status }),
          },
        });
      } else {
        await api('/v1/members', {
          method: 'POST',
          body: {
            fullName: fullName.trim(),
            login: login.trim(),
            password,
            role,
            ...scope,
          },
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      toast(member ? 'Saved' : 'Added to the shop');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={member ? member.fullName : 'Add team member'}
      footer={
        <>
          {member && (
            <Button
              variant={member.status === 'active' ? 'danger' : 'secondary'}
              className="mr-auto"
              onClick={(e) => void save(e, member.status === 'active' ? 'disabled' : 'active')}
            >
              {member.status === 'active' ? 'Remove access' : 'Restore access'}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="member-form"
        autoComplete="off"
        onSubmit={(e) => void save(e)}
        className="space-y-4"
      >
        {error && <ErrorBanner message={error} />}
        <Input
          label="Full name"
          name="member-full-name"
          autoComplete="off"
          required
          autoFocus={!member}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
        {!member && (
          <Input
            label="Phone or email (Login ID)"
            name="member-login-id"
            autoComplete="off"
            required
            placeholder="e.g. 9876543210 or staff@shop.com"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        )}
        <Input
          label={member ? 'Reset password (optional)' : 'Password'}
          name="member-new-password"
          type="password"
          autoComplete="new-password"
          required={!member}
          minLength={8}
          placeholder={member ? 'Leave blank to keep current password' : 'At least 8 characters'}
          hint={
            member
              ? 'Enter a new password only if you want to change it.'
              : 'At least 8 characters. Give this Login ID and password to the member.'
          }
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          hint={ROLE_INFO[role]}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </option>
          ))}
        </Select>
        {branches && branches.length > 1 && (
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 font-medium text-slate-700">Branches</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allBranches}
                onChange={(e) => setAllBranches(e.target.checked)}
              />{' '}
              All branches
            </label>
            {!allBranches &&
              branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 pl-5">
                  <input
                    type="checkbox"
                    checked={branchIds.includes(b.id)}
                    onChange={(e) =>
                      setBranchIds(
                        e.target.checked
                          ? [...branchIds, b.id]
                          : branchIds.filter((x) => x !== b.id),
                      )
                    }
                  />
                  {b.name}
                </label>
              ))}
          </fieldset>
        )}
      </form>
    </Modal>
  );
}
