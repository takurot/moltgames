import { isTerminalMatchStatus } from '@moltgames/domain';
import type { MatchStatus } from '@moltgames/domain';

const STATUS_STYLES: Record<MatchStatus, string> = {
  CREATED: 'bg-gray-100 text-gray-700',
  WAITING_AGENT_CONNECT: 'bg-yellow-100 text-yellow-800',
  READY: 'bg-blue-100 text-blue-800',
  IN_PROGRESS: 'bg-green-100 text-green-800',
  FINISHED: 'bg-indigo-100 text-indigo-800',
  ABORTED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-orange-100 text-orange-800',
  ARCHIVED: 'bg-gray-200 text-gray-600',
};

interface Props {
  status: MatchStatus;
}

export function MatchStatusBadge({ status }: Props) {
  const isTerminal = isTerminalMatchStatus(status);
  return (
    <span
      role="status"
      data-terminal={String(isTerminal)}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}
