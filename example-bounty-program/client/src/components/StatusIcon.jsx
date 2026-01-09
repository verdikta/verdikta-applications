/**
 * StatusIcon - Maps icon name strings to Lucide React icons
 * Used throughout the app to render consistent icons for status displays
 */

import {
  Clock,
  PartyPopper,
  Lock,
  Hourglass,
  Check,
  X,
  HelpCircle,
  AlertTriangle,
  RefreshCw,
  CircleDot,
} from 'lucide-react';
import { IconName } from '../utils/statusDisplay';

const ICON_MAP = {
  [IconName.CLOCK]: Clock,
  [IconName.PARTY]: PartyPopper,
  [IconName.LOCK]: Lock,
  [IconName.HOURGLASS]: Hourglass,
  [IconName.CHECK]: Check,
  [IconName.X]: X,
  [IconName.HELP]: HelpCircle,
  [IconName.ALERT]: AlertTriangle,
  [IconName.REFRESH]: RefreshCw,
};

/**
 * Render a status icon by name
 * @param {string} name - Icon name from IconName constants
 * @param {number} size - Icon size in pixels (default: 16)
 * @param {string} className - Additional CSS class
 */
export function StatusIcon({ name, size = 16, className = '' }) {
  const IconComponent = ICON_MAP[name];

  if (!IconComponent) {
    return <CircleDot size={size} className={className} />;
  }

  return <IconComponent size={size} className={className} />;
}

export default StatusIcon;
