import { AlertOutlined, ArrowUpOutlined, CheckCircleOutlined, HomeOutlined } from '@ant-design/icons';
import './TriageBadge.css';

const ICONS = { emergency: AlertOutlined, priority: ArrowUpOutlined, routine: CheckCircleOutlined, self_care: HomeOutlined };

// Level → colour + icon + word. Never colour alone.
export default function TriageBadge({ level, label }) {
  const Icon = ICONS[level] || CheckCircleOutlined;
  return (
    <span className={`triage-badge triage-badge--${level}`}>
      <Icon aria-hidden />
      {label}
    </span>
  );
}
